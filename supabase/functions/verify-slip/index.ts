// supabase/functions/verify-slip/index.ts
// Deploy with verify_jwt=false: LINE ID tokens are authenticated with LINE on the server.
// Secrets: THUNDER_API_KEY, LINE_CHANNEL_ID_PLAYER, LINE_CHANNEL_ID_ADMIN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "npm:@supabase/supabase-js@2";
const MAX_SIZE = 4_194_304;
const MIME = new Set(["image/png","image/jpeg","image/gif","image/webp"]);
const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("WEB_ORIGIN") ?? "https://homefriendmassage-boop.github.io",
  "Access-Control-Allow-Headers": "content-type, x-client-info, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
function fail(code: string, status = 400) { return json({ ok:false, code }, status); }
function safeText(v: unknown, max = 128) { return typeof v === "string" ? v.slice(0,max) : ""; }
function client() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}
async function verifyLine(idToken: string, action: string) {
  const channelId = Deno.env.get(action === "list" ? "LINE_CHANNEL_ID_ADMIN" : "LINE_CHANNEL_ID_PLAYER");
  if (!channelId || !idToken) return null;
  const params = new URLSearchParams({id_token:idToken,client_id:channelId});
  const result = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params
  });
  if (!result.ok) return null;
  const profile = await result.json();
  return profile.aud === channelId && profile.sub && profile.exp*1000 > Date.now() ? String(profile.sub) : null;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null,{headers:CORS});
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED",405);
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    return fail("UNSUPPORTED_CONTENT_TYPE",415);
  }
  if (!Deno.env.get("THUNDER_API_KEY")) return fail("THUNDER_NOT_CONFIGURED",503);
  const auth = req.headers.get("Authorization")?.replace(/^Bearer\s+/i,"") || "";
  try {
    let body: FormData;
    try {
      body = await req.formData();
    } catch {
      return fail("INVALID_FORM_DATA",400);
    }
    const action = safeText(body.get("action"));
    if (!["verify","list"].includes(action)) return fail("ACTION_INVALID");
    const uid = await verifyLine(auth,action);
    if (!uid) return fail("LINE_AUTH_INVALID",401);
    const shopId = safeText(body.get("shop_id"));
    if (!shopId) return fail("SHOP_REQUIRED");
    const db = client();
    const {data:user,error:userError} = await db.from("users").select("uid,shop_id,role,status")
      .eq("uid",uid).eq("shop_id",shopId).maybeSingle();
    if (userError || !user || user.status !== "Active") return fail("ACCESS_DENIED",403);
    if (action === "list") {
      if (!["Admin","Superadmin","Operator"].includes(user.role)) return fail("ADMIN_REQUIRED",403);
      const {data,error}=await db.from("slip_verifications")
        .select("id,uid,shop_id,storage_path,claimed_amount,slip_amount,transaction_ref,receiver_matched,is_duplicate,status,error_code,created_at")
        .eq("shop_id",shopId).order("created_at",{ascending:false}).limit(50);
      if (error) return fail("DATABASE_ERROR",500);
      const entries=[];
      for (const entry of data??[]) {
        let image_url=null;
        if (entry.storage_path) {
          const signed=await db.storage.from("slips-private").createSignedUrl(entry.storage_path,120);
          image_url=signed.data?.signedUrl??null;
        }
        entries.push({...entry,image_url,storage_path:undefined});
      }
      return json({ok:true,entries});
    }
    if (action !== "verify") return fail("ACTION_INVALID");
    const file = body.get("image");
    const amount = Number(body.get("amount"));
    if (!(file instanceof File) || !MIME.has(file.type) || !file.size || file.size>MAX_SIZE) return fail("IMAGE_INVALID");
    if (!Number.isFinite(amount)||amount<=0||Math.round(amount*100)!==amount*100) return fail("AMOUNT_INVALID");
    const refId=crypto.randomUUID();
    const ext=({ "image/jpeg":"jpg","image/png":"png","image/gif":"gif","image/webp":"webp" } as Record<string,string>)[file.type];
    const storagePath=shopId+"/"+uid+"/"+refId+"."+ext;
    const {error:uploadError}=await db.storage.from("slips-private").upload(storagePath,file,{contentType:file.type,upsert:false});
    if(uploadError) return fail("STORAGE_ERROR",500);
    const {error:insertError}=await db.from("slip_verifications").insert({
      id:refId,shop_id:shopId,uid,storage_path:storagePath,claimed_amount:amount,status:"Verifying"
    });
    if(insertError) return fail("DATABASE_ERROR",500);
    const form=new FormData();
    form.append("image",file,file.name || "slip."+ext);
    form.append("matchAmount",String(amount));
    form.append("checkDuplicate","true");
    // Receiver matching requires merchant bank accounts registered in Thunder.
    form.append("matchAccount","true");
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    let payload: any;
    try {
      const resp=await fetch("https://api.thunder.in.th/v2/verify/bank",{
        method:"POST",headers:{Authorization:"Bearer "+Deno.env.get("THUNDER_API_KEY")},body:form,signal:controller.signal
      });
      payload=await resp.json().catch(()=>null);
      if (!resp.ok || !payload?.success) {
        await db.from("slip_verifications").update({status:"ReviewRequired",error_code:safeText(payload?.error?.code||"PROVIDER_ERROR",80)}).eq("id",refId);
        return json({ok:true,id:refId,status:"ReviewRequired",code:"PROVIDER_REVIEW"});
      }
    } catch {
      await db.from("slip_verifications").update({status:"ReviewRequired",error_code:"PROVIDER_UNAVAILABLE"}).eq("id",refId);
      return json({ok:true,id:refId,status:"ReviewRequired",code:"PROVIDER_UNAVAILABLE"});
    } finally { clearTimeout(timeout); }
    const d=payload.data ?? {};
    const transRef=safeText(d.rawSlip?.transRef,160) || null;
    const slipAmount=Number(d.amountInSlip ?? d.rawSlip?.amount?.amount);
    const matchedAmount=d.isAmountMatched === true && Number.isFinite(slipAmount) && Math.round(slipAmount*100)===Math.round(amount*100);
    const matchedReceiver=!!d.matchedAccount;
    const duplicate=d.isDuplicate === true;
    const status=!transRef || !Number.isFinite(slipAmount) ? "ReviewRequired"
      : duplicate || !matchedAmount ? "Rejected"
      : !matchedReceiver ? "ReviewRequired" : "Verified";
    const {error:updateError}=await db.from("slip_verifications").update({
      transaction_ref:transRef,slip_amount:Number.isFinite(slipAmount)?slipAmount:null,
      receiver_matched:matchedReceiver,is_duplicate:duplicate,status,verified_at:new Date().toISOString()
    }).eq("id",refId);
    // Database unique transaction_ref collision: never claim success. Mark for review.
    if(updateError) {
      await db.from("slip_verifications").update({
        status:"Rejected",error_code:"DUPLICATE_TRANSACTION",is_duplicate:true
      }).eq("id",refId);
      return json({ok:true,id:refId,status:"Rejected",code:"DUPLICATE_TRANSACTION"});
    }
    return json({ok:true,id:refId,status,amount:slipAmount,
      isDuplicate:duplicate,receiverMatched:matchedReceiver,amountMatched:matchedAmount});
  } catch {return fail("UNEXPECTED_ERROR",500);}
});

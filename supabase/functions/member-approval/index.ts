// General-purpose membership approval (NO credit/wallet/betting permissions).
// Deploy with JWT verification OFF: LINE ID tokens are validated here against LINE.
// Secrets: LINE_CHANNEL_ID_PLAYER, LINE_CHANNEL_ID_ADMIN,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEB_ORIGIN.
import {createClient} from "npm:@supabase/supabase-js@2";
const origin = Deno.env.get("WEB_ORIGIN") ?? "https://homefriendmassage-boop.github.io";
const cors: Record<string,string> = {
  "Access-Control-Allow-Origin":origin,
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
  "Vary":"Origin"
};
const reply = (body:unknown,status=200) => new Response(JSON.stringify(body),{
  status, headers:{...cors,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}
});
const error = (code:string,status=400)=>reply({ok:false,code},status);
function getPrivilegedKey():string|null{
  // Supabase 2026 default: JSON dictionary of named secret keys.
  const raw=Deno.env.get("SUPABASE_SECRET_KEYS");
  if(raw){
    try{
      const keys=JSON.parse(raw) as Record<string,unknown>;
      if(typeof keys.default==="string"&&keys.default.startsWith("sb_secret_"))return keys.default;
    }catch{return null;}
  }
  // Legacy fallback, only for projects still exposing it.
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return legacy&&legacy.length>20?legacy:null;
}
async function verifyToken(token:string, channelName:"PLAYER"|"ADMIN"):Promise<string|null>{
  const clientId=Deno.env.get("LINE_CHANNEL_ID_"+channelName);
  if(!clientId||!token)return null;
  const b=new URLSearchParams({id_token:token,client_id:clientId});
  let r:Response;
  try{
    r=await fetch("https://api.line.me/oauth2/v2.1/verify",{
      method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},body:b
    });
  }catch{
    // Never echo token, secret, or LINE response details to the browser.
    throw new Error("LINE_VERIFY_UNAVAILABLE");
  }
  if(!r.ok)return null;
  const p=await r.json();
  return p.sub&&p.aud===clientId&&Number(p.exp)*1000>Date.now() ? String(p.sub) : null;
}
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response(null,{headers:cors});
  if(req.method!=="POST")return error("METHOD_NOT_ALLOWED",405);
  if(!(req.headers.get("content-type")||"").toLowerCase().startsWith("application/json"))return error("UNSUPPORTED_CONTENT_TYPE",415);
  let input:Record<string,unknown>;
  try {input=await req.json();if(!input||typeof input!=="object"||Array.isArray(input))return error("INVALID_JSON");}
  catch{return error("INVALID_JSON");}
  const action=input.action;
  if(!["apply","status","queue","decide","shop"].includes(String(action)))return error("INVALID_ACTION");
  const shopId=typeof input.shop_id==="string"?input.shop_id.trim():"";
  if(!/^[\w-]{1,80}$/.test(shopId))return error("SHOP_INVALID");
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  try {
    const isAdmin=action==="queue"||action==="decide";
    const uid=await verifyToken(token,isAdmin?"ADMIN":"PLAYER");
    if(!uid)return error("LINE_AUTH_INVALID",401);
    const dbUrl=Deno.env.get("SUPABASE_URL");
    if(!dbUrl)return error("SUPABASE_URL_MISSING",503);
    const key=getPrivilegedKey();
    if(!key)return error("SUPABASE_SERVER_KEY_MISSING",503);
    const db=createClient(dbUrl,key,{
      auth:{persistSession:false,autoRefreshToken:false}
    });
    const {data:shop, error:shopError}=await db.from("shops").select("*").eq("shop_id",shopId).maybeSingle();
    if(shopError)return error("DATABASE_ERROR",500);
    if(!shop)return error("SHOP_NOT_AVAILABLE",404);
    if(action==="shop"){
      const names=["shop_name","name","business_name","store_name","display_name","title"];
      const label=names.map(k=>shop[k]).find(v=>typeof v==="string"&&v.trim().length>0);
      return reply({ok:true,shop_name:typeof label==="string"?label.trim():null});
    }
    if(isAdmin){
      const {data:staff,error:staffError}=await db.from("users").select("role,status").eq("uid",uid).eq("shop_id",shopId).maybeSingle();
      if(staffError)return error("DATABASE_ERROR",500);
      if(!staff||staff.status!=="Active"||!["Admin","Superadmin"].includes(staff.role))return error("ADMIN_REQUIRED",403);
      if(action==="queue"){
        const {data, error:queueError}=await db.from("membership_applications")
          .select("id,member_id,display_name,state,requested_at,decided_at,reason")
          .eq("shop_id",shopId).order("requested_at",{ascending:false}).limit(100);
        if(queueError)return error("DATABASE_ERROR",500);
        return reply({ok:true,entries:data??[]});
      }
      const id=typeof input.id==="string"?input.id:"";
      const decision=input.decision;
      if(!/^[0-9a-f-]{36}$/i.test(id)||!["Approved","Rejected"].includes(String(decision)))return error("INVALID_DECISION");
      const {data, error:writeError}=await db.from("membership_applications")
        .update({state:decision,decided_by:uid,decided_at:new Date().toISOString()})
        .eq("id",id).eq("shop_id",shopId).eq("state","Pending")
        .select("id,member_id,state").maybeSingle();
      if(writeError)return error("DATABASE_ERROR",500);
      if(!data)return error("ALREADY_PROCESSED",409);
      return reply({ok:true,application:data});
    }
    if(action==="status"){
      const {data,error:readError}=await db.from("membership_applications")
        .select("id,member_id,state,requested_at,decided_at").eq("shop_id",shopId).eq("line_uid",uid).maybeSingle();
      if(readError)return error("DATABASE_ERROR",500);
      return reply({ok:true,application:data??null});
    }
    const displayName=typeof input.display_name==="string"?input.display_name.trim().slice(0,80):"";
    const {data,error:upsertError}=await db.from("membership_applications")
      .upsert({shop_id:shopId,line_uid:uid,display_name,state:"Pending"},
        {onConflict:"shop_id,line_uid",ignoreDuplicates:true})
      .select("id,member_id,state").maybeSingle();
    if(upsertError)return error("DATABASE_ERROR",500);
    // If conflict, retrieve state without resetting an existing decision.
    if(!data){
      const read=await db.from("membership_applications").select("id,member_id,state").eq("shop_id",shopId).eq("line_uid",uid).maybeSingle();
      if(read.error)return error("DATABASE_ERROR",500);
      return reply({ok:true,application:read.data});
    }
    return reply({ok:true,application:data});
  }catch(e){
    if(e instanceof Error&&e.message==="LINE_VERIFY_UNAVAILABLE")return error("LINE_VERIFY_UNAVAILABLE",503);
    // The response deliberately excludes internal exception messages.
    console.error("member-approval unexpected exception",e instanceof Error?e.name:"unknown");
    return error("SERVER_ERROR",500);
  }
});

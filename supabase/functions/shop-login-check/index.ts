import { createClient } from "npm:@supabase/supabase-js@2";

const SHOP = "SHOP_001";
const CHANNEL = "2009043114";
const origin = Deno.env.get("WEB_ORIGIN") || "https://homefriendmassage-boop.github.io";
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (code: string, status: number) => reply({ ok: false, code }, status);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return fail("METHOD_NOT_ALLOWED", 405);
  if (request.headers.get("origin") && request.headers.get("origin") !== origin) return fail("ORIGIN_INVALID", 403);
  const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || token.length > 16000) return fail("LINE_AUTH_INVALID", 401);
  try {
    const verified = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      body: new URLSearchParams({ id_token: token, client_id: CHANNEL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!verified.ok) return fail("LINE_AUTH_INVALID", 401);
    const claims = await verified.json();
    if (claims.aud !== CHANNEL || typeof claims.sub !== "string" ||
        !/^U[0-9a-f]{32}$/i.test(claims.sub) || !(Number(claims.exp) * 1000 > Date.now())) {
      return fail("LINE_AUTH_INVALID", 401);
    }
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const shop = await db.from("shops").select("status,line_oa_bot_uid").eq("shop_id", SHOP).maybeSingle();
    if (shop.error || shop.data?.status !== "active" || !shop.data.line_oa_bot_uid) return fail("SHOP_UNAVAILABLE", 503);
    const mapping = await db.from("shop_oa_member_links").select("member_uid")
      .eq("shop_id", SHOP).eq("bot_uid", shop.data.line_oa_bot_uid).eq("oa_uid", claims.sub).maybeSingle();
    if (mapping.error) return fail("LOOKUP_FAILED", 503);
    if (!mapping.data) return fail("ACCOUNT_NOT_LINKED", 404);
    const uid = mapping.data.member_uid;
    const [member, application] = await Promise.all([
      db.from("users").select("status,member_id").eq("shop_id", SHOP).eq("uid", uid).maybeSingle(),
      db.from("membership_applications").select("state,member_id").eq("shop_id", SHOP).eq("line_uid", uid).maybeSingle(),
    ]);
    if (member.error || application.error) return fail("LOOKUP_FAILED", 503);
    const code = /^M([0-9]{4,})$/.exec(member.data?.member_id ?? "");
    if (!code || member.data?.status !== "Active" || application.data?.state !== "Approved" ||
        application.data.member_id !== member.data.member_id) return fail("MEMBER_NOT_ACTIVE", 403);
    return reply({ ok: true, member_code: "M001-" + code[1] });
  } catch {
    return fail("LOOKUP_FAILED", 503);
  }
});

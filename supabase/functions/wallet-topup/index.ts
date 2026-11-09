import { createClient } from "npm:@supabase/supabase-js@2";

const env = (name: string) => Deno.env.get(name) ?? "";
const origin = env("WEB_ORIGIN") || "https://homefriendmassage-boop.github.io";
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const reply = (code: string, status: number) => new Response(JSON.stringify({
  ok: status === 200, code,
}), { status, headers });
const extensions = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"],
  ["image/gif", "gif"], ["image/webp", "webp"],
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return reply("METHOD_NOT_ALLOWED", 405);
  if (req.headers.get("origin") && req.headers.get("origin") !== origin) return reply("ORIGIN_INVALID", 403);

  const channel = env("LINE_CHANNEL_ID_PLAYER");
  const thunder = env("THUNDER_API_KEY");
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!channel || !thunder || !url || !key) return reply("AUTO_CREDIT_DISABLED", 503);
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || token.length > 16000) return reply("LINE_AUTH_INVALID", 401);

  try {
    const identity = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      body: new URLSearchParams({ id_token: token, client_id: channel }),
      signal: AbortSignal.timeout(8000),
    });
    if (!identity.ok) return reply("LINE_AUTH_INVALID", 401);
    const claims = await identity.json();
    const uid = claims.sub;
    if (typeof uid !== "string" || !/^U[0-9a-f]{32}$/i.test(uid) ||
        claims.aud !== channel || !(Number(claims.exp) * 1000 > Date.now())) return reply("LINE_AUTH_INVALID", 401);

    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) return reply("FORM_REQUIRED", 415);
    if (Number(req.headers.get("content-length")) > 4_250_000) return reply("IMAGE_INVALID", 413);
    const input = await req.formData();
    const shop = input.get("shop_id");
    const amount = input.get("amount");
    const image = input.get("image");
    if (typeof shop !== "string" || !/^SHOP_[0-9]{3,}$/.test(shop)) return reply("SHOP_INVALID", 400);
    if (typeof amount !== "string" || !/^\d{1,9}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      return reply("AMOUNT_INVALID", 400);
    }
    if (!(image instanceof File) || !extensions.has(image.type) || !image.size || image.size > 4_194_304) {
      return reply("IMAGE_INVALID", 400);
    }

    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const [member, application, account] = await Promise.all([
      db.from("users").select("role,member_id").eq("uid", uid).eq("shop_id", shop).eq("status", "Active").maybeSingle(),
      db.from("membership_applications").select("member_id").eq("line_uid", uid).eq("shop_id", shop).eq("state", "Approved").maybeSingle(),
      db.from("wallet_receiving_accounts").select("shop_id").eq("shop_id", shop).eq("enabled", true).lte("auto_credit_from", new Date().toISOString()).limit(1),
    ]);
    if (member.error || application.error || account.error) return reply("WALLET_UNAVAILABLE", 503);
    if (!member.data || !application.data || member.data.member_id !== application.data.member_id ||
        member.data.role === "Backer") return reply("PLAYER_ACCESS_REQUIRED", 403);
    if (!account.data.length) return reply("AUTO_CREDIT_DISABLED", 503);

    const digest = await crypto.subtle.digest("SHA-256", await image.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const prior = await db.from("wallet_slip_credits").select("amount")
      .eq("shop_id", shop).eq("uid", uid).eq("image_hash", hash).maybeSingle();
    if (prior.error) return reply("WALLET_UNAVAILABLE", 503);
    if (prior.data) return Number(prior.data.amount) === Number(amount)
      ? reply("ALREADY_CREDITED", 200) : reply("AMOUNT_MISMATCH", 422);

    const form = new FormData();
    form.set("image", image);
    form.set("matchAccount", "true");
    form.set("matchAmount", amount);
    form.set("checkDuplicate", "true");
    const response = await fetch("https://api.thunder.in.th/v2/verify/bank", {
      method: "POST", headers: { Authorization: "Bearer " + thunder }, body: form,
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) return reply("SLIP_NOT_VERIFIED", 422);

    const slip = payload.data;
    const ref = slip?.rawSlip?.transRef;
    const time = Date.parse(slip?.rawSlip?.date);
    const bank = slip?.matchedAccount?.bank?.code;
    const number = slip?.matchedAccount?.bankNumber;
    if (slip?.isDuplicate === true) return reply("DUPLICATE_SLIP", 409);
    if (slip?.isDuplicate !== false || typeof ref !== "string" || !ref.trim() || ref.length > 160 ||
        !Number.isFinite(time) || time > Date.now() + 60000) return reply("SLIP_NOT_VERIFIED", 422);
    if (slip.isAmountMatched !== true || slip.amountInSlip !== Number(amount)) return reply("AMOUNT_MISMATCH", 422);
    if (typeof bank !== "string" || typeof number !== "string") return reply("RECEIVER_MISMATCH", 422);
    const normalizedNumber = number.replace(/[ -]/g, "");
    const match = await db.from("wallet_receiving_accounts").select("auto_credit_from")
      .eq("bank_code", bank).eq("bank_number", normalizedNumber).eq("shop_id", shop).eq("enabled", true).maybeSingle();
    if (match.error) return reply("WALLET_UNAVAILABLE", 503);
    const cutoff = Date.parse(match.data?.auto_credit_from);
    if (!Number.isFinite(cutoff) || cutoff > Date.now()) return reply("RECEIVER_MISMATCH", 422);
    if (time < cutoff) return reply("SLIP_NOT_VERIFIED", 422);

    const id = crypto.randomUUID();
    const path = shop + "/" + uid + "/" + id + "." + extensions.get(image.type);
    const bucket = db.storage.from("slips-private");
    const upload = await bucket.upload(path, image, { contentType: image.type, upsert: false });
    if (upload.error) return reply("STORAGE_ERROR", 500);
    const credit = await db.rpc("credit_verified_wallet_slip", {
      p_id: id, p_shop: shop, p_uid: uid, p_ref: ref.trim(), p_hash: hash,
      p_amount: amount, p_bank: bank, p_number: normalizedNumber, p_path: path, p_slip_at: new Date(time).toISOString(),
    });
    if (credit.error) return reply("WALLET_UNAVAILABLE", 503);
    if (credit.data === "CREDITED") {
      try {
        const settings = await db.from("shops").select("line_oa_token,admin_group_id,liff_id_player")
          .eq("shop_id", shop).maybeSingle();
        const token = settings.data?.line_oa_token;
        const playerLiff = settings.data?.liff_id_player || env("MEMBERSHIP_LIFF_ID_PLAYER") || "2012454809-UFGeUGbW";
        if (token) {
          const title = "เติม Wallet สำเร็จ";
          const message = { type: "flex", altText: title, contents: {
            type: "bubble",
            body: { type: "box", layout: "vertical", spacing: "sm", contents: [
              { type: "text", text: title, weight: "bold", wrap: true },
              { type: "text", text: "สมาชิก " + member.data.member_id + " · ฿" + Number(amount).toLocaleString("th-TH"), wrap: true },
            ] },
          } };
          const recipients = [uid];
          const admin = settings.data?.admin_group_id;
          if (/^[CUR][0-9a-f]{32}$/i.test(admin ?? "") && admin !== uid) recipients.push(admin);
          await Promise.allSettled(recipients.map(async to => {
            const flex = to === uid && /^\d+-[a-zA-Z0-9]+$/.test(playerLiff) ? {
              ...message, contents: { ...message.contents, footer: { type: "box", layout: "vertical", contents: [{
                type: "button", style: "primary", action: {
                  type: "uri", label: "เปิดหน้า Player", uri: "https://liff.line.me/" + playerLiff + "?shop=" + encodeURIComponent(shop),
                },
              }] } },
            } : message;
            const sent = await fetch("https://api.line.me/v2/bot/message/push", {
              method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
              body: JSON.stringify({ to, messages: [flex] }), signal: AbortSignal.timeout(3000),
            });
            if (!sent.ok) console.error("wallet automatic credit LINE notification rejected", sent.status);
          }));
        }
      } catch { console.error("wallet automatic credit LINE notification unavailable"); }
      return reply("CREDITED", 200);
    }
    await bucket.remove([path]);
    if (credit.data === "ALREADY_CREDITED") return reply(credit.data, 200);
    return reply(credit.data, credit.data === "DUPLICATE_SLIP" ? 409 : 422);
  } catch {
    return reply("WALLET_UNAVAILABLE", 503);
  }
});

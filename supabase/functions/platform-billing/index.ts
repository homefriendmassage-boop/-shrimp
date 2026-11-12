import { createClient } from "npm:@supabase/supabase-js@2";

const env = (key: string) => Deno.env.get(key) || "";
const origin = env("WEB_ORIGIN") || "https://homefriendmassage-boop.github.io";
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};
const respond = (data: object, status = 200) => new Response(
  JSON.stringify({ ok: status === 200, ...data }), { status, headers },
);
const fail = (code: string, status: number) => respond({ code }, status);
const orderFields = "id,sku,amount,slip_credits,created_at,paid_at";
const orderId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const images = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type Receiver = {
  transfer_method: string; transfer_number: string; recipient_name: string; bank_name: string | null;
  verified_bank_code: string; verified_bank_number: string; enabled: boolean;
};
const receiverFields = "transfer_method,transfer_number,recipient_name,bank_name,verified_bank_code,verified_bank_number,enabled";
const normalizeNumber = (value: unknown) => typeof value === "string" ? value.replace(/[ -]/g, "") : "";
let cachedReceiver: { key: string; until: number; registration: Promise<string> } | undefined;

function checkReceiverRegistration(receiver: Receiver, thunder: string) {
  const key = receiver.verified_bank_code + ":" + receiver.verified_bank_number;
  if (cachedReceiver?.key === key && cachedReceiver.until > Date.now()) return cachedReceiver.registration;
  const registration = (async () => {
    let page = 1;
    const limit = 100;
    while (true) {
      const endpoint = new URL("https://api.thunder.in.th/v2/bank-accounts");
      endpoint.search = new URLSearchParams({ bankCode: receiver.verified_bank_code, limit: String(limit), page: String(page) }).toString();
      const response = await fetch(endpoint, {
        headers: { Authorization: "Bearer " + thunder }, signal: AbortSignal.timeout(5000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.success !== true || !Array.isArray(result.data?.items)) {
        return response.status === 401 || response.status === 403 ? "THUNDER_ACCOUNT_ACCESS_REQUIRED" : "THUNDER_LOOKUP_UNAVAILABLE";
      }
      if (result.data.items.some((item: { bankCode: string; bankNumber: string; extraVerify: string | null }) =>
        item.bankCode === receiver.verified_bank_code && normalizeNumber(item.bankNumber) === receiver.verified_bank_number &&
        item.extraVerify !== "NAME")) return "REGISTERED";
      if (page * limit >= result.data.total || result.data.items.length < limit || page >= 10) {
        return "RECEIVER_NOT_LINKED";
      }
      page++;
    }
  })().catch(() => "THUNDER_LOOKUP_UNAVAILABLE");
  cachedReceiver = { key, until: Date.now() + 60_000, registration };
  return registration;
}

async function billingReceiver(db: ReturnType<typeof createClient>, thunder: string) {
  const result = await db.from("platform_billing_receiver").select(receiverFields).eq("id", true).maybeSingle();
  if (result.error) throw new Error("BILLING_UNAVAILABLE");
  const receiver = result.data as Receiver | null;
  if (!receiver || !thunder) return { receiver, registration: receiver ? "THUNDER_KEY_REQUIRED" : "RECEIVER_REQUIRED" };
  const conflict = await db.from("wallet_receiving_accounts").select("shop_id")
    .eq("bank_code", receiver.verified_bank_code).eq("bank_number", receiver.verified_bank_number)
    .eq("enabled", true).limit(1);
  if (conflict.error) throw new Error("BILLING_UNAVAILABLE");
  const registration = conflict.data.length ? "RECEIVER_CONFLICT" : await checkReceiverRegistration(receiver, thunder);
  return { receiver, registration };
}

Deno.serve(async req => {
  if (req.headers.get("origin") && req.headers.get("origin") !== origin) return fail("ORIGIN_INVALID", 403);
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const channel = env("LINE_CHANNEL_ID_ADMIN");
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const thunder = env("PLATFORM_BILLING_THUNDER_KEY") || env("THUNDER_API_KEY");
  if (!url || !key) return fail("BILLING_UNAVAILABLE", 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  if (req.method === "GET" && new URL(req.url).searchParams.has("readiness")) {
    try {
      const { receiver, registration } = await billingReceiver(db, thunder);
      return respond({
        registered: registration === "REGISTERED",
        available: Boolean(receiver?.enabled && registration === "REGISTERED" && channel),
        status: registration,
      });
    } catch {
      return fail("BILLING_UNAVAILABLE", 503);
    }
  }
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", 405);
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || token.length > 16000) return fail("LINE_AUTH_INVALID", 401);
  if (!channel) return fail("BILLING_UNAVAILABLE", 503);

  try {
    const identity = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      body: new URLSearchParams({ id_token: token, client_id: channel }),
      signal: AbortSignal.timeout(8000),
    });
    if (!identity.ok) return fail("LINE_AUTH_INVALID", 401);
    const claims = await identity.json();
    if (!/^U[0-9a-f]{32}$/i.test(claims.sub) || claims.aud !== channel ||
        !(Number(claims.exp) * 1000 > Date.now())) return fail("LINE_AUTH_INVALID", 401);

    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    const upload = contentType.startsWith("multipart/form-data");
    if (!upload && !contentType.startsWith("application/json")) return fail("FORM_INVALID", 415);
    const length = Number(req.headers.get("content-length"));
    if (length > (upload ? 4_250_000 : 4096)) return fail("FORM_INVALID", 413);
    const raw = upload ? null : await req.text();
    if (raw !== null && raw.length > 4096) return fail("FORM_INVALID", 413);
    let input;
    try { input = upload ? Object.fromEntries(await req.formData()) : JSON.parse(raw ?? "null"); }
    catch { return fail("FORM_INVALID", 400); }
    const shop = input?.shop_id;
    if (typeof shop !== "string" || !/^SHOP_[0-9]{3,24}$/.test(shop) || shop === "SHOP_000") {
      return fail("SHOP_INVALID", 400);
    }
    if (!["summary", "create", "pay"].includes(input.action) || upload !== (input.action === "pay")) {
      return fail("FORM_INVALID", 400);
    }

    const owner = await db.from("users").select("uid").eq("shop_id", shop).eq("uid", claims.sub)
      .eq("member_id", "M0000").eq("status", "Active").in("role", ["Admin", "Superadmin"]).maybeSingle();
    if (owner.error) return fail("BILLING_UNAVAILABLE", 503);
    if (!owner.data) return fail("OWNER_REQUIRED", 403);

    const { receiver, registration } = await billingReceiver(db, thunder);
    const available = Boolean(receiver?.enabled && registration === "REGISTERED");

    if (input.action === "summary") {
      const [products, plan, state, orders] = await Promise.all([
        db.from("platform_billing_products").select("sku,label,kind,amount,slip_credits").order("amount"),
        db.from("platform_shop_plan_requests").select("plan_code,trial_ends_at").eq("shop_id", shop).maybeSingle(),
        db.from("platform_billing_state").select("plan_code,paid_until,slip_balance,trial_slips_used").eq("shop_id", shop).maybeSingle(),
        db.from("platform_billing_orders").select(orderFields).eq("shop_id", shop).order("created_at", { ascending: false }).limit(20),
      ]);
      if ([products, plan, state, orders].some(result => result.error)) return fail("BILLING_UNAVAILABLE", 503);
      const trial = !state.data?.plan_code && Date.parse(plan.data?.trial_ends_at ?? "") > Date.now();
      return respond({
        available, products: products.data, requested_plan: plan.data?.plan_code ?? null,
        current_plan: state.data?.plan_code ?? null, paid_until: state.data?.paid_until ?? null,
        trial_slips: trial ? 30 - (state.data?.trial_slips_used ?? 0) : 0,
        slip_balance: state.data?.slip_balance ?? 0, orders: orders.data,
      });
    }

    if (!available || !receiver) return fail("BILLING_NOT_CONFIGURED", 503);
    if (input.action === "create") {
      if (typeof input.sku !== "string" || !/^[a-z0-9]{1,24}$/.test(input.sku)) return fail("PRODUCT_INVALID", 400);
      const order = await db.rpc("create_platform_billing_order", { p_shop: shop, p_sku: input.sku })
        .select(orderFields).maybeSingle();
      if (order.error) return fail("BILLING_UNAVAILABLE", 503);
      if (!order.data?.id) return fail("PRODUCT_INVALID", 404);
      return respond({
        order: order.data,
        receiver: {
          method: receiver.transfer_method, number: receiver.transfer_number,
          name: receiver.recipient_name, bank: receiver.bank_name,
        },
      });
    }

    if (typeof input.order_id !== "string" || !orderId.test(input.order_id)) return fail("ORDER_INVALID", 400);
    const image = input.image;
    if (!(image instanceof File) || !images.has(image.type) || !image.size || image.size > 4_194_304) {
      return fail("IMAGE_INVALID", 400);
    }
    const order = await db.from("platform_billing_orders").select(orderFields)
      .eq("id", input.order_id).eq("shop_id", shop).maybeSingle();
    if (order.error) return fail("BILLING_UNAVAILABLE", 503);
    if (!order.data) return fail("ORDER_INVALID", 404);
    if (order.data.paid_at) return respond({ code: "ALREADY_PAID" });

    const form = new FormData();
    form.set("image", image);
    form.set("matchAccount", "true");
    form.set("matchAmount", String(order.data.amount));
    // Keep the same slip retryable if verification succeeds but settlement is interrupted.
    // The transaction reference is checked and reserved atomically in the database.
    form.set("checkDuplicate", "false");
    const checked = await fetch("https://api.thunder.in.th/v2/verify/bank", {
      method: "POST",
      headers: { Authorization: "Bearer " + thunder },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const result = await checked.json().catch(() => null);
    if (!checked.ok || result?.success !== true) return fail("SLIP_NOT_VERIFIED", 422);

    const slip = result.data;
    const ref = slip?.rawSlip?.transRef;
    const transferAt = Date.parse(slip?.rawSlip?.date);
    if (typeof ref !== "string" || !ref.trim() || ref.length > 160 || !Number.isFinite(transferAt)) {
      return fail("SLIP_NOT_VERIFIED", 422);
    }
    if (slip.isAmountMatched !== true || slip.amountInSlip !== order.data.amount) return fail("AMOUNT_MISMATCH", 422);
    const bank = slip?.matchedAccount?.bank?.code;
    const account = normalizeNumber(slip?.matchedAccount?.bankNumber);
    if (bank !== receiver.verified_bank_code || account !== receiver.verified_bank_number) {
      return fail("RECEIVER_MISMATCH", 422);
    }

    const paid = await db.rpc("settle_platform_billing_order", {
      p_shop: shop, p_order: order.data.id, p_ref: ref.trim(), p_amount: order.data.amount,
      p_bank: bank, p_account: account, p_transfer_at: new Date(transferAt).toISOString(),
    });
    if (paid.error) return fail("BILLING_UNAVAILABLE", 503);
    if (!["PAID", "ALREADY_PAID"].includes(paid.data)) return fail(paid.data || "SLIP_NOT_VERIFIED", 422);
    return respond({ code: paid.data });
  } catch {
    return fail("BILLING_UNAVAILABLE", 503);
  }
});

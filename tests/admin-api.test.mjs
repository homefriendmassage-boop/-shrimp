import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../supabase/functions/admin-api/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*createClient.*;$/m, '')
  .replace(/^Deno\.serve.*;$/m, '');
const { validateQuery, makeHandler } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const base = { table: 'users', columns: 'uid,role', filters: [], orders: [] };

test('player links use a common LIFF and preserve only the intended shop context', () => {
  const config = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(config, context);
  const link = context.playerEntryUrl('SHOP_001', {
    table: 'A & 1', d: '2026-11-12', ref: 'M001-0003', shop: 'SHOP_002', shop_login: '1',
  });
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, 'https://liff.line.me/2012454809-UFGeUGbW');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    shop: 'SHOP_001', table: 'A & 1', d: '2026-11-12', ref: 'M001-0003',
  });
  for (const shop of ['SHOP_000', 'SHOP_002', 'SHOP_100']) {
    assert.equal(context.playerEntryUrl(shop), url.origin + url.pathname + '?shop=' + shop);
  }
});

test('only enumerated tables and plain columns are accessible', () => {
  for (const table of ['shops', 'membership_admins', 'auth.users', '__proto__']) assert.throws(() => validateQuery({ ...base, table }, 'Admin', 'SHOP_001'));
  assert.throws(() => validateQuery({ ...base, columns: '*,shops(*)' }, 'Admin', 'SHOP_001'));
  assert.equal(validateQuery({ ...base, columns: '*' }, 'Admin', 'SHOP_001').columns.includes('role'), true);
});
test('cross-shop filters, writes and role escalation are rejected', () => {
  assert.throws(() => validateQuery({ ...base, filters: [{ op: 'eq', column: 'shop_id', value: 'OTHER' }] }, 'Admin', 'SHOP_001'));
  assert.throws(() => validateQuery({ ...base, operation: 'update', filters: [{ op: 'eq', column: 'uid', value: 'victim' }], values: { shop_id: 'OTHER' } }, 'Admin', 'SHOP_001'));
  assert.throws(() => validateQuery({ ...base, operation: 'update', filters: [{ op: 'eq', column: 'uid', value: 'victim' }], values: { role: 'Admin' } }, 'Operator', 'SHOP_001'));
  assert.throws(() => validateQuery(base, 'Backer', 'SHOP_001'));
});
test('writes must have a target and use permitted fields and amounts', () => {
  assert.throws(() => validateQuery({ ...base, operation: 'update', values: { role: 'Admin' } }, 'Admin', 'SHOP_001'));
  const q = { ...base, operation: 'update', filters: [{ op: 'eq', column: 'uid', value: 'target' }] };
  assert.throws(() => validateQuery({ ...q, values: { credit_balance: -1 } }, 'Admin', 'SHOP_001'));
  assert.throws(() => validateQuery({ ...q, values: { display_name: 'not writable' } }, 'Admin', 'SHOP_001'));
  assert.throws(() => validateQuery({ ...q, values: [{ role: 'Admin' }] }, 'Admin', 'SHOP_001'));
  assert.equal(validateQuery({ ...q, values: { credit_balance: 100 } }, 'Operator', 'SHOP_001').operation, 'update');
});

function setup({ role = 'Admin', active = true, absent = false, aud = 'channel', exp = Date.now() / 1000 + 60, linked = true, shopStatus = 'active', brokenDb = false } = {}) {
  const queries = [];
  const env = name => ({ LINE_CHANNEL_ID_ADMIN: 'channel', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only', WEB_ORIGIN: 'https://homefriendmassage-boop.github.io' })[name];
  const createDb = () => ({ from(table) {
    const record = { table, calls: [] }; queries.push(record);
    const chain = {};
    for (const method of ['select', 'eq', 'neq', 'gte', 'lte', 'like', 'in', 'order', 'limit', 'insert', 'update', 'delete', 'single', 'maybeSingle']) {
      chain[method] = (...args) => { record.calls.push([method, ...args]); return chain; };
    }
    chain.then = (resolve, reject) => {
      let data = [];
      if (queries.length === 1) data = absent ? null : { uid: 'verified-user', shop_id: 'SHOP_001', role, status: active ? 'Active' : 'Inactive' };
      else if (queries.length === 2) data = { shop_id: 'SHOP_001', status: shopStatus };
      else if (record.calls.some(c => c[0] === 'maybeSingle')) data = linked ? { uid: 'linked-user' } : null;
      return Promise.resolve({ data, error: brokenDb ? { code: 'test' } : null }).then(resolve, reject);
    };
    return chain;
  } });
  const fetcher = async () => new Response(JSON.stringify({ sub: 'verified-user', aud, exp }), { status: 200 });
  return { handler: makeHandler({ env, createDb, fetcher }), queries };
}
function request(payload, headers = {}) {
  return new Request('https://example.supabase.co/functions/v1/admin-api', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token', ...headers },
    body: JSON.stringify({ action: 'access', shop_id: 'SHOP_001', ...payload })
  });
}
test('server uses verified LINE identity and returns active staff', async () => {
  const { handler, queries } = setup();
  const response = await handler(request({ uid: 'attacker', role: 'Superadmin' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).staff.uid, 'verified-user');
  assert(queries[0].calls.some(c => c[0] === 'eq' && c[1] === 'uid' && c[2] === 'verified-user'));
});
test('membership-only, inactive, backer and unavailable shop cannot access legacy admin', async () => {
  for (const config of [{ absent: true }, { active: false }, { role: 'Backer' }, { shopStatus: 'inactive' }]) {
    const { handler } = setup(config);
    assert.equal((await handler(request())).status, 403);
  }
});
test('shop admin roles cannot open or close a shop without a platform grant', async () => {
  for (const role of ['Admin', 'Superadmin', 'Operator']) {
    const { handler, queries } = setup({ role });
    const response = await handler(request({
      action: 'platform_shop_control', target_shop_id: 'SHOP_002', setting: 'service_enabled', enabled: false,
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, code: 'PLATFORM_ADMIN_REQUIRED' });
    assert(queries.every(query => query.table === 'platform_shop_admins'));
  }
});
test('expired and wrong-channel tokens are rejected before database access', async () => {
  for (const config of [{ exp: 1 }, { aud: 'wrong-channel' }]) {
    const { handler, queries } = setup(config);
    assert.equal((await handler(request())).status, 401);
    assert.equal(queries.length, 0);
  }
});
test('query always receives server shop predicate even when omitted by caller', async () => {
  const { handler, queries } = setup();
  const response = await handler(request({ ...base, action: 'query' }));
  assert.equal(response.status, 200);
  assert(queries[2].calls.some(c => c[0] === 'eq' && c[1] === 'shop_id' && c[2] === 'SHOP_001'));
});
test('cross-shop linked insert is rejected before mutation', async () => {
  const { handler, queries } = setup({ linked: false });
  const response = await handler(request({ action: 'query', table: 'backer_logs', operation: 'insert', values: { uid: 'foreign', round_id: 'r' } }));
  assert.equal(response.status, 400);
  assert(!queries.some(q => q.calls.some(c => c[0] === 'insert')));
});
test('untrusted origins and database failures fail closed', async () => {
  assert.equal((await setup().handler(request({}, { origin: 'https://untrusted.test' }))).status, 403);
  const result = await setup({ brokenDb: true }).handler(request());
  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { ok: false, code: 'DATABASE_ERROR' });
});
test('player entry exposes only the requested active shop name and verified add-friend link', async () => {
  const shops = {
    SHOP_000: { shop_name: 'Demo', status: 'active', line_oa_bot_uid: null, token: 'demo-token' },
    SHOP_001: { shop_name: 'One', status: 'active', line_oa_bot_uid: 'bot-one', token: 'one-token' },
    SHOP_002: { shop_name: 'Two', status: 'active', line_oa_bot_uid: 'bot-two', token: 'wrong-token' },
    SHOP_003: { shop_name: 'Closed', status: 'Inactive', token: 'closed-token' },
    SHOP_004: { shop_name: 'Trial', status: 'active', token: null },
  };
  const lookedUp = [];
  const handler = makeHandler({
    env: name => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only' })[name],
    createDb: () => ({ from(table) {
      let shop;
      return {
        select() { return this; },
        eq(column, id) { assert.equal(column, 'shop_id'); shop = shops[id]; return this; },
        async maybeSingle() {
          return { data: table === 'shops' ? shop : { line_oa_token: shop?.token } };
        }
      };
    } }),
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.line.me/v2/bot/info');
      const token = options.headers.Authorization.replace('Bearer ', '');
      lookedUp.push(token);
      return Response.json({ userId: 'bot-one', basicId: token === 'demo-token' ? '@demo' : '@one' });
    },
  });
  const entry = shop_id => handler(request({ action: 'player_entry', shop_id }, { authorization: '' }));
  assert.deepEqual(await (await entry('SHOP_000')).json(), {
    ok: true, shop_name: 'Demo', add_friend_url: 'https://line.me/R/ti/p/%40demo',
  });
  assert.deepEqual(await (await entry('SHOP_001')).json(), {
    ok: true, shop_name: 'One', add_friend_url: 'https://line.me/R/ti/p/%40one',
  });
  assert.equal((await (await entry('SHOP_002')).json()).add_friend_url, null);
  assert.equal((await entry('SHOP_003')).status, 404);
  assert.equal((await (await entry('SHOP_004')).json()).add_friend_url, null);
  assert.equal((await entry('OTHER')).status, 400);
  await entry('SHOP_001');
  assert.deepEqual(lookedUp, ['demo-token', 'one-token', 'wrong-token']);
});
test('client sends LINE token and query, surfaces rejected requests without success', async () => {
  const calls = [];
  const context = vm.createContext({ AbortSignal, liff: { getIDToken: () => 'line-token' }, fetch: async (url, opts) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({ ok: true, data: [{ table_no: '5' }] }));
  } });
  vm.runInContext(fs.readFileSync(new URL('../admin-api-client.js', import.meta.url), 'utf8'), context);
  const client = context.createAdminApiClient({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public' }, () => 'SHOP_001');
  const result = await client.from('tables').select('*').eq('shop_id', 'SHOP_001').order('created_at', { ascending: true });
  assert.equal(result.data[0].table_no, '5');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer line-token');
  assert.equal(JSON.parse(calls[0].opts.body).operation, 'select');
  context.fetch = async () => new Response(JSON.stringify({ ok: false, code: 'ADMIN_REQUIRED' }), { status: 403 });
  await assert.rejects(async () => await client.from('tables').delete().eq('table_no', '5'), /ADMIN_REQUIRED/);
});
test('patched HTML retains original controls and uses the new access check', () => {
  const originalIds = JSON.parse(fs.readFileSync(new URL('./original-admin-ids.json', import.meta.url), 'utf8')); 
  const patched = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const ids = text => [...text.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  for (const id of originalIds) assert(ids(patched).includes(id), id);
  assert(patched.includes('await _supabase.access()'));
  assert(!patched.includes('supabase.createClient('));
  for (const match of patched.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('cash deposits and withdrawals enter the selected shop queue', async () => {
  const uid = 'U' + 'a'.repeat(32);
  const insertions = [];
  const env = name => ({
    LINE_CHANNEL_ID_PLAYER: 'channel', SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only',
  })[name];
  const rows = {
    shops: { status: 'active' },
    users: { uid, status: 'Active', role: 'Customer', member_id: 'M0001' },
    membership_applications: { state: 'Approved', member_id: 'M0001' },
    system_settings: { withdrawal_fee_mode: 'none' },
    shop_oa_runtime: null,
  };
  const createDb = () => ({
    from(table) {
      const query = {
        select: () => query, eq: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: rows[table] }),
        insert: async row => { insertions.push(row); return { error: null }; },
      };
      return query;
    },
  });
  const fetcher = async () => Response.json({ sub: uid, aud: 'channel', exp: Date.now() / 1000 + 60 });
  const handler = makeHandler({ env, createDb, fetcher });

  for (const shop_id of ['SHOP_000', 'SHOP_001', 'SHOP_002']) {
    for (const [type, method, fee_option] of [
      ['ฝากเงิน', 'เงินสด', '-'],
      ['ถอนเงิน', 'โอนเงิน', 'ไม่หักค่าน้ำ'],
    ]) {
      const response = await handler(request({ action: 'wallet_request', shop_id, type, method, amount: '10.50' }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, status: 'Pending' });
      assert.deepEqual(insertions.pop(), {
        shop_id, uid, member_id: 'M0001', display_name: 'M0001', type, method,
        amount: 10.5, fee_option, slip_url: '', status: 'Pending',
      });
    }
  }
  const payload = { action: 'wallet_request', type: 'ฝากเงิน', method: 'โอนเงิน', amount: '10.50' };
  const prefix = 'https://example.supabase.co/storage/v1/object/public/slips/slips/';
  const wrongShop = await handler(request({ ...payload, slip_url: prefix + 'SHOP_002_' + uid + '_1794469694900.png' }));
  assert.equal((await wrongShop.json()).code, 'WALLET_SLIP_INVALID');
  const slip_url = prefix + 'SHOP_001_' + uid + '_1794469694900.png';
  const valid = await handler(request({ ...payload, slip_url }));
  assert.equal(valid.status, 200);
  assert.equal(insertions.pop().slip_url, slip_url);
});

test('a shop invitation is issued only with the active shop owned by the verified LINE account', async () => {
  const expires = new Date(Date.now() + 86400000).toISOString();
  const writes = [];
  const handler = makeHandler({
    env: name => ({
      SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only',
      LINE_CHANNEL_ID_ADMIN: 'channel',
    })[name],
    fetcher: async () => Response.json({ sub: 'verified-user', aud: 'channel', exp: Date.now() / 1000 + 60 }),
    createDb: () => ({ from(table) {
      const filters = {};
      return {
        select() { return this; },
        eq(key, value) { filters[key] = value; return this; },
        in() { return this; },
        async maybeSingle() {
          if (table === 'shops') return { data: { status: filters.shop_id === 'SHOP_003' ? 'Inactive' : 'active' } };
          assert.equal(table, 'users');
          assert.equal(filters.member_id, 'M0000');
          assert.equal(filters.uid, 'verified-user');
          assert.equal(filters.status, 'Active');
          return { data: ['SHOP_001', 'SHOP_003'].includes(filters.shop_id) ? { uid: filters.uid } : null };
        },
        insert(row) { writes.push(row); return this; },
        async single() { return { data: { invite_id: 'invitation', expires_at: expires } }; },
      };
    } }),
  });
  const invite = referrer_shop_id => handler(request({
    action: 'platform_issue_shop_invite', referrer_shop_id, created_by: 'untrusted-user',
  }));
  assert.equal((await invite('')).status, 400);
  assert.equal((await invite('SHOP_002')).status, 403);
  assert.equal((await invite('SHOP_003')).status, 403);
  assert.deepEqual(writes, []);
  assert.equal((await invite('SHOP_001')).status, 200);
  assert.deepEqual(writes, [{
    created_by: 'verified-user', referrer_shop_id: 'SHOP_001', referral_tier: 'standard',
  }]);
});

test('round IDs are distinct across shops and keep the accounting-day sequence', () => {
  const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const accounting = fs.readFileSync(new URL('../accounting-day.js', import.meta.url), 'utf8');
  const helper = html.slice(html.indexOf('    function nextShopRoundId'), html.indexOf('    async function controlRound'));
  const context = vm.createContext({});
  const config = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8');
  vm.runInContext(config + '\n' + accounting + '\n' + helper, context);
  const time = Date.parse('2026-11-13T19:54:00+07:00');
  const plans = [
    ['SHOP_000', 'R-261113-4', 'R-261113-000-5'],
    ['SHOP_001', 'R-261111-7', 'R-261113-001-1'],
    ['SHOP_002', undefined, 'R-261113-002-1'],
  ];
  const ids = plans.map(([shop, previous, expected]) => {
    const id = context.nextShopRoundId(shop, previous, time);
    assert.equal(id, expected);
    assert.match(id, /^[A-Za-z0-9_-]{1,80}$/);
    return id;
  });
  assert.equal(new Set(ids).size, 3);
  assert.equal(context.formatRoundName('R-261113-1-SHOP_001'), 'R-261113-001-1');
  assert.equal(context.formatRoundName('R-261113-7'), 'R-261113-7');
  assert.equal(context.nextShopRoundId('SHOP_001', 'R-261113-1-SHOP_001', time), 'R-261113-001-2');
  assert.equal(context.nextShopRoundId('SHOP_001', ids[1], time), 'R-261113-001-2');
  assert.equal(context.nextShopRoundId('SHOP_001', ids[1], Date.parse('2026-11-14T05:59:00+07:00')), 'R-261113-001-2');
  assert.equal(context.nextShopRoundId('SHOP_001', ids[1], Date.parse('2026-11-14T06:00:00+07:00')), 'R-261114-001-1');
});

test('daily report labels cash movements separately from wallet credit and performance', () => {
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')).then(({ dailyFinanceFlex }) => {
    const message = dailyFinanceFlex('2026-11-13', 'บ่อทดสอบ', {
      settled_stake:500, payout:380, pnl:10, cancelled:50, cash_stake:300, cash_in:210, cash_out:80,
      customer_wallet_liability:652.5, wallet_as_of:'2026-11-13T13:00:00Z',
      credit_in:900, credit_out:300, table_credit_in:40, table_credit_out:20, rounds:3, ended:2, even:1, odd:1, pending:4,
    });
    assert.equal(message.type, 'flex');
    assert.match(message.altText, /บ่อทดสอบ/);
    const rows = new Map(message.contents.body.contents.filter(item => item.layout === 'horizontal')
      .map(item => item.contents.map(cell => cell.text)));
    assert.equal(rows.get('ส่วนต่างก่อนค่าคอมและค่าใช้จ่าย'), '110 บาท');
    assert.equal(rows.get('เงินสดสุทธิจากโต๊ะ'), '130 บาท');
    assert.equal(rows.get('เพิ่มเครดิตบัญชีสมาชิก'), '900 บาท');
    assert.equal(rows.get('เครดิตรับฝากลูกค้าคงเหลือ (หนี้สินร้าน)'), '652.5 บาท');
  });
});

test('daily report sends to the owner until a group is configured', async () => {
  const owner = 'U' + 'a'.repeat(32);
  const group = 'C' + 'b'.repeat(32);
  const settings = { shop_name:'บ่อทดสอบ', line_oa_token:'shop-token', membership_notice_recipient_uid:owner };
  const sent = [];
  const env = name => ({ LINE_CHANNEL_ID_ADMIN:'admin', SUPABASE_URL:'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY:'secret' })[name];
  const db = {
    from(table) {
      const row = { users:{ role:'Admin', status:'Active' }, shops:{ status:'active' }, shop_oa_runtime:settings }[table];
      const query = { select:()=>query, eq:()=>query, maybeSingle:async()=>({ data:row }) };
      return query;
    },
    async rpc(name,args) {
      assert.equal(name,'daily_group_finance_report');
      assert.deepEqual(args,{ p_shop:'SHOP_001', p_day:'2026-11-13' });
      return { data:{ customer_wallet_liability:500, wallet_as_of:'2026-11-13T13:00:00Z' } };
    },
  };
  const handler = makeHandler({ env, createDb:()=>db, fetcher:async (url,options) => {
    if (url.includes('/verify')) return Response.json({ sub:owner, aud:'admin', exp:Date.now()/1000+60 });
    sent.push(JSON.parse(options.body).to);
    return new Response();
  } });
  const send = () => handler(request({ action:'table_send_cash_report',day:'2026-11-13',delivery_id:'97b30417-a83c-4825-97da-16132977b4b3' }));
  assert.equal((await (await send()).json()).recipient_type,'owner');
  settings.admin_group_id = group;
  assert.equal((await (await send()).json()).recipient_type,'group');
  settings.admin_group_id = 'invalid';
  assert.equal((await send()).status,409);
  assert.deepEqual(sent,[owner,group]);
});

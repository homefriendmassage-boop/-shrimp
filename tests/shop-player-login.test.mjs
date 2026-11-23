import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShopPlayerLiff, hasVerifiedFriendship, shopPlayerChannel, shopPlayerUrl } from '../supabase/functions/_shared/shop-player-login.mjs';

const env = name => ({ SHOP_PLAYER_LIFF_IDS: 'SHOP_005=12345-AbC, SHOP_006=98765-Fz9' })[name];

test('selects a player channel by shop and preserves the existing pilot fallback', () => {
  assert.equal(shopPlayerChannel(env, 'SHOP_005'), '12345');
  assert.equal(shopPlayerChannel(env, 'SHOP_006'), '98765');
  assert.equal(shopPlayerChannel(env, 'SHOP_007'), null);
  assert.equal(shopPlayerChannel(env, 'SHOP_001'), '2009043114');
  assert.equal(shopPlayerUrl(env, 'SHOP_005'), 'https://liff.line.me/12345-AbC?shop=SHOP_005&shop_login=1');
  assert.equal(shopPlayerUrl(env, 'SHOP_007'), 'https://liff.line.me/2012454809-UFGeUGbW?shop=SHOP_007');
});

function line({ client = '12345', userId = 'U123', friendFlag = true } = {}) {
  return async url => {
    const route = new URL(url).pathname;
    const body = route.startsWith('/oauth2') ? { client_id: client } :
      route === '/v2/profile' ? { userId } : { friendFlag };
    return Response.json(body);
  };
}

test('requires the same LINE channel and user for friendship proof', async () => {
  assert.equal(await hasVerifiedFriendship('access', '12345', 'U123', line()), true);
  assert.equal(await hasVerifiedFriendship('access', '12345', 'U123', line({ client: '98765' })), false);
  assert.equal(await hasVerifiedFriendship('access', '12345', 'U123', line({ userId: 'U999' })), false);
  assert.equal(await hasVerifiedFriendship('access', '12345', 'U123', line({ friendFlag: false })), false);
});

test('shop configuration overrides legacy routing and can restore the central LIFF', () => {
  const candidate = '2012751848-tDnRbagq';
  assert.equal(parseShopPlayerLiff('https://liff.line.me/' + candidate), candidate);
  for (const url of ['https://liff.line.me.example/' + candidate, 'https://liff.line.me/' + candidate + '?shop=SHOP_006']) {
    assert.equal(parseShopPlayerLiff(url), null);
  }
  assert.equal(shopPlayerChannel(env, 'SHOP_005', candidate), '2012751848');
  assert.equal(shopPlayerChannel(env, 'SHOP_005', ''), null);
  assert.equal(shopPlayerUrl(env, 'SHOP_005', ''), 'https://liff.line.me/2012454809-UFGeUGbW?shop=SHOP_005');
});

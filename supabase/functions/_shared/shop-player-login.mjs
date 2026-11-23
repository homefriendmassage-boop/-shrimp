// The operator enables each shop only after linking its Login channel to its own OA.
export function shopPlayerLiff(env, shop) {
  const setting = env('SHOP_PLAYER_LIFF_IDS') || '';
  for (const entry of setting.split(',')) {
    const [shopId, id] = entry.trim().split('=');
    if (shopId === shop && /^SHOP_[0-9]{3,24}$/.test(shop) && /^\d+-[A-Za-z0-9]+$/.test(id)) return id;
  }
  return null;
}

export function shopPlayerChannel(env, shop) {
  return shopPlayerLiff(env, shop)?.split('-')[0] || (shop === 'SHOP_001' ? '2009043114' : null);
}

export function shopPlayerUrl(env, shop) {
  const liff = shopPlayerLiff(env, shop);
  const url = new URL('https://liff.line.me/' + (liff || '2012454809-UFGeUGbW'));
  url.searchParams.set('shop', shop);
  if (liff) url.searchParams.set('shop_login', '1');
  return url.href;
}

export async function hasVerifiedFriendship(token, clientId, uid, fetcher = fetch) {
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  const verify = new URL('https://api.line.me/oauth2/v2.1/verify');
  verify.searchParams.set('access_token', token);
  const verified = await fetcher(verify.href, { signal: AbortSignal.timeout(5000) });
  if (!verified.ok || (await verified.json()).client_id !== clientId) return false;

  const options = { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) };
  const [profile, friendship] = await Promise.all([
    fetcher('https://api.line.me/v2/profile', options),
    fetcher('https://api.line.me/friendship/v1/status', options),
  ]);
  return profile.ok && friendship.ok && (await profile.json()).userId === uid &&
    (await friendship.json()).friendFlag === true;
}

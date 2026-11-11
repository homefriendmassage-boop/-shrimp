create sequence public.platform_shop_number_seq;

select setval('public.platform_shop_number_seq', greatest(coalesce(max(shop_no), 0), 1), coalesce(max(shop_no), 0) > 0)
from (
  select substring(shop_id from '^SHOP_([0-9]{1,18})$')::bigint as shop_no
  from public.shops
) existing;

create table public.platform_shop_invites (
  invite_id uuid primary key default gen_random_uuid(),
  created_by text not null,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  redeemed_by text,
  shop_id text unique references public.shops(shop_id) on delete cascade
);

create table public.platform_shop_contacts (
  shop_id text primary key references public.shops(shop_id) on delete cascade,
  owner_phone text not null check (owner_phone ~ '^\+?[0-9]{8,15}$')
);

alter table public.platform_shop_invites enable row level security;
alter table public.platform_shop_contacts enable row level security;
revoke all on public.platform_shop_invites, public.platform_shop_contacts from public, anon, authenticated;
grant select, insert, update on public.platform_shop_invites to service_role;
grant insert on public.platform_shop_contacts to service_role;
grant usage on sequence public.platform_shop_number_seq to service_role;

create function public.redeem_platform_shop_invite(
  p_invite uuid, p_name text, p_owner text, p_owner_name text, p_phone text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $redeem$
declare
  invitation public.platform_shop_invites%rowtype;
  next_number text;
  next_shop text;
  outcome text;
begin
  select * into invitation from public.platform_shop_invites
  where invite_id = p_invite for update;

  if not found then return jsonb_build_object('code', 'INVITE_INVALID'); end if;
  if invitation.shop_id is not null then
    if invitation.redeemed_by = p_owner then
      return jsonb_build_object('code', 'CREATED', 'shop_id', invitation.shop_id);
    end if;
    return jsonb_build_object('code', 'INVITE_USED');
  end if;
  if invitation.expires_at <= now() then return jsonb_build_object('code', 'INVITE_EXPIRED'); end if;

  loop
    next_number := nextval('public.platform_shop_number_seq')::text;
    next_shop := 'SHOP_' || lpad(next_number, greatest(3, length(next_number)), '0');
    outcome := public.create_platform_shop(next_shop, p_name, p_owner, p_owner_name);
    exit when outcome <> 'SHOP_EXISTS';
  end loop;
  if outcome is distinct from 'CREATED' then raise exception 'SHOP_CREATE_FAILED'; end if;

  insert into public.platform_shop_contacts (shop_id, owner_phone) values (next_shop, p_phone);
  update public.platform_shop_invites set shop_id = next_shop, redeemed_by = p_owner
  where invite_id = p_invite;
  return jsonb_build_object('code', 'CREATED', 'shop_id', next_shop);
end;
$redeem$;

revoke all on function public.redeem_platform_shop_invite(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_platform_shop_invite(uuid, text, text, text, text) to service_role;

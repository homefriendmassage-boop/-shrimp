alter table public.platform_shop_invites add column own_branch boolean not null default false;

create or replace function public.redeem_platform_shop_invite(
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
  if invitation.own_branch and invitation.created_by is distinct from p_owner then
    return jsonb_build_object('code', 'INVITE_INVALID');
  end if;
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

create table public.platform_shop_admin_invites (
  invite_id uuid primary key default gen_random_uuid(),
  shop_id text not null references public.shops(shop_id) on delete cascade,
  issued_by text not null,
  target_uid text not null,
  expires_at timestamptz not null default now() + interval '24 hours',
  accepted_at timestamptz
);

alter table public.platform_shop_admin_invites enable row level security;
revoke all on public.platform_shop_admin_invites from public, anon, authenticated;
grant select, insert, update on public.platform_shop_admin_invites to service_role;

create function public.accept_shop_admin_invite(p_invite uuid, p_uid text)
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  invitation public.platform_shop_admin_invites%rowtype;
begin
  select * into invitation from public.platform_shop_admin_invites
    where invite_id = p_invite and target_uid = p_uid for update;
  if not found then return jsonb_build_object('code','INVITE_INVALID'); end if;
  if invitation.accepted_at is not null then return jsonb_build_object('code','INVITE_USED'); end if;
  if invitation.expires_at <= now() then return jsonb_build_object('code','INVITE_EXPIRED'); end if;

  perform 1 from public.users u join public.shops s on s.shop_id = u.shop_id
    where u.shop_id = invitation.shop_id and u.uid = invitation.issued_by
      and u.member_id = 'M0000' and u.status = 'Active' and u.role in ('Admin','Superadmin')
      and lower(s.status) = 'active' for share of s, u;
  if not found then return jsonb_build_object('code','ADMIN_INVITE_UNAVAILABLE'); end if;

  update public.users set role = 'Admin'
    where shop_id = invitation.shop_id and uid = p_uid
      and member_id <> 'M0000' and status = 'Active'
      and role in ('Customer','Promoter','Operator','Cashier');
  if not found then return jsonb_build_object('code','ADMIN_INVITEE_UNAVAILABLE'); end if;

  update public.platform_shop_admin_invites set accepted_at = now()
    where invite_id = p_invite;
  return jsonb_build_object('code','ACCEPTED','shop_id',invitation.shop_id);
end;
$$;

revoke all on function public.accept_shop_admin_invite(uuid, text) from public, anon, authenticated;
grant execute on function public.accept_shop_admin_invite(uuid, text) to service_role;

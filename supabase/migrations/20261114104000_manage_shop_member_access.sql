begin;

create table public.shop_role_audit (
  id bigint generated always as identity primary key,
  shop_id text not null references public.shops(shop_id),
  uid text not null,
  actor_uid text not null,
  old_role text, new_role text, old_status text, new_status text,
  created_at timestamptz not null default now()
);
create index shop_role_audit_shop_id_idx on public.shop_role_audit(shop_id,id desc);

alter table public.shop_role_audit enable row level security;
revoke all on public.shop_role_audit from public, anon, authenticated, service_role;
grant insert on public.shop_role_audit to service_role;

create function public.set_shop_member_access(p_shop text,p_actor text,p_uid text,p_role text,p_status text)
returns text language plpgsql set search_path = '' as $$
declare
  member public.users%rowtype;
  next_role text;
  next_status text;
begin
  if p_role is not null and p_role not in ('Admin','Operator','Promoter','Customer','Backer') or
     p_status is not null and p_status not in ('Active','Inactive') then return 'ROLE_INVALID'; end if;
  -- A shop row lock serializes all role changes for the shop.
  perform 1 from public.shops where shop_id = p_shop for update;
  if not exists (select 1 from public.users where shop_id=p_shop and uid=p_actor
    and status='Active' and role in ('Admin','Superadmin')) then return 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.shops where shop_id=p_shop and lower(status)='active')
    then return 'SHOP_NOT_AVAILABLE'; end if;
  select * into member from public.users where shop_id = p_shop and uid = p_uid for update;
  if not found then return 'MEMBER_NOT_FOUND'; end if;
  if member.role = 'Superadmin' then return 'PROTECTED_ROLE'; end if;
  next_role := coalesce(p_role,member.role);
  next_status := coalesce(p_status,member.status);
  if next_role is not distinct from member.role and next_status is not distinct from member.status then return 'SAVED'; end if;
  if member.role = 'Admin' and member.status = 'Active'
    and (next_role is distinct from 'Admin' or next_status is distinct from 'Active')
    and not exists (select 1 from public.users where shop_id = p_shop and uid <> p_uid and role = 'Admin' and status = 'Active')
  then return 'LAST_SHOP_ADMIN'; end if;
  update public.users set role = next_role, status = next_status,
    backer_share = case when next_role='Backer' and member.role is distinct from 'Backer' then 0 else member.backer_share end,
    backer_water_fee = case when next_role='Backer' and member.role is distinct from 'Backer' then 10 else member.backer_water_fee end
    where shop_id = p_shop and uid = p_uid;
  insert into public.shop_role_audit (shop_id,uid,actor_uid,old_role,new_role,old_status,new_status)
    values (p_shop,p_uid,p_actor,member.role,next_role,member.status,next_status);
  return 'SAVED';
end;
$$;

revoke all on function public.set_shop_member_access(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.set_shop_member_access(text,text,text,text,text) to service_role;

commit;

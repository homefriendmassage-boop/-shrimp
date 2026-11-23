alter table public.shops
  add column player_liff_override text
  check (player_liff_override = '' or player_liff_override ~ '^[0-9]+-[A-Za-z0-9]+$');

create unique index shops_player_liff_override_unique
  on public.shops ((split_part(player_liff_override, '-', 1)))
  where player_liff_override <> '';

create function public.guard_shop_player_liff_override()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.player_liff_override is not null then
        raise insufficient_privilege using message = 'Platform admin access required';
      end if;
    elsif new.player_liff_override is distinct from old.player_liff_override then
      raise insufficient_privilege using message = 'Platform admin access required';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_shop_player_liff_override
before insert or update of player_liff_override on public.shops
for each row execute function public.guard_shop_player_liff_override();

revoke execute on function public.guard_shop_player_liff_override() from public, anon, authenticated;

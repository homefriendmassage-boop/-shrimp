begin;

create or replace function shop_finance_private.require_bill_minimum() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op = 'UPDATE' and new.amount is not distinct from old.amount then return new; end if;
  if new.amount is null or new.amount < 100 then raise exception 'BET_MINIMUM'; end if;
  if mod(new.amount,100) is distinct from 0 then raise exception 'BET_WHOLE_HUNDREDS'; end if;
  return new;
end;
$$;

drop trigger require_bill_minimum on public.bets;
create trigger require_bill_minimum before insert or update of amount on public.bets
for each row execute function shop_finance_private.require_bill_minimum();

commit;

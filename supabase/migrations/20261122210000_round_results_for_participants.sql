-- Queue the result after settlement has written the final status of each bet.
create function public.queue_round_result_notice()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.round_notice_batches(round_id, shop_id, kind, batch_no, recipients)
  select new.round_id, new.shop_id, 'result', batch_no, array_agg(uid order by uid)
  from (
    select uid, ((row_number() over (order by uid) - 1) / 500)::int as batch_no
    from (
      select distinct player.uid
      from public.bets b
      left join public.tables t on b.cash_table and t.shop_id = b.shop_id and t.table_no = b.table_no
      -- Staff-entered cash bets record the operator as b.uid.
      cross join lateral (values (case when b.cash_table then t.guest_uid else b.uid end)) player(uid)
      where b.shop_id = new.shop_id and b.round_id = new.round_id
        and b.status in ('Win', 'Lose')
        and player.uid ~ '^U[0-9a-fA-F]{32}$'
        and public.resolve_shop_oa_recipient(new.shop_id, player.uid) is not null
    ) players
  ) batches
  group by batch_no
  on conflict do nothing;
  return new;
end;
$function$;

revoke execute on function public.queue_round_result_notice() from public, anon, authenticated;

create trigger queue_round_result_notice
after update of status on public.rounds
for each row
when (new.status = 'Ended' and old.status is distinct from new.status
      and new.result is not null and new.weight is not null)
execute function public.queue_round_result_notice();

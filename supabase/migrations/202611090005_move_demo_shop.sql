begin;
set local lock_timeout = '10s';

lock table public.shops in share row exclusive mode;

do $$
declare
  ref record;
  before_count bigint;
  after_count bigint;
begin
  if not exists (select 1 from public.shops where shop_id = 'SHOP_001') then
    raise exception 'SHOP_001 not found. No data changed.';
  end if;
  if exists (select 1 from public.shops where shop_id = 'SHOP_000') then
    raise exception 'SHOP_000 already exists. No data changed.';
  end if;

  -- Stop rather than silently overlook a composite reference added later.
  if exists (
    select 1 from pg_constraint
    where contype = 'f' and confrelid = 'public.shops'::regclass and cardinality(conkey) <> 1
  ) then
    raise exception 'A composite shops foreign key requires a migration review.';
  end if;

  -- Keep the entire shop row, including private settings. Change only ID and name.
  insert into public.shops
  select (jsonb_populate_record(null::public.shops, to_jsonb(s) ||
    jsonb_build_object('shop_id', 'SHOP_000', 'shop_name', 'บ่อกุ้ง DEMO'))).*
  from public.shops s where s.shop_id = 'SHOP_001';

  -- Include shop-scoped tables without a foreign key as well as all single-column
  -- references to shops.shop_id, including tables added after the original schema.
  for ref in
    with references_to_shop as (
      select c.conrelid::regclass as relation, src.attname as column_name
      from pg_constraint c
      join pg_attribute src on src.attrelid = c.conrelid and src.attnum = c.conkey[1]
      join pg_attribute dest on dest.attrelid = c.confrelid and dest.attnum = c.confkey[1]
      where c.contype = 'f' and c.confrelid = 'public.shops'::regclass
        and dest.attname = 'shop_id'
      union
      select t.oid::regclass, a.attname
      from pg_class t
      join pg_namespace n on n.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid
      where n.nspname = 'public' and t.relkind in ('r', 'p') and not t.relispartition
        and t.oid <> 'public.shops'::regclass and a.attname = 'shop_id'
        and not a.attisdropped and a.atttypid in ('text'::regtype, 'varchar'::regtype)
    )
    select relation, column_name from references_to_shop order by relation::text, column_name
  loop
    execute format('lock table %s in share row exclusive mode', ref.relation);
    execute format('select count(*) from %s where %I = %L', ref.relation, ref.column_name, 'SHOP_000')
      into before_count;
    if before_count <> 0 then
      raise exception 'Unexpected SHOP_000 rows in %. No data changed.', ref.relation;
    end if;
    execute format('select count(*) from %s where %I = %L', ref.relation, ref.column_name, 'SHOP_001')
      into before_count;
    if before_count = 0 then continue; end if;
    execute format('update %s set %I = %L where %I = %L',
      ref.relation, ref.column_name, 'SHOP_000', ref.column_name, 'SHOP_001');
    get diagnostics after_count = row_count;
    if after_count <> before_count then
      raise exception 'Row count changed unexpectedly in %. No data changed.', ref.relation;
    end if;
    raise notice '%: moved % rows', ref.relation, after_count;
  end loop;

  -- IDs of applications, rounds and users are preserved. Their dependent rows
  -- and existing Storage object paths continue to point to the original records.
  delete from public.shops where shop_id = 'SHOP_001';
end $$;

commit;

select s.shop_id, s.shop_name,
  (select count(*) from public.users where shop_id = s.shop_id) as users,
  (select count(*) from public.membership_applications where shop_id = s.shop_id) as applications,
  (select count(*) from public.tables where shop_id = s.shop_id) as tables
from public.shops s where s.shop_id in ('SHOP_000', 'SHOP_001');

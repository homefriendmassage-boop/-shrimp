alter table public.system_settings
  add column withdrawal_fee_mode text not null default 'deduct'
  check (withdrawal_fee_mode in ('deduct', 'none'));

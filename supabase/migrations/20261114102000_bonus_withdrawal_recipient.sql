begin;

alter table public.wallet_withdrawal_confirmations
  add column recipient_name text,
  add column destination_kind text not null default 'bank',
  add column staff_notice_key uuid not null default gen_random_uuid(),
  add column staff_notice_sent_at timestamptz,
  add constraint withdrawal_recipient_format check (
    (recipient_name is null or length(btrim(recipient_name)) between 1 and 120)
    and (
      (destination_kind = 'bank' and bank_code <> '000')
      or (destination_kind = 'promptpay' and wallet_kind = 'bonus' and bank_code = '000'
          and bank_number ~ '^(0[0-9]{9}|[0-9]{13}|[0-9]{15})$')
    )
  ) not valid;

commit;

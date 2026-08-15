-- =====================================================================
-- CraveNG — WhatsApp order notification migration
--
-- ADDITIVE ONLY. This does not drop, rename or alter any existing column,
-- table, policy or row. Run it in Supabase -> SQL Editor -> New query.
-- Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- VENDORS
-- cng_vendors.whatsapp already exists in the current schema, so nothing
-- is added here. This block only backfills it from the phone column for
-- kitchens that have not set a WhatsApp number yet, so no vendor is
-- unreachable when notifications go live.
-- ---------------------------------------------------------------------
update public.cng_vendors
   set whatsapp = phone
 where (whatsapp is null or whatsapp = '')
   and phone is not null;

-- ---------------------------------------------------------------------
-- ORDERS — notification bookkeeping and status timestamps
-- ---------------------------------------------------------------------
alter table public.cng_orders
  add column if not exists whatsapp_notification_status text
      not null default 'pending'
      check (whatsapp_notification_status in ('pending','sent','failed','skipped')),
  add column if not exists whatsapp_message_id   text,
  add column if not exists whatsapp_error        text,
  add column if not exists whatsapp_attempts     int not null default 0,
  add column if not exists whatsapp_last_try_at  timestamptz,
  -- status timestamps, so the customer tracker can show when each step happened
  add column if not exists accepted_at           timestamptz,
  add column if not exists rejected_at           timestamptz,
  add column if not exists preparing_at          timestamptz,
  add column if not exists ready_at              timestamptz,
  add column if not exists out_for_delivery_at   timestamptz,
  add column if not exists delivered_at          timestamptz,
  add column if not exists cancelled_at          timestamptz;

create index if not exists cng_orders_wa_status_idx
  on public.cng_orders (whatsapp_notification_status)
  where whatsapp_notification_status <> 'sent';

-- ---------------------------------------------------------------------
-- NOTIFICATION LOG — one row per send attempt, for retries and auditing
-- ---------------------------------------------------------------------
create table if not exists public.cng_notifications (
  id          bigserial primary key,
  order_id    text references public.cng_orders(id) on delete cascade,
  vendor_id   text references public.cng_vendors(id) on delete set null,
  channel     text not null default 'whatsapp',
  direction   text not null default 'outbound',
  recipient   text,
  template    text,
  body        text,
  status      text not null default 'pending'
              check (status in ('pending','sent','failed','skipped')),
  provider_id text,
  error       text,
  test_mode   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists cng_notif_order_idx on public.cng_notifications (order_id, created_at desc);

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Matches the demo policy style already used by the other tables.
-- The hardening notes in supabase-schema.sql apply here too.
-- ---------------------------------------------------------------------
alter table public.cng_notifications enable row level security;

drop policy if exists cng_notifications_demo_all on public.cng_notifications;
create policy cng_notifications_demo_all
  on public.cng_notifications for all using (true) with check (true);

-- ---------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'cng_orders'
   and (column_name like 'whatsapp%' or column_name ~ '_at$')
 order by column_name;

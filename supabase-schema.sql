-- =====================================================================
-- CraveNG — database schema
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> New query -> paste ALL of this
--   -> Run.  It is idempotent: running it twice is safe.
--
-- These table and column names match what the CraveNG code already
-- sends. Do not rename anything without changing the app to match.
-- =====================================================================

-- ---------------------------------------------------------------------
-- cng_settings — platform config, homepage copy, admin flags
-- (key/value, because settings are naturally a bag of options)
-- ---------------------------------------------------------------------
create table if not exists public.cng_settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- cng_vendors — the kitchens
-- ---------------------------------------------------------------------
create table if not exists public.cng_vendors (
  id            text primary key,          -- 'v0', 'v1', ...
  vendor_id     text unique not null,      -- 'CNG-V01'
  name          text not null,
  email         text,
  password      text,                      -- DEMO ONLY — see hardening notes
  phone         text,
  whatsapp      text,
  area          text,
  category      text,
  about         text,
  address       text,
  open_hour     int     default 9,
  close_hour    int     default 21,
  prep_minutes  int     default 25,
  delivery_fee  int,                       -- null = use the platform default
  min_order     int,
  open_now      boolean not null default true,   -- vendor OPEN/CLOSED switch
  active        boolean not null default true,   -- admin suspend/reactivate
  removed       boolean not null default false,  -- admin soft delete
  settings      jsonb   default '{}'::jsonb,     -- per-kitchen overrides
  updated_at    timestamptz not null default now()
);
create index if not exists cng_vendors_area_idx     on public.cng_vendors (area);
create index if not exists cng_vendors_category_idx on public.cng_vendors (category);

-- ---------------------------------------------------------------------
-- cng_menu_items — dishes, one row per kitchen per dish
-- The unique key is what makes menu saves upsert instead of duplicating.
-- ---------------------------------------------------------------------
create table if not exists public.cng_menu_items (
  id          bigserial primary key,
  vendor_id   text not null references public.cng_vendors(id) on delete cascade,
  name        text not null,
  description text,
  price       int  not null default 0,
  available   boolean not null default true,
  position    int  not null default 0,
  updated_at  timestamptz not null default now(),
  unique (vendor_id, name)
);
create index if not exists cng_menu_vendor_idx on public.cng_menu_items (vendor_id, position);

-- ---------------------------------------------------------------------
-- cng_customers — guest checkout, so customers are keyed by phone number
-- ---------------------------------------------------------------------
create table if not exists public.cng_customers (
  phone       text primary key,
  name        text,
  address     text,
  landmark    text,
  order_count int not null default 0,
  total_spent int not null default 0,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- cng_orders
-- ---------------------------------------------------------------------
create table if not exists public.cng_orders (
  id             text primary key,          -- 'CNG-260806-0001'
  vendor_id      text references public.cng_vendors(id) on delete set null,
  vendor_name    text,
  vendor_area    text,
  customer_name  text,
  customer_phone text,
  address        text,
  landmark       text,
  notes          text,
  items          jsonb not null default '[]'::jsonb,
  subtotal       int not null default 0,
  delivery_fee   int not null default 0,
  total          int not null default 0,
  pay_method     text default 'pod',        -- card | transfer | pod
  pay_status     text default 'Pending',    -- Paid | Pending
  status         text not null default 'Pending',
  mode           text not null default 'now',   -- now | pre
  scheduled_date date,
  scheduled_time text,
  history        jsonb not null default '[]'::jsonb,
  placed_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists cng_orders_vendor_idx on public.cng_orders (vendor_id, placed_at desc);
create index if not exists cng_orders_placed_idx on public.cng_orders (placed_at desc);
create index if not exists cng_orders_status_idx on public.cng_orders (status);
create index if not exists cng_orders_phone_idx  on public.cng_orders (customer_phone);

-- ---------------------------------------------------------------------
-- cng_reviews
-- ---------------------------------------------------------------------
create table if not exists public.cng_reviews (
  id         bigserial primary key,
  vendor_id  text not null references public.cng_vendors(id) on delete cascade,
  author     text default 'Customer',
  stars      int  not null check (stars between 1 and 5),
  message    text,
  state      text not null default 'visible',   -- visible | hidden | deleted
  created_at timestamptz not null default now()
);
create index if not exists cng_reviews_vendor_idx on public.cng_reviews (vendor_id, created_at desc);

-- ---------------------------------------------------------------------
-- keep updated_at honest on edits
-- ---------------------------------------------------------------------
create or replace function public.cng_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists cng_orders_touch on public.cng_orders;
create trigger cng_orders_touch before update on public.cng_orders
  for each row execute function public.cng_touch();

drop trigger if exists cng_vendors_touch on public.cng_vendors;
create trigger cng_vendors_touch before update on public.cng_vendors
  for each row execute function public.cng_touch();

-- =====================================================================
-- ROW LEVEL SECURITY
--
-- RLS is ON for every table. The policies below are DEMO-GRADE: anyone
-- holding the publishable key can read and write everything. That is
-- acceptable while you test, and NOT acceptable once real customer phone
-- numbers and real money are involved — the key is visible in page source.
--
-- The hardening checklist is at the foot of this file.
-- =====================================================================
alter table public.cng_settings   enable row level security;
alter table public.cng_vendors    enable row level security;
alter table public.cng_menu_items enable row level security;
alter table public.cng_customers  enable row level security;
alter table public.cng_orders     enable row level security;
alter table public.cng_reviews    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cng_settings','cng_vendors','cng_menu_items',
                           'cng_customers','cng_orders','cng_reviews']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_demo_all', t);
    execute format('create policy %I on public.%I for all using (true) with check (true)',
                   t || '_demo_all', t);
  end loop;
end $$;

-- =====================================================================
-- VERIFY — every table should be listed, all with 0 rows on a fresh run
-- =====================================================================
select table_name
from information_schema.tables
where table_schema = 'public' and table_name like 'cng_%'
order by table_name;

-- =====================================================================
-- HARDENING CHECKLIST — before real customers
--
-- 1. cng_vendors.password holds plain text so the demo login works.
--    Replace with Supabase Auth and DROP the column:
--      alter table public.cng_vendors drop column password;
--
-- 2. Replace the demo policies with real ones, e.g.
--      create policy vendors_public_read on public.cng_vendors
--        for select using (removed = false);
--      create policy orders_owner_rw on public.cng_orders
--        for all using (vendor_id = auth.jwt() ->> 'vendor_id');
--    then: drop policy cng_orders_demo_all on public.cng_orders;
--
-- 3. cng_customers and cng_orders hold personal data (names, phone
--    numbers, home addresses). Once auth exists, restrict select to the
--    owning kitchen and to admins.
-- =====================================================================

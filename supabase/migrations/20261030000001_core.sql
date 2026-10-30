-- Liyana's Closet: core schema
-- Every household-owned row carries household_id and is protected by RLS.
-- Stock and money-changing writes go through SECURITY DEFINER functions so the
-- arithmetic rules (no negative stock, no spending from corrections, gifts not
-- counted as spending, idempotent submissions) live in one place.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Households and membership
-- ---------------------------------------------------------------------------
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  monthly_budget_cents bigint check (monthly_budget_cents is null or monthly_budget_cents >= 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  version integer not null default 1
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  role text not null default 'parent' check (role in ('owner', 'parent')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id),
  -- one household per account keeps "my household" unambiguous
  unique (user_id)
);

create table public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  token_hash text not null unique,
  invited_email text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  revoked_at timestamptz
);

create or replace function public.is_household_member(hh uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hh and m.user_id = auth.uid()
  );
$$;

create or replace function public.my_household_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select household_id from public.household_members where user_id = auth.uid();
$$;

create or replace function public.member_name(hh uuid, uid uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select display_name from public.household_members where household_id = hh and user_id = uid;
$$;

-- ---------------------------------------------------------------------------
-- Items (registry + inventory)
-- ---------------------------------------------------------------------------
create table public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  brand text,
  model text,
  size text,
  color text,
  category text not null default 'Other',
  unit text not null default 'item' check (char_length(unit) between 1 and 30),
  required_qty integer check (required_qty is null or required_qty >= 0),
  is_consumable boolean not null default false,
  -- NULL means "unknown"; unknown stock never produces an out-of-stock alert
  stock_qty integer check (stock_qty is null or stock_qty >= 0),
  low_stock_threshold integer check (low_stock_threshold is null or low_stock_threshold >= 0),
  -- an estimate for planning only; never counted as spending
  estimated_price_cents bigint check (estimated_price_cents is null or estimated_price_cents >= 0),
  photo_path text,           -- object in the item-photos bucket
  photo_url text,            -- direct image URL (user-provided or picked from product search)
  photo_source_url text,     -- product page the photo came from
  photo_source_name text,
  notes text,
  needs_review boolean not null default false,
  review_note text,
  master_no integer,
  import_key text,
  priority smallint not null default 0,
  archived_at timestamptz,
  version integer not null default 1,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, import_key)
);
create index items_household_idx on public.items (household_id);

-- ---------------------------------------------------------------------------
-- Purchases, gifts, stock events
-- ---------------------------------------------------------------------------
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id),
  qty integer not null check (qty > 0),               -- in the item's unit (120 diapers, not 1 pack)
  pack_count integer check (pack_count is null or pack_count > 0),
  units_per_pack integer check (units_per_pack is null or units_per_pack > 0),
  purchased_on date,                                   -- NULL = undated (never invented)
  amount_cents bigint not null check (amount_cents >= 0), -- whole amount incl. tax/shipping
  retailer text,
  buyer_user_id uuid references auth.users(id),
  buyer_label text,                                    -- e.g. "Unknown (imported)"
  notes text,
  source text not null default 'manual' check (source in ('manual', 'import', 'ai')),
  import_key text,
  client_request_id uuid not null,
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  version integer not null default 1,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, client_request_id),
  unique (household_id, import_key)
);
create index purchases_household_idx on public.purchases (household_id, purchased_on);

create table public.gifts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id),
  qty integer not null check (qty > 0),
  received_on date,
  giver text,
  notes text,
  client_request_id uuid not null,
  voided_at timestamptz,
  version integer not null default 1,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (household_id, client_request_id)
);

create table public.stock_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id),
  kind text not null check (kind in ('purchase', 'gift', 'usage', 'correction', 'starting', 'void')),
  delta integer not null,
  stock_before integer,
  stock_after integer not null check (stock_after >= 0),
  purchase_id uuid references public.purchases(id),
  gift_id uuid references public.gifts(id),
  note text,
  occurred_on date not null default (now() at time zone 'America/New_York')::date,
  client_request_id uuid not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (household_id, client_request_id)
);
create index stock_events_item_idx on public.stock_events (item_id, created_at);

-- Who changed what and when, for everything in the household.
create table public.activity_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  actor uuid references auth.users(id),
  entity text not null,
  entity_id uuid,
  action text not null,
  summary text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
create index activity_household_idx on public.activity_log (household_id, created_at desc);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  file_fingerprint text not null,
  file_name text,
  items_created integer not null,
  purchases_created integer not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (household_id, file_fingerprint)
);

-- ---------------------------------------------------------------------------
-- Alerts / push
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Last stock level we notified about per item; prevents duplicate pushes.
create table public.alert_state (
  item_id uuid primary key references public.items(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  level text not null check (level in ('ok', 'low', 'out', 'unknown')),
  changed_at timestamptz not null default now()
);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid references public.items(id) on delete cascade,
  level text not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  result jsonb
);

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_touch_version()
returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  if tg_table_name in ('items', 'purchases') then
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end $$;

create trigger items_version before update on public.items
  for each row execute function public.tg_touch_version();
create trigger purchases_version before update on public.purchases
  for each row execute function public.tg_touch_version();
create trigger gifts_version before update on public.gifts
  for each row execute function public.tg_touch_version();
create trigger households_version before update on public.households
  for each row execute function public.tg_touch_version();

-- Stock may only change through the stock functions below.
create or replace function public.tg_guard_stock()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.stock_write', true), '') <> 'on' then
    if tg_op = 'INSERT' and new.stock_qty is not null then
      raise exception 'Set starting stock with set_starting_stock()' using errcode = 'P0001';
    elsif tg_op = 'UPDATE' and new.stock_qty is distinct from old.stock_qty then
      raise exception 'Stock can only change through purchases, gifts, usage, or corrections' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  else
    -- audit and ownership fields are immutable from the client
    if new.household_id <> old.household_id then
      raise exception 'Items cannot move between households' using errcode = 'P0001';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.import_key := old.import_key;
  end if;
  return new;
end $$;

create trigger items_guard_stock before insert or update on public.items
  for each row execute function public.tg_guard_stock();

create or replace function public.tg_item_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  changed text[];
begin
  if tg_op = 'INSERT' then
    insert into activity_log (household_id, actor, entity, entity_id, action, summary)
    values (new.household_id, auth.uid(), 'item', new.id, 'create', 'Added ' || new.name);
  elsif tg_op = 'UPDATE' then
    select array_agg(key) into changed
    from jsonb_each(to_jsonb(new)) n
    where n.key not in ('version', 'updated_at', 'updated_by', 'stock_qty')
      and n.value is distinct from (to_jsonb(old) -> n.key);
    if changed is not null then
      insert into activity_log (household_id, actor, entity, entity_id, action, summary, details)
      values (new.household_id, auth.uid(), 'item', new.id,
              case when new.archived_at is not null and old.archived_at is null then 'archive'
                   when new.archived_at is null and old.archived_at is not null then 'unarchive'
                   else 'edit' end,
              case when new.archived_at is not null and old.archived_at is null then 'Archived ' || new.name
                   when new.archived_at is null and old.archived_at is not null then 'Restored ' || new.name
                   else 'Edited ' || new.name || ' (' || array_to_string(changed, ', ') || ')' end,
              jsonb_build_object('fields', changed));
    end if;
  end if;
  return null;
end $$;

create trigger items_activity after insert or update on public.items
  for each row execute function public.tg_item_activity();

-- Recompute alert level after any stock or threshold change; queue a push only
-- when the level worsens into low/out and differs from the last level notified.
create or replace function public.stock_level(stock integer, threshold integer, consumable boolean)
returns text language sql immutable as $$
  select case
    when not consumable or stock is null then 'unknown'
    when stock = 0 then 'out'
    when threshold is not null and stock <= threshold then 'low'
    else 'ok'
  end;
$$;

create or replace function public.tg_alert_state()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  lvl text := stock_level(new.stock_qty, new.low_stock_threshold, new.is_consumable);
  prev text;
begin
  if new.archived_at is not null then
    lvl := 'unknown';
  end if;
  select level into prev from alert_state where item_id = new.id for update;
  if prev is not distinct from lvl then
    return null;
  end if;
  insert into alert_state (item_id, household_id, level, changed_at)
  values (new.id, new.household_id, lvl, now())
  on conflict (item_id) do update set level = excluded.level, changed_at = now();
  if lvl in ('low', 'out') then
    insert into notification_outbox (household_id, item_id, level, title, body)
    values (new.household_id, new.id, lvl,
            case lvl when 'out' then 'Out of ' || new.name else 'Running low: ' || new.name end,
            new.stock_qty || ' ' || new.unit || ' left' ||
              coalesce(' (alert at ' || new.low_stock_threshold || ')', ''));
  end if;
  return null;
end $$;

create trigger items_alert_state after insert or update of stock_qty, low_stock_threshold, is_consumable, archived_at
  on public.items for each row execute function public.tg_alert_state();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.items enable row level security;
alter table public.purchases enable row level security;
alter table public.gifts enable row level security;
alter table public.stock_events enable row level security;
alter table public.activity_log enable row level security;
alter table public.imports enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.alert_state enable row level security;
alter table public.notification_outbox enable row level security;

create policy "members read household" on public.households
  for select using (public.is_household_member(id));
create policy "members update household" on public.households
  for update using (public.is_household_member(id)) with check (public.is_household_member(id));

create policy "members read members" on public.household_members
  for select using (public.is_household_member(household_id));
create policy "member edits own name" on public.household_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "members read invites" on public.household_invites
  for select using (public.is_household_member(household_id));

create policy "members read items" on public.items
  for select using (public.is_household_member(household_id));
create policy "members add items" on public.items
  for insert with check (public.is_household_member(household_id));
create policy "members edit items" on public.items
  for update using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
-- no delete policy: items are archived, never erased

create policy "members read purchases" on public.purchases
  for select using (public.is_household_member(household_id));
create policy "members read gifts" on public.gifts
  for select using (public.is_household_member(household_id));
create policy "members read stock events" on public.stock_events
  for select using (public.is_household_member(household_id));
create policy "members read activity" on public.activity_log
  for select using (public.is_household_member(household_id));
create policy "members read imports" on public.imports
  for select using (public.is_household_member(household_id));
create policy "members read alert state" on public.alert_state
  for select using (public.is_household_member(household_id));

create policy "own push subscriptions" on public.push_subscriptions
  for all using (user_id = auth.uid() and public.is_household_member(household_id))
  with check (user_id = auth.uid() and public.is_household_member(household_id));
-- notification_outbox: no client policies; only the push function (service role) reads it.


-- Realtime for prompt sync between the two phones
alter publication supabase_realtime add table public.items, public.purchases, public.gifts,
  public.stock_events, public.households, public.household_members;

-- Liyana's Closet: household, inventory, purchase, import, and reporting functions.
-- All are SECURITY DEFINER and check membership explicitly; RLS stays on for reads.

create or replace function public.require_member(hh uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if not is_household_member(hh) then
    raise exception 'Not a member of this household' using errcode = '42501';
  end if;
end $$;

create or replace function public.today_ny()
returns date language sql stable as $$
  select (now() at time zone 'America/New_York')::date;
$$;

-- ---------------------------------------------------------------------------
-- Household setup and invitations
-- ---------------------------------------------------------------------------
create or replace function public.create_household(p_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  hh uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if exists (select 1 from household_members where user_id = auth.uid()) then
    raise exception 'You already belong to a household' using errcode = 'P0001';
  end if;
  insert into households (name, created_by) values (trim(p_name), auth.uid()) returning id into hh;
  insert into household_members (household_id, user_id, display_name, role)
  values (hh, auth.uid(), trim(p_display_name), 'owner');
  insert into activity_log (household_id, actor, entity, entity_id, action, summary)
  values (hh, auth.uid(), 'household', hh, 'create', trim(p_display_name) || ' created the household');
  return hh;
end $$;

-- Returns the plaintext token once; only its SHA-256 hash is stored.
create or replace function public.create_invite(p_email text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  hh uuid := my_household_id();
  tok text;
begin
  perform require_member(hh);
  if (select count(*) from household_invites
      where household_id = hh and accepted_at is null and revoked_at is null and expires_at > now()) >= 5 then
    raise exception 'Too many open invitations; revoke one first' using errcode = 'P0001';
  end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into household_invites (household_id, token_hash, invited_email, created_by)
  values (hh, encode(digest(tok, 'sha256'), 'hex'), nullif(lower(trim(p_email)), ''), auth.uid());
  insert into activity_log (household_id, actor, entity, action, summary)
  values (hh, auth.uid(), 'invite', 'create', 'Created a partner invitation');
  return tok;
end $$;

create or replace function public.revoke_invite(p_invite_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  hh uuid;
begin
  select household_id into hh from household_invites where id = p_invite_id;
  perform require_member(hh);
  update household_invites set revoked_at = now() where id = p_invite_id and accepted_at is null;
end $$;

create or replace function public.accept_invite(p_token text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  inv household_invites;
  user_email text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  select * into inv from household_invites
  where token_hash = encode(digest(trim(p_token), 'sha256'), 'hex')
  for update;
  if not found or inv.revoked_at is not null or inv.expires_at < now() then
    raise exception 'This invitation is invalid or has expired' using errcode = 'P0001';
  end if;
  if inv.accepted_at is not null then
    if inv.accepted_by = auth.uid() then
      return inv.household_id; -- idempotent re-tap
    end if;
    raise exception 'This invitation has already been used' using errcode = 'P0001';
  end if;
  if exists (select 1 from household_members where user_id = auth.uid()) then
    raise exception 'You already belong to a household' using errcode = 'P0001';
  end if;
  if inv.invited_email is not null then
    select lower(email) into user_email from auth.users where id = auth.uid();
    if user_email is distinct from inv.invited_email then
      raise exception 'This invitation was sent to a different email address' using errcode = 'P0001';
    end if;
  end if;
  insert into household_members (household_id, user_id, display_name, role)
  values (inv.household_id, auth.uid(), trim(p_display_name), 'parent');
  update household_invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  insert into activity_log (household_id, actor, entity, action, summary)
  values (inv.household_id, auth.uid(), 'household', 'join', trim(p_display_name) || ' joined the household');
  return inv.household_id;
end $$;

create or replace function public.remove_member(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  hh uuid := my_household_id();
begin
  perform require_member(hh);
  if not exists (select 1 from household_members where household_id = hh and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the household owner can remove members' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'The owner cannot remove themselves' using errcode = 'P0001';
  end if;
  delete from household_members where household_id = hh and user_id = p_user_id;
  delete from push_subscriptions where household_id = hh and user_id = p_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- Stock primitives
-- ---------------------------------------------------------------------------
-- Applies a relative delta under a row lock, so two phones logging usage at the
-- same moment both count (no lost update) and stock never goes negative.
create or replace function public._apply_stock(
  p_item_id uuid, p_kind text, p_delta integer, p_request uuid, p_note text,
  p_purchase uuid default null, p_gift uuid default null, p_occurred date default null,
  p_absolute integer default null
) returns stock_events language plpgsql security definer set search_path = public as $$
declare
  it items;
  before_qty integer;
  after_qty integer;
  ev stock_events;
begin
  select * into it from items where id = p_item_id for update;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  before_qty := it.stock_qty;
  if p_absolute is not null then
    after_qty := p_absolute;
  elsif before_qty is null then
    if p_kind in ('purchase', 'gift') then
      -- Tracking starts with this addition; the note makes that explicit.
      after_qty := p_delta;
      p_note := concat_ws(' ', p_note, '(stock was unknown before this; tracking starts here)');
    else
      raise exception 'Set the current stock for % before logging %', it.name, p_kind using errcode = 'P0001';
    end if;
  else
    after_qty := before_qty + p_delta;
  end if;
  if after_qty < 0 then
    raise exception 'Not enough stock: % has % %, cannot remove %', it.name, before_qty, it.unit, -p_delta
      using errcode = 'P0001';
  end if;
  perform set_config('app.stock_write', 'on', true);
  update items set stock_qty = after_qty where id = p_item_id;
  perform set_config('app.stock_write', 'off', true);
  insert into stock_events (household_id, item_id, kind, delta, stock_before, stock_after,
                            purchase_id, gift_id, note, occurred_on, client_request_id, created_by)
  values (it.household_id, p_item_id, p_kind, after_qty - coalesce(before_qty, 0), before_qty, after_qty,
          p_purchase, p_gift, p_note, coalesce(p_occurred, today_ny()), p_request, auth.uid())
  returning * into ev;
  return ev;
end $$;
revoke execute on function public._apply_stock from public, anon, authenticated;

create or replace function public.set_starting_stock(p_item_id uuid, p_qty integer, p_request uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it items;
  ev stock_events;
begin
  select * into it from items where id = p_item_id;
  perform require_member(it.household_id);
  select * into ev from stock_events where household_id = it.household_id and client_request_id = p_request;
  if found then
    return jsonb_build_object('duplicate', true, 'stock_after', ev.stock_after);
  end if;
  if not it.is_consumable then
    raise exception 'Stock tracking is only for consumables' using errcode = 'P0001';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'Stock cannot be negative' using errcode = 'P0001';
  end if;
  ev := _apply_stock(p_item_id, case when it.stock_qty is null then 'starting' else 'correction' end,
                     0, p_request, p_note, null, null, null, p_qty);
  insert into activity_log (household_id, actor, entity, entity_id, action, summary)
  values (it.household_id, auth.uid(), 'stock', it.id, ev.kind,
          case ev.kind when 'starting' then 'Set starting stock of ' || it.name || ' to ' || p_qty
               else 'Corrected ' || it.name || ' stock from ' || coalesce(ev.stock_before::text, '?') || ' to ' || p_qty end);
  return jsonb_build_object('duplicate', false, 'stock_after', ev.stock_after);
end $$;

-- Correction to an absolute count. p_expected_stock guards against correcting
-- a number the partner has just changed (optimistic concurrency).
create or replace function public.correct_stock(p_item_id uuid, p_new_qty integer, p_expected_stock integer,
                                                p_request uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it items;
  ev stock_events;
begin
  select * into it from items where id = p_item_id;
  perform require_member(it.household_id);
  select * into ev from stock_events where household_id = it.household_id and client_request_id = p_request;
  if found then
    return jsonb_build_object('duplicate', true, 'stock_after', ev.stock_after);
  end if;
  if it.stock_qty is distinct from p_expected_stock then
    raise exception 'Stock changed to % while you were editing. Review and try again.', coalesce(it.stock_qty::text, 'unknown')
      using errcode = '40001';
  end if;
  return set_starting_stock(p_item_id, p_new_qty, p_request, p_note);
end $$;

create or replace function public.log_usage(p_item_id uuid, p_qty integer, p_request uuid,
                                            p_used_on date default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it items;
  ev stock_events;
begin
  select * into it from items where id = p_item_id;
  perform require_member(it.household_id);
  select * into ev from stock_events where household_id = it.household_id and client_request_id = p_request;
  if found then
    return jsonb_build_object('duplicate', true, 'stock_after', ev.stock_after);
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'Usage must be at least 1' using errcode = 'P0001';
  end if;
  if p_used_on is not null and p_used_on > today_ny() then
    raise exception 'Usage date cannot be in the future' using errcode = 'P0001';
  end if;
  ev := _apply_stock(p_item_id, 'usage', -p_qty, p_request, p_note, null, null, p_used_on);
  insert into activity_log (household_id, actor, entity, entity_id, action, summary)
  values (it.household_id, auth.uid(), 'stock', it.id, 'usage',
          'Used ' || p_qty || ' ' || it.unit || ' of ' || it.name || ' (' || ev.stock_after || ' left)');
  return jsonb_build_object('duplicate', false, 'stock_after', ev.stock_after);
end $$;

-- ---------------------------------------------------------------------------
-- Purchases and gifts
-- ---------------------------------------------------------------------------
create or replace function public.record_purchase(
  p_item_id uuid, p_qty integer, p_amount_cents bigint, p_request uuid,
  p_purchased_on date default null, p_retailer text default null, p_buyer_user_id uuid default null,
  p_buyer_label text default null, p_notes text default null, p_pack_count integer default null,
  p_units_per_pack integer default null, p_source text default 'manual'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it items;
  pu purchases;
  ev stock_events;
begin
  select * into it from items where id = p_item_id;
  perform require_member(it.household_id);
  select * into pu from purchases where household_id = it.household_id and client_request_id = p_request;
  if found then
    return jsonb_build_object('duplicate', true, 'purchase_id', pu.id);
  end if;
  if p_pack_count is not null and p_units_per_pack is not null and p_qty <> p_pack_count * p_units_per_pack then
    raise exception 'Quantity must equal packs × units per pack' using errcode = 'P0001';
  end if;
  if p_purchased_on is not null and p_purchased_on > today_ny() then
    raise exception 'Purchase date cannot be in the future' using errcode = 'P0001';
  end if;
  if p_buyer_user_id is not null and not exists (
       select 1 from household_members where household_id = it.household_id and user_id = p_buyer_user_id) then
    raise exception 'Buyer must be a household member' using errcode = 'P0001';
  end if;
  insert into purchases (household_id, item_id, qty, pack_count, units_per_pack, purchased_on, amount_cents,
                         retailer, buyer_user_id, buyer_label, notes, source, client_request_id, created_by, updated_by)
  values (it.household_id, p_item_id, p_qty, p_pack_count, p_units_per_pack, p_purchased_on, p_amount_cents,
          nullif(trim(p_retailer), ''), p_buyer_user_id, nullif(trim(p_buyer_label), ''), nullif(trim(p_notes), ''),
          coalesce(p_source, 'manual'), p_request, auth.uid(), auth.uid())
  returning * into pu;
  if it.is_consumable then
    ev := _apply_stock(p_item_id, 'purchase', p_qty, gen_random_uuid(), 'Purchase', pu.id, null, p_purchased_on);
  end if;
  insert into activity_log (household_id, actor, entity, entity_id, action, summary, details)
  values (it.household_id, auth.uid(), 'purchase', pu.id, 'create',
          'Bought ' || p_qty || ' ' || it.unit || ' of ' || it.name || ' for $' || to_char(p_amount_cents / 100.0, 'FM999999990.00')
            || case when p_purchased_on is null then ' (undated)' else '' end,
          jsonb_build_object('item_id', it.id));
  return jsonb_build_object('duplicate', false, 'purchase_id', pu.id, 'stock_after', ev.stock_after);
end $$;

-- Edit a purchase. Quantity changes adjust consumable stock by the difference.
create or replace function public.update_purchase(
  p_purchase_id uuid, p_expected_version integer, p_qty integer, p_amount_cents bigint,
  p_purchased_on date, p_retailer text, p_buyer_user_id uuid, p_buyer_label text, p_notes text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pu purchases;
  it items;
  diff integer;
begin
  select * into pu from purchases where id = p_purchase_id for update;
  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;
  perform require_member(pu.household_id);
  if pu.version <> p_expected_version then
    raise exception 'This purchase was changed by someone else. Reload to see the latest.' using errcode = '40001';
  end if;
  if pu.voided_at is not null then
    raise exception 'This purchase was removed' using errcode = 'P0001';
  end if;
  if p_purchased_on is not null and p_purchased_on > today_ny() then
    raise exception 'Purchase date cannot be in the future' using errcode = 'P0001';
  end if;
  if p_qty is null or p_qty <= 0 or p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'Quantity must be positive and amount cannot be negative' using errcode = 'P0001';
  end if;
  select * into it from items where id = pu.item_id;
  diff := p_qty - pu.qty;
  if diff <> 0 and it.is_consumable and it.stock_qty is not null then
    perform _apply_stock(it.id, case when diff > 0 then 'purchase' else 'correction' end, diff,
                         gen_random_uuid(), 'Purchase quantity edited from ' || pu.qty || ' to ' || p_qty, pu.id);
  end if;
  update purchases set qty = p_qty, amount_cents = p_amount_cents, purchased_on = p_purchased_on,
         retailer = nullif(trim(p_retailer), ''), buyer_user_id = p_buyer_user_id,
         buyer_label = nullif(trim(p_buyer_label), ''), notes = nullif(trim(p_notes), ''),
         pack_count = case when diff = 0 then pack_count end,
         units_per_pack = case when diff = 0 then units_per_pack end
  where id = p_purchase_id;
  insert into activity_log (household_id, actor, entity, entity_id, action, summary, details)
  values (pu.household_id, auth.uid(), 'purchase', pu.id, 'edit', 'Edited purchase of ' || it.name,
          jsonb_build_object('before', jsonb_build_object('qty', pu.qty, 'amount_cents', pu.amount_cents,
                                                          'purchased_on', pu.purchased_on, 'retailer', pu.retailer),
                             'after', jsonb_build_object('qty', p_qty, 'amount_cents', p_amount_cents,
                                                         'purchased_on', p_purchased_on, 'retailer', p_retailer)));
  return jsonb_build_object('ok', true);
end $$;

-- Soft-delete: spending stops counting it, history keeps it.
create or replace function public.void_purchase(p_purchase_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pu purchases;
  it items;
begin
  select * into pu from purchases where id = p_purchase_id for update;
  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;
  perform require_member(pu.household_id);
  if pu.voided_at is not null then
    return jsonb_build_object('duplicate', true);
  end if;
  select * into it from items where id = pu.item_id;
  if it.is_consumable and it.stock_qty is not null then
    perform _apply_stock(it.id, 'void', -pu.qty, gen_random_uuid(), 'Purchase removed', pu.id);
  end if;
  update purchases set voided_at = now(), voided_by = auth.uid(),
         notes = concat_ws(' · ', notes, 'Removed: ' || coalesce(nullif(trim(p_reason), ''), 'no reason given'))
  where id = p_purchase_id;
  insert into activity_log (household_id, actor, entity, entity_id, action, summary)
  values (pu.household_id, auth.uid(), 'purchase', pu.id, 'void',
          'Removed purchase of ' || it.name || ' ($' || to_char(pu.amount_cents / 100.0, 'FM999999990.00') || ')');
  return jsonb_build_object('duplicate', false);
end $$;

create or replace function public.record_gift(
  p_item_id uuid, p_qty integer, p_request uuid, p_received_on date default null,
  p_giver text default null, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it items;
  g gifts;
  ev stock_events;
begin
  select * into it from items where id = p_item_id;
  perform require_member(it.household_id);
  select * into g from gifts where household_id = it.household_id and client_request_id = p_request;
  if found then
    return jsonb_build_object('duplicate', true, 'gift_id', g.id);
  end if;
  if p_received_on is not null and p_received_on > today_ny() then
    raise exception 'Gift date cannot be in the future' using errcode = 'P0001';
  end if;
  insert into gifts (household_id, item_id, qty, received_on, giver, notes, client_request_id, created_by)
  values (it.household_id, p_item_id, p_qty, p_received_on, nullif(trim(p_giver), ''), nullif(trim(p_notes), ''),
          p_request, auth.uid())
  returning * into g;
  if it.is_consumable then
    ev := _apply_stock(p_item_id, 'gift', p_qty, gen_random_uuid(), 'Gift', null, g.id, p_received_on);
  end if;
  insert into activity_log (household_id, actor, entity, entity_id, action, summary)
  values (it.household_id, auth.uid(), 'gift', g.id, 'create',
          'Received ' || p_qty || ' ' || it.unit || ' of ' || it.name || coalesce(' from ' || g.giver, '') || ' as a gift');
  return jsonb_build_object('duplicate', false, 'gift_id', g.id, 'stock_after', ev.stock_after);
end $$;

create or replace function public.void_gift(p_gift_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  g gifts;
  it items;
begin
  select * into g from gifts where id = p_gift_id for update;
  if not found then
    raise exception 'Gift not found' using errcode = 'P0002';
  end if;
  perform require_member(g.household_id);
  if g.voided_at is not null then
    return jsonb_build_object('duplicate', true);
  end if;
  select * into it from items where id = g.item_id;
  if it.is_consumable and it.stock_qty is not null then
    perform _apply_stock(it.id, 'void', -g.qty, gen_random_uuid(), 'Gift removed', null, g.id);
  end if;
  update gifts set voided_at = now() where id = p_gift_id;
  insert into activity_log (household_id, actor, entity, entity_id, action, summary)
  values (g.household_id, auth.uid(), 'gift', g.id, 'void', 'Removed gift record for ' || it.name);
  return jsonb_build_object('duplicate', false);
end $$;

-- ---------------------------------------------------------------------------
-- Derived views (security_invoker so RLS applies to the caller)
-- ---------------------------------------------------------------------------
create or replace view public.item_overview with (security_invoker = true) as
select
  i.*,
  coalesce(p.purchased_qty, 0)::integer as purchased_qty,
  coalesce(g.gifted_qty, 0)::integer as gifted_qty,
  (coalesce(p.purchased_qty, 0) + coalesce(g.gifted_qty, 0))::integer as acquired_qty,
  coalesce(p.spent_cents, 0)::bigint as spent_cents,
  coalesce(p.purchase_count, 0)::integer as purchase_count,
  coalesce(p.undated_count, 0)::integer as undated_purchase_count,
  case
    when coalesce(p.purchased_qty, 0) + coalesce(g.gifted_qty, 0) = 0 then 'needed'
    when i.required_qty is not null and coalesce(p.purchased_qty, 0) + coalesce(g.gifted_qty, 0) < i.required_qty
      then 'partial'
    when coalesce(p.purchased_qty, 0) = 0 then 'gifted'
    else 'purchased'
  end as status,
  public.stock_level(i.stock_qty, i.low_stock_threshold, i.is_consumable) as stock_level
from public.items i
left join lateral (
  select sum(qty) as purchased_qty, sum(amount_cents) as spent_cents, count(*) as purchase_count,
         count(*) filter (where purchased_on is null) as undated_count
  from public.purchases where item_id = i.id and voided_at is null
) p on true
left join lateral (
  select sum(qty) as gifted_qty from public.gifts where item_id = i.id and voided_at is null
) g on true;

-- ---------------------------------------------------------------------------
-- Spending summary (America/New_York, weeks start Monday, USD cents)
-- ---------------------------------------------------------------------------
create or replace function public.spending_summary(p_today date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  hh uuid := my_household_id();
  d date := coalesce(p_today, today_ny());
  wk_start date := date_trunc('week', d)::date;     -- ISO weeks start Monday
  mo_start date := date_trunc('month', d)::date;
  result jsonb;
begin
  perform require_member(hh);
  with p as (
    select pu.*, i.category from purchases pu join items i on i.id = pu.item_id
    where pu.household_id = hh and pu.voided_at is null
  )
  select jsonb_build_object(
    'today', d,
    'timezone', 'America/New_York',
    'week_start', wk_start,
    'month_start', mo_start,
    'week_cents', coalesce(sum(amount_cents) filter (where purchased_on between wk_start and d), 0),
    'month_cents', coalesce(sum(amount_cents) filter (where purchased_on between mo_start and d), 0),
    'all_time_cents', coalesce(sum(amount_cents), 0),
    'undated_cents', coalesce(sum(amount_cents) filter (where purchased_on is null), 0),
    'undated_count', count(*) filter (where purchased_on is null),
    'purchase_count', count(*),
    'monthly_budget_cents', (select monthly_budget_cents from households where id = hh),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'cents', cents, 'count', n) order by cents desc)
      from (select category, sum(amount_cents) as cents, count(*) as n from p group by category) c), '[]'::jsonb),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', m, 'cents', cents) order by m)
      from (select to_char(date_trunc('month', purchased_on), 'YYYY-MM') as m, sum(amount_cents) as cents
            from p where purchased_on is not null group by 1) mm), '[]'::jsonb),
    'gifts_count', (select count(*) from gifts where household_id = hh and voided_at is null)
  ) into result
  from p;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- Usage-based estimate: only from real usage events, with its basis shown.
-- Needs at least 3 usage entries spanning at least 3 days.
-- ---------------------------------------------------------------------------
create or replace function public.usage_estimates()
returns table (item_id uuid, name text, unit text, stock_qty integer, used_total integer, first_day date,
               last_day date, days_observed integer, events integer, per_day numeric, days_remaining numeric,
               sufficient boolean, basis text)
language sql stable security definer set search_path = public as $$
  with u as (
    select se.item_id, sum(-se.delta)::integer as used_total, min(se.occurred_on) as first_day,
           greatest(max(se.occurred_on), today_ny()) as last_day, count(*)::integer as events
    from stock_events se
    where se.household_id = my_household_id() and se.kind = 'usage'
      and se.occurred_on >= today_ny() - 28
    group by se.item_id
  )
  select i.id, i.name, i.unit, i.stock_qty, u.used_total, u.first_day, u.last_day,
         (u.last_day - u.first_day + 1) as days_observed, u.events,
         round(u.used_total::numeric / (u.last_day - u.first_day + 1), 1) as per_day,
         case when i.stock_qty is not null and u.used_total > 0 and u.events >= 3 and (u.last_day - u.first_day + 1) >= 3
              then round(i.stock_qty / (u.used_total::numeric / (u.last_day - u.first_day + 1)), 1) end,
         (i.stock_qty is not null and u.used_total > 0 and u.events >= 3 and (u.last_day - u.first_day + 1) >= 3),
         'Based on ' || u.used_total || ' ' || i.unit || ' used across ' || u.events
           || case when u.events = 1 then ' entry' else ' entries' end || ' over '
           || (u.last_day - u.first_day + 1) || case when u.last_day = u.first_day then ' day (' else ' days (' end
           || to_char(u.first_day, 'Mon FMDD') || case when u.last_day = u.first_day then '' else '–' || to_char(u.last_day, 'Mon FMDD') end || ')'
  from u join items i on i.id = u.item_id
  where i.household_id = my_household_id();
$$;

-- ---------------------------------------------------------------------------
-- Import (idempotent): items and undated historical purchases in one transaction
-- payload: { fingerprint, file_name, items: [{import_key, name, brand, model, category, unit,
--   required_qty, is_consumable, low_stock_threshold, master_no, notes, needs_review, review_note,
--   purchases: [{import_key, qty, amount_cents, notes}] }] }
-- ---------------------------------------------------------------------------
create or replace function public.import_registry(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  hh uuid := my_household_id();
  rec jsonb;
  pur jsonb;
  new_item uuid;
  n_items integer := 0;
  n_purchases integer := 0;
  n_skipped integer := 0;
begin
  perform require_member(hh);
  if exists (select 1 from imports where household_id = hh and file_fingerprint = p_payload->>'fingerprint') then
    return jsonb_build_object('already_imported', true);
  end if;
  for rec in select * from jsonb_array_elements(p_payload->'items') loop
    if exists (select 1 from items where household_id = hh and import_key = rec->>'import_key') then
      n_skipped := n_skipped + 1;
      continue;
    end if;
    insert into items (household_id, name, brand, model, category, unit, required_qty, is_consumable,
                       low_stock_threshold, master_no, notes, needs_review, review_note, import_key, created_by, updated_by)
    values (hh, rec->>'name', rec->>'brand', rec->>'model', coalesce(rec->>'category', 'Other'),
            coalesce(rec->>'unit', 'item'), (rec->>'required_qty')::integer, coalesce((rec->>'is_consumable')::boolean, false),
            (rec->>'low_stock_threshold')::integer, (rec->>'master_no')::integer, rec->>'notes',
            coalesce((rec->>'needs_review')::boolean, false), rec->>'review_note', rec->>'import_key', auth.uid(), auth.uid())
    returning id into new_item;
    n_items := n_items + 1;
    for pur in select * from jsonb_array_elements(coalesce(rec->'purchases', '[]'::jsonb)) loop
      if exists (select 1 from purchases where household_id = hh and import_key = pur->>'import_key') then
        continue;
      end if;
      -- Imported history: purchased_on stays NULL (no date in the file).
      insert into purchases (household_id, item_id, qty, purchased_on, amount_cents, buyer_label, notes,
                             source, import_key, client_request_id, created_by, updated_by)
      values (hh, new_item, (pur->>'qty')::integer, null, (pur->>'amount_cents')::bigint, 'Not recorded',
              pur->>'notes', 'import', pur->>'import_key', gen_random_uuid(), auth.uid(), auth.uid());
      n_purchases := n_purchases + 1;
    end loop;
  end loop;
  insert into imports (household_id, file_fingerprint, file_name, items_created, purchases_created, created_by)
  values (hh, p_payload->>'fingerprint', p_payload->>'file_name', n_items, n_purchases, auth.uid());
  insert into activity_log (household_id, actor, entity, action, summary)
  values (hh, auth.uid(), 'import', 'create',
          'Imported ' || n_items || ' items and ' || n_purchases || ' purchases from ' || coalesce(p_payload->>'file_name', 'a file'));
  return jsonb_build_object('already_imported', false, 'items', n_items, 'purchases', n_purchases, 'skipped', n_skipped);
end $$;

-- ---------------------------------------------------------------------------
-- Push outbox claim (service role only). Atomic claim prevents two senders
-- from delivering the same alert twice.
-- ---------------------------------------------------------------------------
create or replace function public.claim_notifications(p_household uuid)
returns setof notification_outbox language sql security definer set search_path = public as $$
  update notification_outbox set claimed_at = now()
  where id in (
    select id from notification_outbox
    where household_id = p_household and claimed_at is null
    order by created_at
    for update skip locked
  )
  returning *;
$$;
revoke execute on function public.claim_notifications from public, anon, authenticated;

grant execute on function public.create_household, public.create_invite, public.revoke_invite, public.accept_invite,
  public.remove_member, public.set_starting_stock, public.correct_stock, public.log_usage, public.record_purchase,
  public.update_purchase, public.void_purchase, public.record_gift, public.void_gift, public.spending_summary,
  public.usage_estimates, public.import_registry to authenticated;
revoke execute on function public.create_household, public.create_invite, public.revoke_invite, public.accept_invite,
  public.remove_member, public.set_starting_stock, public.correct_stock, public.log_usage, public.record_purchase,
  public.update_purchase, public.void_purchase, public.record_gift, public.void_gift, public.spending_summary,
  public.usage_estimates, public.import_registry from anon, public;

-- ---------------------------------------------------------------------------
-- Photo storage: private bucket, first folder is the household id.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create policy "household photos read" on storage.objects for select to authenticated
  using (bucket_id = 'item-photos' and public.is_household_member(((storage.foldername(name))[1])::uuid));
create policy "household photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and public.is_household_member(((storage.foldername(name))[1])::uuid));
create policy "household photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'item-photos' and public.is_household_member(((storage.foldername(name))[1])::uuid));

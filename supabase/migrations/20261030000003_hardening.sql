-- Column-level limits on direct table updates from the app.
-- Members may rename themselves, but not change their role or household.
revoke update on public.household_members from authenticated, anon;
grant update (display_name) on public.household_members to authenticated;

-- Household: only name and budget are editable directly.
revoke update on public.households from authenticated, anon;
grant update (name, monthly_budget_cents) on public.households to authenticated;

-- Unused helper that could reveal member names by id.
drop function if exists public.member_name(uuid, uuid);

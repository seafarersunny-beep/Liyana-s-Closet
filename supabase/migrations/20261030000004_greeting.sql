-- Liyana's spoken greeting: what she calls each parent, and an optional
-- recorded clip per parent that plays on both phones.
alter table public.household_members
  add column greeting_title text not null default 'Baba' check (char_length(greeting_title) between 1 and 20),
  add column greeting_audio_path text,
  add column greeting_pitch_up boolean not null default true;

-- Members may set their own title; any member may record the clip a parent hears
-- (so Smita can record the greeting Sunny hears, and the other way round).
grant update (greeting_title, greeting_audio_path, greeting_pitch_up) on public.household_members to authenticated;
drop policy if exists "member edits own name" on public.household_members;
create policy "member edits own name" on public.household_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "members set greeting clips" on public.household_members
  for update using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

-- Members can only change display_name on their own row; others may touch greeting fields only.
create or replace function public.tg_member_guard()
returns trigger language plpgsql as $$
begin
  if new.user_id <> auth.uid() and (new.display_name is distinct from old.display_name or new.greeting_title is distinct from old.greeting_title) then
    raise exception 'You can only rename yourself' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger household_members_guard before update on public.household_members
  for each row execute function public.tg_member_guard();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('household-audio', 'household-audio', false, 5242880,
        array['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav'])
on conflict (id) do nothing;

create policy "household audio read" on storage.objects for select to authenticated
  using (bucket_id = 'household-audio' and public.is_household_member(((storage.foldername(name))[1])::uuid));
create policy "household audio insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'household-audio' and public.is_household_member(((storage.foldername(name))[1])::uuid));
create policy "household audio delete" on storage.objects for delete to authenticated
  using (bucket_id = 'household-audio' and public.is_household_member(((storage.foldername(name))[1])::uuid));

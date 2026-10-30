-- Liyana says "Hello Baba!" to whoever started the household and "Hello Ammu!" to the
-- invited parent, until someone picks a name. A null title means "use that default".
alter table public.household_members alter column greeting_title drop not null;
alter table public.household_members alter column greeting_title drop default;
update public.household_members set greeting_title = null where greeting_title = 'Baba';

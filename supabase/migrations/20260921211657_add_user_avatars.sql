-- =============================================================================
-- Profile pictures.
--
-- Adds a column for where a user's avatar lives, and the Supabase Storage bucket
-- (plus its own RLS-style policies on storage.objects) that actually holds the
-- image file. Two different things a profile picture needs: a place to store the
-- bytes, and a place to point at them.
--
-- Chosen to be publicly readable rather than restricted to housemates (the way
-- display_name is): a profile picture is not sensitive the way financial data
-- is, and a housemate-only policy on storage.objects would need to repeat the
-- shares_house_with join this migration has no easy way to express against
-- Storage's own object model. Anyone with the URL can view an avatar; nobody but
-- its owner can upload, replace, or delete it.
--
-- Path convention: every avatar lives at "<user_id>/avatar.<ext>" in the
-- `avatars` bucket - the leading folder is what the write policies below check
-- against auth.uid(), via storage.foldername(), Storage's own helper for
-- splitting an object path into its folder segments.
-- =============================================================================

alter table public.users
  add column avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatar images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "users can upload their own avatar"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "users can replace their own avatar"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "users can delete their own avatar"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

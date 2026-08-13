-- ============================================================
--  DECODER — run this whole file once in Supabase → SQL Editor
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- who is allowed to work the desk ----------
create table if not exists public.admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

-- ---------- the tickets ----------
create table if not exists public.tickets (
  id          uuid primary key default gen_random_uuid(),
  num         bigint generated always as identity,
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  handle      text not null default '',
  question    text not null default '',
  link        text not null default '',
  kind        text not null default 'link',        -- link | image | video
  media_path  text,                                 -- path inside the "posts" bucket
  status      text not null default 'open',         -- open | reading | answered
  answer      text not null default '',
  answered_by text not null default '',             -- human | ai
  answered_at timestamptz,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists tickets_owner_idx  on public.tickets (owner, created_at desc);
create index if not exists tickets_status_idx on public.tickets (status, created_at);

-- ---------- admin check ----------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------- row level security ----------
alter table public.tickets enable row level security;
alter table public.admins  enable row level security;

drop policy if exists "read own or all if admin" on public.tickets;
create policy "read own or all if admin" on public.tickets
  for select to authenticated
  using (owner = auth.uid() or public.is_admin());

drop policy if exists "send your own" on public.tickets;
create policy "send your own" on public.tickets
  for insert to authenticated
  with check (owner = auth.uid());

-- only the desk can edit a ticket from the browser.
-- the AI answers are written by the Netlify function with the service key,
-- which bypasses RLS entirely — no public update path needed.
drop policy if exists "desk answers" on public.tickets;
create policy "desk answers" on public.tickets
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "see your own admin row" on public.admins;
create policy "see your own admin row" on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- ---------- live updates ----------
alter publication supabase_realtime add table public.tickets;

-- ---------- media bucket ----------
-- private bucket. nothing is readable by URL alone — the app asks for a
-- short-lived signed link each time it shows an image.
insert into storage.buckets (id, name, public)
values ('posts', 'posts', false)
on conflict (id) do update set public = false;

drop policy if exists "upload to your own folder" on storage.objects;
create policy "upload to your own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);

-- you can sign a link for your own upload. the desk can sign any of them.
drop policy if exists "anyone can view posts" on storage.objects;
drop policy if exists "view your own or all if admin" on storage.objects;
create policy "view your own or all if admin" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'posts'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );


-- ============================================================
--  AFTER RUNNING THIS
--
--  1. Auth → Sign In / Providers → turn ON "Anonymous sign-ins".
--     (That is how submitters get a session without making an account.)
--
--  2. Auth → Users → Add user → create YOUR email + password.
--     Copy the user's UID, then run:
--
--        insert into public.admins (user_id) values ('PASTE-YOUR-UID-HERE');
--
--     That account is the only one that can see the desk.
-- ============================================================

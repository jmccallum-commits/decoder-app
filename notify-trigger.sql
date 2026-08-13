-- ============================================================
--  EMAIL ON EVERY NEW TICKET
--  Run this AFTER your Netlify site is live, and swap in your
--  real site URL on the line marked below.
-- ============================================================

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_new_ticket()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform net.http_post(
    -- ↓↓↓ PUT YOUR NETLIFY URL HERE ↓↓↓
    url     := 'https://cerulean-rolypoly-dd4e3c.netlify.app/.netlify/functions/notify',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := json_build_object('id', new.id)::jsonb
  );
  return new;
end;
$$;

drop trigger if exists on_ticket_created on public.tickets;
create trigger on_ticket_created
  after insert on public.tickets
  for each row execute function public.notify_new_ticket();

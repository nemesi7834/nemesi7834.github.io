-- Run this file once in Supabase SQL Editor. It grants browser access only to
-- the single dashboard account; the local worker writes with a secret key.

create extension if not exists pgcrypto;

create table if not exists public.dashboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source_updated_at timestamptz,
  payload jsonb not null
);

create table if not exists public.refresh_requests (
  id uuid primary key default gen_random_uuid(),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  requested_by uuid not null references auth.users(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'skipped', 'failed')),
  message text,
  snapshot_id uuid references public.dashboard_snapshots(id)
);

create unique index if not exists one_active_product_day_refresh
  on public.refresh_requests ((1)) where status in ('queued', 'running');

create or replace function public.is_product_day_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'alexseredauk@gmail.com';
$$;

alter table public.dashboard_snapshots enable row level security;
alter table public.refresh_requests enable row level security;

drop policy if exists "product day reads snapshots" on public.dashboard_snapshots;
create policy "product day reads snapshots" on public.dashboard_snapshots
  for select to authenticated using (public.is_product_day_admin());

drop policy if exists "product day reads requests" on public.refresh_requests;
create policy "product day reads requests" on public.refresh_requests
  for select to authenticated using (public.is_product_day_admin());

create or replace function public.request_dashboard_refresh()
returns public.refresh_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  active_request public.refresh_requests;
begin
  if auth.uid() is null or not public.is_product_day_admin() then
    raise exception 'Not allowed';
  end if;

  select * into active_request from public.refresh_requests
    where status in ('queued', 'running')
    order by requested_at desc limit 1;
  if found then
    return active_request;
  end if;

  insert into public.refresh_requests (requested_by)
    values (auth.uid()) returning * into active_request;
  return active_request;
end;
$$;

revoke all on function public.request_dashboard_refresh() from public;
grant execute on function public.request_dashboard_refresh() to authenticated;

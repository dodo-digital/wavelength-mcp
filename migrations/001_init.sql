-- Wavelength MCP call tracking schema
-- Run this in your Supabase SQL editor

-- Users table (per-user token auth)
create table if not exists wl_users (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  token text not null unique,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Call logs
create table if not exists wl_calls (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references wl_users(id),
  tool text not null,
  provider text,
  email_count integer default 0,
  credits_used integer default 0,
  status text not null check (status in ('success', 'error', 'partial')),
  error_message text,
  duration_ms integer,
  created_at timestamptz default now()
);

-- Health checks
create table if not exists wl_health_checks (
  id uuid default gen_random_uuid() primary key,
  provider text not null,
  check_type text not null,
  status text not null check (status in ('pass', 'fail', 'degraded')),
  details jsonb,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists idx_wl_calls_created_at on wl_calls(created_at desc);
create index if not exists idx_wl_calls_user_id on wl_calls(user_id);
create index if not exists idx_wl_calls_tool on wl_calls(tool);
create index if not exists idx_wl_health_checks_created_at on wl_health_checks(created_at desc);

-- Seed: Insert the shared team token so existing users are tracked
-- Run this after setting up the tables, replacing YOUR_TOKEN with WL_MCP_TOKEN value
-- insert into wl_users (name, token) values ('team-shared', 'YOUR_TOKEN_HERE');

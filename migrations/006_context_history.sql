-- Version history for context documents — tracks every edit with who, when, and what changed.
-- Enables audit trail: "who changed the thesis and when?"

-- Add version counter to main context table
alter table wl_context add column if not exists version int not null default 1;

-- History table — one row per edit
create table if not exists wl_context_history (
  id uuid default gen_random_uuid() primary key,
  context_id uuid not null references wl_context(id) on delete cascade,
  slug text not null,
  version int not null,
  doc_type text not null,
  title text not null,
  content text not null,
  tags text[] default '{}',
  metadata jsonb default '{}',
  changed_by text,
  change_type text not null default 'updated',  -- 'created', 'updated'
  created_at timestamptz default now()
);

create index if not exists idx_wl_context_history_context_id on wl_context_history(context_id);
create index if not exists idx_wl_context_history_slug on wl_context_history(slug);
create index if not exists idx_wl_context_history_slug_version on wl_context_history(slug, version desc);

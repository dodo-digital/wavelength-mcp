-- Shared context documents — thesis, sources, scoring criteria, etc.
-- Queryable by slug, doc_type, or full-text search over title + content + tags.

create table if not exists wl_context (
  id uuid default gen_random_uuid() primary key,
  slug text unique not null,                    -- e.g. 'thesis', 'sources', 'scoring-criteria'
  doc_type text not null default 'reference',   -- 'thesis', 'reference', 'source', 'criteria', 'template'
  title text not null,
  content text not null,                        -- markdown body
  tags text[] default '{}',                     -- e.g. {'industry/cybersecurity', 'skill/grata-search-enrichment'}
  metadata jsonb default '{}',                  -- flexible k/v: version, last_editor, anything skill-specific
  updated_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_wl_context_slug on wl_context(slug);
create index if not exists idx_wl_context_doc_type on wl_context(doc_type);
create index if not exists idx_wl_context_tags on wl_context using gin(tags);
create index if not exists idx_wl_context_search on wl_context using gin(
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
);

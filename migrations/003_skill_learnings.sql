-- Skill learnings — shared knowledge base that evolves across runs and users
-- Each row is a single learning (adjustment, edge case, schema change, etc.)

create table if not exists wl_skill_learnings (
  id uuid default gen_random_uuid() primary key,
  skill text not null,                          -- e.g. 'company-processor', 'grata-search-enrichment'
  industry text,                                -- e.g. 'cybersecurity', 'fire-safety', null for global
  category text not null default 'adjustment',  -- 'adjustment', 'schema-change', 'edge-case', 'pattern'
  content text not null,                        -- the actual learning
  created_by text,                              -- user name or 'system'
  is_active boolean default true,               -- soft delete / supersede
  created_at timestamptz default now()
);

create index if not exists idx_wl_skill_learnings_skill on wl_skill_learnings(skill);
create index if not exists idx_wl_skill_learnings_skill_industry on wl_skill_learnings(skill, industry);
create index if not exists idx_wl_skill_learnings_active on wl_skill_learnings(is_active) where is_active = true;

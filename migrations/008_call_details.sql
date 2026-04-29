-- Add a JSONB details column to wl_calls for tool-specific metadata
-- (query parameters, result counts, document slugs, etc.)
ALTER TABLE wl_calls ADD COLUMN IF NOT EXISTS details jsonb;

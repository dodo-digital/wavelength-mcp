-- Admin authorization and per-user bulk validation job ownership.

ALTER TABLE wl_users
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS wl_bulk_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES wl_users(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('clearout', 'zerobounce')),
  job_id text NOT NULL,
  email_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (provider, job_id)
);

CREATE INDEX IF NOT EXISTS idx_wl_bulk_jobs_user_id
  ON wl_bulk_jobs(user_id);

CREATE INDEX IF NOT EXISTS idx_wl_bulk_jobs_created_at
  ON wl_bulk_jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wl_bulk_jobs_expires_at
  ON wl_bulk_jobs(expires_at);

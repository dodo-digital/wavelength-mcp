-- Add UNIQUE constraint on auth_user_id to prevent duplicate user records
-- from retry-on-timeout scenarios during OAuth auto-creation.
-- NULL values are allowed (legacy token-only users don't have auth_user_id).

CREATE UNIQUE INDEX IF NOT EXISTS idx_wl_users_auth_user_id_unique
  ON wl_users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

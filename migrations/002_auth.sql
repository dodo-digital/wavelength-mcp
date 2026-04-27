-- Better Auth OAuth 2.1 tables
-- Better Auth auto-creates its core tables (user, session, account, verification)
-- via `npx @better-auth/cli migrate` but we document them here for reference.
--
-- The OAuth Provider plugin adds: oauth_application, oauth_access_token,
-- oauth_authorization_code, oauth_consent.
--
-- This migration adds the bridge column linking Better Auth users to wl_users.

-- Bridge: link Better Auth user IDs to MCP users
ALTER TABLE wl_users ADD COLUMN IF NOT EXISTS auth_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wl_users_auth_user_id ON wl_users(auth_user_id);

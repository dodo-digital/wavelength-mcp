import { neon } from "@neondatabase/serverless";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallLogEntry {
  tool: string;
  provider?: string;
  email_count: number;
  credits_used: number;
  status: "success" | "error" | "partial";
  error_message?: string;
  duration_ms: number;
  details?: Record<string, unknown>;
}

export interface HealthCheckResult {
  provider: string;
  check_type: string;
  status: "pass" | "fail" | "degraded";
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type SqlClient = ReturnType<typeof neon>;

export interface UserIdentity {
  id: string;
  name: string;
  is_admin: boolean;
}

export interface BulkJob {
  id: string;
  user_id: string;
  provider: string;
  job_id: string;
  email_count: number;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

let _sql: SqlClient | null = null;

export function getSql(): SqlClient | null {
  if (_sql) return _sql;

  const url = process.env.POSTGRES_URL;
  if (!url) return null;

  _sql = neon(url);
  return _sql;
}

// ---------------------------------------------------------------------------
// User resolution
// ---------------------------------------------------------------------------

export async function resolveUser(
  sql: SqlClient,
  token: string
): Promise<UserIdentity | null> {
  const rows = await sql`
    SELECT id, name, coalesce(is_admin, false) as is_admin FROM wl_users
    WHERE token = ${token} AND is_active = true
    LIMIT 1
  ` as Array<{ id: string; name: string; is_admin: boolean }>;

  if (rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name, is_admin: rows[0].is_admin };
}

export async function upsertOAuthUser(
  sql: SqlClient,
  authUser: { id: string; name?: string | null; email?: string | null }
): Promise<UserIdentity> {
  const rows = await sql`
    INSERT INTO wl_users (name, token, auth_user_id, is_active)
    VALUES (
      ${authUser.name || authUser.email || "oauth-user"},
      ${`oauth-${authUser.id}`},
      ${authUser.id},
      true
    )
    ON CONFLICT (auth_user_id) WHERE auth_user_id IS NOT NULL
    DO UPDATE SET
      name = EXCLUDED.name,
      is_active = true
    RETURNING id, name, coalesce(is_admin, false) as is_admin
  ` as Array<{ id: string; name: string; is_admin: boolean }>;

  return rows[0];
}

export async function upsertSharedTokenUser(
  sql: SqlClient,
  token: string
): Promise<UserIdentity> {
  const rows = await sql`
    INSERT INTO wl_users (name, token, is_active)
    VALUES ('team-shared', ${token}, true)
    ON CONFLICT (token)
    DO UPDATE SET is_active = true
    RETURNING id, name, coalesce(is_admin, false) as is_admin
  ` as Array<{ id: string; name: string; is_admin: boolean }>;

  return rows[0];
}

// ---------------------------------------------------------------------------
// Call logging
// ---------------------------------------------------------------------------

export async function logCall(
  sql: SqlClient,
  userId: string | null,
  entry: CallLogEntry
): Promise<void> {
  await sql`
    INSERT INTO wl_calls (user_id, tool, provider, email_count, credits_used, status, error_message, duration_ms, details)
    VALUES (
      ${userId},
      ${entry.tool},
      ${entry.provider ?? null},
      ${entry.email_count},
      ${entry.credits_used},
      ${entry.status},
      ${entry.error_message ?? null},
      ${entry.duration_ms},
      ${entry.details ? JSON.stringify(entry.details) : null}
    )
  `;
}

// ---------------------------------------------------------------------------
// Bulk validation jobs
// ---------------------------------------------------------------------------

export async function createBulkJob(
  sql: SqlClient,
  userId: string,
  provider: string,
  jobId: string,
  emailCount: number
): Promise<void> {
  await expireOldBulkJobs(sql);

  await sql`
    INSERT INTO wl_bulk_jobs (user_id, provider, job_id, email_count, status, expires_at)
    VALUES (${userId}, ${provider}, ${jobId}, ${emailCount}, 'submitted', now() + interval '7 days')
  `;
}

export async function getBulkJob(
  sql: SqlClient,
  provider: string,
  jobId: string
): Promise<BulkJob | null> {
  const rows = await sql`
    SELECT id, user_id, provider, job_id, email_count, status, expires_at, created_at, updated_at
    FROM wl_bulk_jobs
    WHERE provider = ${provider}
      AND job_id = ${jobId}
    LIMIT 1
  ` as BulkJob[];

  return rows[0] ?? null;
}

export async function expireOldBulkJobs(sql: SqlClient): Promise<void> {
  await sql`
    UPDATE wl_bulk_jobs
    SET status = 'expired',
        updated_at = now()
    WHERE expires_at < now()
      AND status NOT IN ('downloaded', 'expired')
  `;
}

export async function markBulkJobExpired(
  sql: SqlClient,
  provider: string,
  jobId: string
): Promise<void> {
  await sql`
    UPDATE wl_bulk_jobs
    SET status = 'expired',
        updated_at = now()
    WHERE provider = ${provider}
      AND job_id = ${jobId}
  `;
}

export async function updateBulkJobStatus(
  sql: SqlClient,
  provider: string,
  jobId: string,
  status: string
): Promise<void> {
  await sql`
    UPDATE wl_bulk_jobs
    SET status = ${status},
        updated_at = now()
    WHERE provider = ${provider}
      AND job_id = ${jobId}
  `;
}

// ---------------------------------------------------------------------------
// Health check logging
// ---------------------------------------------------------------------------

export async function logHealthCheck(
  sql: SqlClient,
  result: HealthCheckResult
): Promise<void> {
  await sql`
    INSERT INTO wl_health_checks (provider, check_type, status, details)
    VALUES (
      ${result.provider},
      ${result.check_type},
      ${result.status},
      ${JSON.stringify(result.details ?? null)}
    )
  `;
}

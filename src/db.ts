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

type SqlClient = ReturnType<typeof neon>;

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
): Promise<{ id: string; name: string } | null> {
  const rows = await sql`
    SELECT id, name FROM wl_users
    WHERE token = ${token} AND is_active = true
    LIMIT 1
  ` as Record<string, string>[];

  if (rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name };
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
    INSERT INTO wl_calls (user_id, tool, provider, email_count, credits_used, status, error_message, duration_ms)
    VALUES (
      ${userId},
      ${entry.tool},
      ${entry.provider ?? null},
      ${entry.email_count},
      ${entry.credits_used},
      ${entry.status},
      ${entry.error_message ?? null},
      ${entry.duration_ms}
    )
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

// ---------------------------------------------------------------------------
// Helpers for request-level instrumentation
// ---------------------------------------------------------------------------

export function inferProvider(
  toolName: string,
  args?: Record<string, unknown>
): string | null {
  if (toolName === "validate_email") return "clearout";
  if (toolName === "zb_validate_email") return "zerobounce";
  if (args?.provider && typeof args.provider === "string") return args.provider;
  return null;
}

export function countEmails(args?: Record<string, unknown>): number {
  if (!args) return 0;
  if (args.email) {
    return Array.isArray(args.email) ? args.email.length : 1;
  }
  if (args.emails) {
    return Array.isArray(args.emails) ? args.emails.length : 0;
  }
  return 0;
}

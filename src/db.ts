import { createClient, SupabaseClient } from "@supabase/supabase-js";

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

let _client: SupabaseClient | null = null;

export function getDb(): SupabaseClient | null {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;

  _client = createClient(url, key);
  return _client;
}

// ---------------------------------------------------------------------------
// User resolution
// ---------------------------------------------------------------------------

export async function resolveUser(
  db: SupabaseClient,
  token: string
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db
    .from("wl_users")
    .select("id, name")
    .eq("token", token)
    .eq("is_active", true)
    .single();

  if (error || !data) return null;
  return { id: data.id, name: data.name };
}

// ---------------------------------------------------------------------------
// Call logging
// ---------------------------------------------------------------------------

export async function logCall(
  db: SupabaseClient,
  userId: string | null,
  entry: CallLogEntry
): Promise<void> {
  await db.from("wl_calls").insert({
    user_id: userId,
    tool: entry.tool,
    provider: entry.provider ?? null,
    email_count: entry.email_count,
    credits_used: entry.credits_used,
    status: entry.status,
    error_message: entry.error_message ?? null,
    duration_ms: entry.duration_ms,
  });
}

// ---------------------------------------------------------------------------
// Health check logging
// ---------------------------------------------------------------------------

export async function logHealthCheck(
  db: SupabaseClient,
  result: HealthCheckResult
): Promise<void> {
  await db.from("wl_health_checks").insert({
    provider: result.provider,
    check_type: result.check_type,
    status: result.status,
    details: result.details ?? null,
  });
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

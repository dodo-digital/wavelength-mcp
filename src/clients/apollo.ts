import { fetchWithTimeout } from "./fetch.js";

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const APOLLO_AUTH_BASE = "https://api.apollo.io/v1";

function getKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error("APOLLO_API_KEY not set");
  return key;
}

export async function post(
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetchWithTimeout(`${APOLLO_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": getKey(),
    },
    body: JSON.stringify(body),
  }, 30_000);
  if (!res.ok) {
    await res.text();
    throw new Error(`Apollo API ${res.status}: request failed`);
  }
  return res.json();
}

export async function get(path: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${APOLLO_BASE}${path}`, {
    headers: { "X-Api-Key": getKey() },
  }, 30_000);
  if (!res.ok) {
    await res.text();
    throw new Error(`Apollo API ${res.status}: request failed`);
  }
  return res.json();
}

async function parseError(res: Response): Promise<Error> {
  const body = await res.text();
  let message = body.trim();

  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_code?: unknown };
    if (typeof parsed.error === "string") {
      message = parsed.error;
      if (typeof parsed.error_code === "string") {
        message += ` (${parsed.error_code})`;
      }
    }
  } catch {
    // Keep the raw body text when Apollo does not return JSON.
  }

  return new Error(`Apollo API ${res.status}: ${message || "request failed"}`);
}

export async function getAuthHealth(): Promise<unknown> {
  const res = await fetchWithTimeout(`${APOLLO_AUTH_BASE}/auth/health`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": getKey(),
    },
  }, 20_000);

  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function getUsageStats(): Promise<unknown> {
  const res = await fetchWithTimeout(`${APOLLO_BASE}/usage_stats/api_usage_stats`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Api-Key": getKey(),
    },
  }, 20_000);

  if (!res.ok) throw await parseError(res);
  return res.json();
}

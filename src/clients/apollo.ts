import { fetchWithTimeout } from "./fetch.js";

const APOLLO_BASE = "https://api.apollo.io/api/v1";

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

const REPLY_BASE = "https://api.reply.io";

function getKey(): string {
  const key = process.env.REPLY_IO_API_KEY;
  if (!key) throw new Error("REPLY_IO_API_KEY not set");
  return key;
}

export async function get(path: string): Promise<unknown> {
  const res = await fetch(`${REPLY_BASE}${path}`, {
    headers: { "X-API-Key": getKey() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Reply.io API ${res.status}: ${body}`);
  }
  return res.json();
}

export async function post(
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${REPLY_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-API-Key": getKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSql, logHealthCheck } from "../src/db.js";

// ---------------------------------------------------------------------------
// Health check endpoint — runs via Vercel Cron every 4 hours
// ---------------------------------------------------------------------------

const CLEAROUT_BASE = "https://api.clearout.io/v2";
const ZEROBOUNCE_BASE = "https://api.zerobounce.net/v2";

async function checkClearout(): Promise<{
  status: "pass" | "fail" | "degraded";
  details: Record<string, unknown>;
}> {
  const key = process.env.CLEAROUT_API_KEY;
  if (!key) return { status: "fail", details: { error: "CLEAROUT_API_KEY not set" } };

  try {
    const res = await fetch(`${CLEAROUT_BASE}/email_verify/getcredits`, {
      headers: { Authorization: `Bearer:${key}` },
    });

    if (!res.ok) {
      return {
        status: "fail",
        details: { error: `API returned ${res.status}`, body: await res.text() },
      };
    }

    const json = (await res.json()) as {
      status: string;
      data?: { credits: Record<string, unknown> };
    };

    if (json.status === "error" || !json.data) {
      return { status: "fail", details: { error: "Unexpected response shape", json } };
    }

    const credits = json.data.credits;
    const available =
      typeof credits.available === "number" ? credits.available : null;

    return {
      status: available !== null && available < 100 ? "degraded" : "pass",
      details: { credits_available: available, raw: credits },
    };
  } catch (err) {
    return {
      status: "fail",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function checkZeroBounce(): Promise<{
  status: "pass" | "fail" | "degraded";
  details: Record<string, unknown>;
}> {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key) return { status: "fail", details: { error: "ZEROBOUNCE_API_KEY not set" } };

  try {
    const params = new URLSearchParams({ api_key: key });
    const res = await fetch(`${ZEROBOUNCE_BASE}/getcredits?${params}`);

    if (!res.ok) {
      return {
        status: "fail",
        details: { error: `API returned ${res.status}`, body: await res.text() },
      };
    }

    const json = (await res.json()) as { Credits: number };

    if (json.Credits === -1) {
      return { status: "fail", details: { error: "Invalid API key" } };
    }

    return {
      status: json.Credits < 100 ? "degraded" : "pass",
      details: { credits_available: json.Credits },
    };
  } catch (err) {
    return {
      status: "fail",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Require CRON_SECRET — blocks public access to credit balances
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: "CRON_SECRET not configured" });
  }
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const [clearout, zerobounce] = await Promise.all([
    checkClearout(),
    checkZeroBounce(),
  ]);

  const sql = getSql();

  if (sql) {
    await Promise.all([
      logHealthCheck(sql, {
        provider: "clearout",
        check_type: "credits",
        status: clearout.status,
        details: clearout.details,
      }),
      logHealthCheck(sql, {
        provider: "zerobounce",
        check_type: "credits",
        status: zerobounce.status,
        details: zerobounce.details,
      }),
    ]).catch(() => {});
  }

  const overall =
    clearout.status === "fail" || zerobounce.status === "fail"
      ? "fail"
      : clearout.status === "degraded" || zerobounce.status === "degraded"
        ? "degraded"
        : "pass";

  return res.status(overall === "fail" ? 500 : 200).json({
    status: overall,
    checked_at: new Date().toISOString(),
    providers: { clearout, zerobounce },
  });
}

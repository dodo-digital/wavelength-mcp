import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Clearout API client
// ---------------------------------------------------------------------------

const CLEAROUT_BASE = "https://api.clearout.io/v2";

interface ClearoutVerifyResult {
  email_address: string;
  safe_to_send: string;
  status: string;
  sub_status?: { code: number; desc: string };
  disposable: string;
  free: string;
  role: string;
  gibberish: string;
  bounce_type: string;
  time_taken?: number;
  _schema_warning?: string;
  _rate_limit_remaining?: number;
}

interface ClearoutResponse {
  status: string;
  data?: ClearoutVerifyResult;
  error?: { code: number; message: string };
}

interface ClearoutCreditResponse {
  status: string;
  data?: { credits: Record<string, unknown> };
  error?: { code: number; message: string };
}

function getClearoutKey(): string {
  const key = process.env.CLEAROUT_API_KEY;
  if (!key) throw new Error("CLEAROUT_API_KEY not set");
  return key;
}

function validateResponseShape(data: Record<string, unknown>): string | null {
  const required = ["email_address", "status", "safe_to_send"];
  const missing = required.filter((k) => !(k in data));
  if (missing.length > 0) {
    return `Clearout response missing fields: ${missing.join(", ")}. API may have changed.`;
  }
  return null;
}

async function verifyEmail(email: string): Promise<ClearoutVerifyResult> {
  const res = await fetch(`${CLEAROUT_BASE}/email_verify/instant`, {
    method: "POST",
    headers: {
      Authorization: `Bearer:${getClearoutKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, timeout: 130000 }),
  });

  const rateLimitRemaining = res.headers.get("x-ratelimit-remaining");

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as ClearoutResponse;

  if (json.status === "error" || !json.data) {
    throw new Error(
      `Clearout error: ${json.error?.message ?? "Unknown error"}`
    );
  }

  const warning = validateResponseShape(
    json.data as unknown as Record<string, unknown>
  );
  const result: ClearoutVerifyResult = {
    email_address: json.data.email_address,
    safe_to_send: json.data.safe_to_send,
    status: json.data.status,
    sub_status: json.data.sub_status,
    disposable: json.data.disposable,
    free: json.data.free,
    role: json.data.role,
    gibberish: json.data.gibberish,
    bounce_type: json.data.bounce_type,
    time_taken: json.data.time_taken,
  };

  if (warning) result._schema_warning = warning;
  if (rateLimitRemaining !== null) {
    result._rate_limit_remaining = parseInt(rateLimitRemaining, 10);
  }

  return result;
}

async function getCredits(): Promise<{ credits: Record<string, unknown> }> {
  const res = await fetch(`${CLEAROUT_BASE}/email_verify/getcredits`, {
    method: "GET",
    headers: {
      Authorization: `Bearer:${getClearoutKey()}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as ClearoutCreditResponse;

  if (json.status === "error" || !json.data) {
    throw new Error(
      `Clearout error: ${json.error?.message ?? "Unknown error"}`
    );
  }

  return { credits: json.data.credits };
}

function extractAvailableCredits(
  credits: Record<string, unknown>
): number | null {
  for (const key of ["available", "remaining", "balance"]) {
    if (typeof credits[key] === "number") return credits[key] as number;
  }
  return null;
}

function isCreditExhausted(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes("insufficient credit") ||
    lower.includes("no credits") ||
    lower.includes("out of credit") ||
    lower.includes("credits exhausted") ||
    lower.includes("credit limit exceeded") ||
    lower.includes("clearout api 402")
  );
}

// ---------------------------------------------------------------------------
// ZeroBounce API client
// ---------------------------------------------------------------------------

const ZEROBOUNCE_BASE = "https://api.zerobounce.net/v2";

interface ZBVerifyResult {
  address: string;
  status: string;
  sub_status: string;
  free_email: boolean;
  did_you_mean: string | null;
  domain: string | null;
  domain_age_days: string;
  smtp_provider: string;
  mx_found: string;
  mx_record: string;
  firstname: string;
  lastname: string;
  gender: string;
  _schema_warning?: string;
}

function getZBKey(): string {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key) throw new Error("ZEROBOUNCE_API_KEY not set");
  return key;
}

function validateZBResponseShape(
  data: Record<string, unknown>
): string | null {
  const required = ["address", "status"];
  const missing = required.filter((k) => !(k in data));
  if (missing.length > 0) {
    return `ZeroBounce response missing fields: ${missing.join(", ")}. API may have changed.`;
  }
  return null;
}

async function zbVerifyEmail(email: string): Promise<ZBVerifyResult> {
  const params = new URLSearchParams({
    api_key: getZBKey(),
    email,
    ip_address: "",
  });

  const res = await fetch(`${ZEROBOUNCE_BASE}/validate?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as Record<string, unknown>;

  if (json.error) {
    throw new Error(`ZeroBounce error: ${String(json.error)}`);
  }

  const warning = validateZBResponseShape(json);
  const result: ZBVerifyResult = {
    address: String(json.address ?? ""),
    status: String(json.status ?? ""),
    sub_status: String(json.sub_status ?? ""),
    free_email: Boolean(json.free_email),
    did_you_mean: (json.did_you_mean as string | null) ?? null,
    domain: (json.domain as string | null) ?? null,
    domain_age_days: String(json.domain_age_days ?? ""),
    smtp_provider: String(json.smtp_provider ?? ""),
    mx_found: String(json.mx_found ?? ""),
    mx_record: String(json.mx_record ?? ""),
    firstname: String(json.firstname ?? ""),
    lastname: String(json.lastname ?? ""),
    gender: String(json.gender ?? ""),
  };

  if (warning) result._schema_warning = warning;

  return result;
}

async function getZBCredits(): Promise<number> {
  const params = new URLSearchParams({ api_key: getZBKey() });
  const res = await fetch(`${ZEROBOUNCE_BASE}/getcredits?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { Credits: number };

  if (json.Credits === -1) {
    throw new Error("ZeroBounce: Invalid API key");
  }

  return json.Credits;
}

function isZBCreditExhausted(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes("insufficient credit") ||
    lower.includes("no credits") ||
    lower.includes("credits exhausted") ||
    lower.includes("zerobounce api 402") ||
    lower.includes("invalid api key")
  );
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({
    name: "wavelength",
    version: "1.0.0",
  });

  // -- validate_email --------------------------------------------------------
  server.tool(
    "validate_email",
    "Validate one or more email addresses via Clearout. Returns deliverability verdict, disposable/free/role flags, and bounce type. Costs 1 credit per email. Pass a single email string or an array of up to 50.",
    {
      email: z
        .union([
          z.string().email(),
          z.array(z.string().email()).min(1).max(50),
        ])
        .describe("A single email address or array of email addresses"),
    },
    async ({ email }) => {
      const emails = Array.isArray(email) ? email : [email];

      // Single email — simple path
      if (emails.length === 1) {
        try {
          const result = await verifyEmail(emails[0]);

          // Fetch credit balance (non-fatal)
          let creditsRemaining: Record<string, unknown> | null = null;
          try {
            const { credits } = await getCredits();
            creditsRemaining = credits;
          } catch {
            // best-effort
          }

          const response = {
            ...result,
            _credits_used: 1,
            _credits_remaining: creditsRemaining,
          };

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(response, null, 2) },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: isCreditExhausted(msg)
                  ? JSON.stringify(
                      {
                        error:
                          "Clearout credits exhausted. Purchase more at clearout.io to continue.",
                        credits_used: 0,
                      },
                      null,
                      2
                    )
                  : `Error: ${msg}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Multiple emails — pre-flight credit check, then sequential
      let preflightCredits: Record<string, unknown> | null = null;
      try {
        const { credits } = await getCredits();
        preflightCredits = credits;
        const avail = extractAvailableCredits(credits);
        if (avail !== null && avail < emails.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: `Insufficient credits. You have ${avail} but requested ${emails.length} validations.`,
                    credits_remaining: credits,
                    suggestion:
                      avail > 0
                        ? `Reduce batch to ${avail} emails or purchase more credits.`
                        : "Purchase more credits at clearout.io to continue.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      } catch {
        // Pre-flight is best-effort — continue without it
      }

      const results: Array<
        ClearoutVerifyResult | { email: string; error: string }
      > = [];
      let rateLimited = false;
      let creditExhausted = false;
      let creditsUsed = 0;

      for (let i = 0; i < emails.length; i++) {
        const addr = emails[i];

        if (rateLimited || creditExhausted) {
          results.push({
            email: addr,
            error: creditExhausted
              ? "Skipped — credits exhausted"
              : "Skipped — rate limited",
          });
          continue;
        }

        try {
          const result = await verifyEmail(addr);
          results.push(result);
          creditsUsed++;

          if (
            result._rate_limit_remaining !== undefined &&
            result._rate_limit_remaining < 2
          ) {
            rateLimited = true;
          }

          // Small delay between requests
          if (i < emails.length - 1) {
            await new Promise((r) => setTimeout(r, 200));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isCreditExhausted(msg)) {
            creditExhausted = true;
            results.push({ email: addr, error: "Credits exhausted" });
          } else if (
            msg.includes("429") ||
            msg.toLowerCase().includes("rate")
          ) {
            rateLimited = true;
            results.push({ email: addr, error: "Rate limited" });
          } else {
            results.push({ email: addr, error: msg });
          }
        }
      }

      // Post-flight: fetch current credit balance
      let creditsRemaining: Record<string, unknown> | null = null;
      try {
        const { credits } = await getCredits();
        creditsRemaining = credits;
      } catch {
        // non-fatal
      }

      const summary = {
        total: emails.length,
        completed: results.filter((r) => "status" in r).length,
        errors: results.filter((r) => "error" in r).length,
        credits_used: creditsUsed,
        credits_remaining: creditsRemaining,
        rate_limited: rateLimited,
        credit_exhausted: creditExhausted,
        results,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    }
  );

  // -- zb_validate_email -----------------------------------------------------
  server.tool(
    "zb_validate_email",
    "Validate one or more email addresses via ZeroBounce. Returns status, sub_status, free_email, domain age, MX records, SMTP provider. Costs 1 credit per email (0 for unknown results). Pass a single email string or an array of up to 50.",
    {
      email: z
        .union([
          z.string().email(),
          z.array(z.string().email()).min(1).max(50),
        ])
        .describe("A single email address or array of email addresses"),
    },
    async ({ email }) => {
      const emails = Array.isArray(email) ? email : [email];

      // Single email — simple path
      if (emails.length === 1) {
        try {
          const result = await zbVerifyEmail(emails[0]);

          let creditsRemaining: number | null = null;
          try {
            creditsRemaining = await getZBCredits();
          } catch {
            // best-effort
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ...result,
                    _credits_used: result.status === "unknown" ? 0 : 1,
                    _credits_remaining: creditsRemaining,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: isZBCreditExhausted(msg)
                  ? JSON.stringify(
                      {
                        error:
                          "ZeroBounce credits exhausted. Purchase more at zerobounce.net to continue.",
                        credits_used: 0,
                      },
                      null,
                      2
                    )
                  : `Error: ${msg}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Multiple emails — pre-flight credit check, then sequential
      try {
        const avail = await getZBCredits();
        if (avail < emails.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: `Insufficient ZeroBounce credits. You have ${avail} but requested ${emails.length} validations.`,
                    credits_remaining: avail,
                    suggestion:
                      avail > 0
                        ? `Reduce batch to ${avail} emails or purchase more credits.`
                        : "Purchase more credits at zerobounce.net to continue.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      } catch {
        // Pre-flight is best-effort
      }

      const results: Array<
        ZBVerifyResult | { email: string; error: string }
      > = [];
      let rateLimited = false;
      let creditExhausted = false;
      let creditsUsed = 0;

      for (let i = 0; i < emails.length; i++) {
        const addr = emails[i];

        if (rateLimited || creditExhausted) {
          results.push({
            email: addr,
            error: creditExhausted
              ? "Skipped — credits exhausted"
              : "Skipped — rate limited",
          });
          continue;
        }

        try {
          const result = await zbVerifyEmail(addr);
          results.push(result);
          if (result.status !== "unknown") creditsUsed++;

          if (i < emails.length - 1) {
            await new Promise((r) => setTimeout(r, 200));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isZBCreditExhausted(msg)) {
            creditExhausted = true;
            results.push({ email: addr, error: "Credits exhausted" });
          } else if (
            msg.includes("429") ||
            msg.toLowerCase().includes("rate")
          ) {
            rateLimited = true;
            results.push({ email: addr, error: "Rate limited" });
          } else {
            results.push({ email: addr, error: msg });
          }
        }
      }

      // Post-flight credit balance
      let creditsRemaining: number | null = null;
      try {
        creditsRemaining = await getZBCredits();
      } catch {
        // non-fatal
      }

      const summary = {
        total: emails.length,
        completed: results.filter((r) => "status" in r).length,
        errors: results.filter((r) => "error" in r).length,
        credits_used: creditsUsed,
        credits_remaining: creditsRemaining,
        rate_limited: rateLimited,
        credit_exhausted: creditExhausted,
        results,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    }
  );

  // -- check_credits ---------------------------------------------------------
  server.tool(
    "check_credits",
    "Check remaining email verification credits for all providers (Clearout and ZeroBounce). Costs 0 credits.",
    {},
    async () => {
      const report: Record<string, unknown> = {};

      try {
        const { credits } = await getCredits();
        report.clearout = credits;
      } catch (err) {
        report.clearout = {
          error: err instanceof Error ? err.message : String(err),
        };
      }

      try {
        const credits = await getZBCredits();
        report.zerobounce = { available: credits };
      } catch (err) {
        report.zerobounce = {
          error: err instanceof Error ? err.message : String(err),
        };
      }

      report.note = "1 credit = 1 email verification per provider";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

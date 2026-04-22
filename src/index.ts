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
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Multiple emails — sequential with rate limit awareness
      const results: Array<
        ClearoutVerifyResult | { email: string; error: string }
      > = [];
      let rateLimited = false;

      for (let i = 0; i < emails.length; i++) {
        const addr = emails[i];

        if (rateLimited) {
          results.push({ email: addr, error: "Skipped — rate limited" });
          continue;
        }

        try {
          const result = await verifyEmail(addr);
          results.push(result);

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
          if (msg.includes("429") || msg.toLowerCase().includes("rate")) {
            rateLimited = true;
            results.push({ email: addr, error: "Rate limited" });
          } else {
            results.push({ email: addr, error: msg });
          }
        }
      }

      const summary = {
        total: emails.length,
        completed: results.filter((r) => "status" in r).length,
        errors: results.filter((r) => "error" in r).length,
        rate_limited: rateLimited,
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
    "Check remaining Clearout email verification credits. Costs 0 credits.",
    {},
    async () => {
      try {
        const { credits } = await getCredits();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { credits, note: "1 credit = 1 email verification" },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

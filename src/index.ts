import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSql } from "./db.js";

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
  const key = process.env.ZERO_BOUNCE_API_KEY;
  if (!key) throw new Error("ZERO_BOUNCE_API_KEY not set");
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
// Apollo API client
// ---------------------------------------------------------------------------

const APOLLO_BASE = "https://api.apollo.io/api/v1";

function getApolloKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error("APOLLO_API_KEY not set");
  return key;
}

async function apolloPost(
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": getApolloKey(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apolloGet(path: string): Promise<unknown> {
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    headers: { "X-Api-Key": getApolloKey() },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Reply.io API client
// ---------------------------------------------------------------------------

const REPLY_BASE = "https://api.reply.io";

function getReplyKey(): string {
  const key = process.env.REPLY_IO_API_KEY;
  if (!key) throw new Error("REPLY_IO_API_KEY not set");
  return key;
}

async function replyGet(path: string): Promise<unknown> {
  const res = await fetch(`${REPLY_BASE}${path}`, {
    headers: { "X-API-Key": getReplyKey() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Reply.io API ${res.status}: ${body}`);
  }
  return res.json();
}

async function replyPost(
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${REPLY_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-API-Key": getReplyKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
  };
}

// ---------------------------------------------------------------------------
// Bulk validation clients
// ---------------------------------------------------------------------------

const ZEROBOUNCE_BULK_BASE = "https://bulkapi.zerobounce.net/v2";

function emailsToCsv(emails: string[]): string {
  return "email\n" + emails.join("\n");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const values = parseCsvLine(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = (values[i] ?? "").trim();
      });
      return row;
    });
}

// -- Clearout bulk --

async function clearoutBulkSubmit(emails: string[]): Promise<string> {
  const csv = emailsToCsv(emails);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([csv], { type: "text/csv" }),
    "emails.csv"
  );
  formData.append("optimize", "highest_accuracy");

  const res = await fetch(`${CLEAROUT_BASE}/email_verify/bulk`, {
    method: "POST",
    headers: { Authorization: `Bearer:${getClearoutKey()}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout bulk API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    status: string;
    data?: { list_id: string };
    error?: { message: string };
  };

  if (json.status === "error" || !json.data?.list_id) {
    throw new Error(
      `Clearout bulk submit failed: ${json.error?.message ?? JSON.stringify(json)}`
    );
  }

  return json.data.list_id;
}

async function clearoutBulkStatus(
  listId: string
): Promise<{ progress_status: string; percentile: number }> {
  const params = new URLSearchParams({ list_id: listId });
  const res = await fetch(
    `${CLEAROUT_BASE}/email_verify/bulk/progress_status?${params}`,
    { headers: { Authorization: `Bearer:${getClearoutKey()}` } }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout status API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    status: string;
    data?: { progress_status: string; percentile: number };
  };

  return {
    progress_status: json.data?.progress_status ?? "unknown",
    percentile: json.data?.percentile ?? 0,
  };
}

async function clearoutBulkResults(listId: string): Promise<string> {
  const res = await fetch(`${CLEAROUT_BASE}/download/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer:${getClearoutKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ list_id: listId }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout download API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    status: string;
    data?: { url: string };
    error?: { message: string };
  };

  if (json.status === "error" || !json.data?.url) {
    throw new Error(
      `Clearout download failed: ${json.error?.message ?? "no URL returned"}`
    );
  }

  const fileRes = await fetch(json.data.url);
  if (!fileRes.ok) {
    throw new Error(`Failed to download results file: ${fileRes.status}`);
  }

  return await fileRes.text();
}

// -- ZeroBounce bulk --

async function zbBulkSubmit(emails: string[]): Promise<string> {
  const csv = emailsToCsv(emails);
  const formData = new FormData();
  formData.append("api_key", getZBKey());
  formData.append("email_address_column", "1");
  formData.append("has_header_row", "true");
  formData.append(
    "file",
    new Blob([csv], { type: "text/csv" }),
    "emails.csv"
  );

  const res = await fetch(`${ZEROBOUNCE_BULK_BASE}/sendfile`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce bulk API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    success: boolean;
    file_id?: string;
    message?: string;
  };

  if (!json.success || !json.file_id) {
    throw new Error(
      `ZeroBounce bulk submit failed: ${json.message ?? "Unknown error"}`
    );
  }

  return json.file_id;
}

async function zbBulkStatus(
  fileId: string
): Promise<{ file_status: string; complete_percentage: string }> {
  const params = new URLSearchParams({
    api_key: getZBKey(),
    file_id: fileId,
  });
  const res = await fetch(`${ZEROBOUNCE_BULK_BASE}/filestatus?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce status API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return {
    file_status: String(json.file_status ?? "unknown"),
    complete_percentage: String(json.complete_percentage ?? "0"),
  };
}

async function zbBulkResults(fileId: string): Promise<string> {
  const params = new URLSearchParams({
    api_key: getZBKey(),
    file_id: fileId,
  });
  const res = await fetch(`${ZEROBOUNCE_BULK_BASE}/getfile?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce results API ${res.status}: ${body}`);
  }

  return await res.text();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export interface ServerContext {
  onToolCall?: (entry: {
    tool: string;
    provider?: string;
    email_count: number;
    credits_used: number;
    status: "success" | "error" | "partial";
    error_message?: string;
    duration_ms: number;
  }) => Promise<void>;
}

export function createServer(ctx?: ServerContext): McpServer {
  const server = new McpServer({
    name: "wavelength",
    version: "1.0.0",
  });

  // Wrap a tool handler to log actual credits from its response
  function tracked<T>(
    tool: string,
    meta: {
      provider: string | null | ((args: T) => string | null);
      emailCount: (args: T) => number;
    },
    handler: (args: T, extra: any) => Promise<any>
  ): (args: T, extra: any) => Promise<any> {
    return async (args: T, extra: any) => {
      const start = Date.now();
      const result = await handler(args, extra);

      if (ctx?.onToolCall) {
        let creditsUsed = 0;
        try {
          const text = result.content?.[0]?.text;
          if (text) {
            const parsed = JSON.parse(text);
            creditsUsed = parsed.credits_used ?? parsed._credits_used ?? 0;
          }
        } catch {}

        const provider =
          typeof meta.provider === "function"
            ? meta.provider(args)
            : meta.provider;

        await ctx.onToolCall({
          tool,
          provider: provider ?? undefined,
          email_count: meta.emailCount(args),
          credits_used: creditsUsed,
          status: result.isError ? "error" : "success",
          error_message: result.isError
            ? result.content?.[0]?.text?.slice(0, 500)
            : undefined,
          duration_ms: Date.now() - start,
        }).catch(() => {});
      }

      return result;
    };
  }

  // -- validate_email --------------------------------------------------------
  server.tool(
    "validate_email",
    "Validate up to 20 email addresses via Clearout (instant, real-time). Returns deliverability verdict, disposable/free/role flags, and bounce type. Costs 1 credit per email. For more than 20 emails, use bulk_validate instead.",
    {
      email: z
        .union([
          z.string().email(),
          z.array(z.string().email()).min(1).max(20),
        ])
        .describe("A single email address or array of email addresses"),
    },
    tracked("validate_email", { provider: "clearout", emailCount: ({ email }: any) => Array.isArray(email) ? email.length : 1 },
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
    })
  );

  // -- zb_validate_email -----------------------------------------------------
  server.tool(
    "zb_validate_email",
    "Validate up to 20 email addresses via ZeroBounce (instant, real-time). Returns status, sub_status, free_email, domain age, MX records, SMTP provider. Costs 1 credit per email (0 for unknown results). For more than 20 emails, use bulk_validate instead.",
    {
      email: z
        .union([
          z.string().email(),
          z.array(z.string().email()).min(1).max(20),
        ])
        .describe("A single email address or array of email addresses"),
    },
    tracked("zb_validate_email", { provider: "zerobounce", emailCount: ({ email }: any) => Array.isArray(email) ? email.length : 1 },
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
    })
  );

  // -- bulk_validate ---------------------------------------------------------
  server.tool(
    "bulk_validate",
    "Submit a batch of emails for async validation (use for more than 20 emails). Returns a job_id to track progress. Processing takes 2-10 minutes depending on batch size. Call bulk_status to check progress, then bulk_results to retrieve data.",
    {
      provider: z
        .enum(["clearout", "zerobounce"])
        .describe("Which validation provider to use"),
      emails: z
        .array(z.string().email())
        .min(1)
        .max(10000)
        .describe("Array of email addresses to validate"),
    },
    tracked("bulk_validate", { provider: ({ provider }: any) => provider, emailCount: ({ emails }: any) => emails.length },
    async ({ provider, emails }) => {
      try {
        const jobId =
          provider === "clearout"
            ? await clearoutBulkSubmit(emails)
            : await zbBulkSubmit(emails);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  provider,
                  job_id: jobId,
                  email_count: emails.length,
                  status: "submitted",
                  next_step: `Call bulk_status with provider="${provider}" and job_id="${jobId}" to check progress.`,
                },
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
    })
  );

  // -- bulk_status ----------------------------------------------------------
  server.tool(
    "bulk_status",
    "Check progress of a bulk validation job. Returns completion percentage and whether results are ready to download.",
    {
      provider: z
        .enum(["clearout", "zerobounce"])
        .describe("Which provider the job was submitted to"),
      job_id: z.string().describe("The job_id returned from bulk_validate"),
    },
    tracked("bulk_status", { provider: ({ provider }: any) => provider, emailCount: () => 0 },
    async ({ provider, job_id }) => {
      try {
        let status: Record<string, unknown>;

        if (provider === "clearout") {
          const s = await clearoutBulkStatus(job_id);
          const done =
            s.progress_status.toLowerCase() === "completed" ||
            s.percentile >= 100;
          status = {
            provider,
            job_id,
            status: s.progress_status,
            complete_percentage: s.percentile,
            is_complete: done,
          };
        } else {
          const s = await zbBulkStatus(job_id);
          const done = s.file_status === "Complete";
          status = {
            provider,
            job_id,
            status: s.file_status,
            complete_percentage: s.complete_percentage,
            is_complete: done,
          };
        }

        status.next_step = status.is_complete
          ? `Call bulk_results with provider="${provider}" and job_id="${job_id}" to download results.`
          : "Not complete yet. Check again in 30 seconds.";

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(status, null, 2),
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
    })
  );

  // -- bulk_results ---------------------------------------------------------
  server.tool(
    "bulk_results",
    "Download results of a completed bulk validation job. Returns structured validation data for each email. Only call after bulk_status shows is_complete: true.",
    {
      provider: z
        .enum(["clearout", "zerobounce"])
        .describe("Which provider the job was submitted to"),
      job_id: z.string().describe("The job_id returned from bulk_validate"),
    },
    tracked("bulk_results", { provider: ({ provider }: any) => provider, emailCount: () => 0 },
    async ({ provider, job_id }) => {
      try {
        const csvText =
          provider === "clearout"
            ? await clearoutBulkResults(job_id)
            : await zbBulkResults(job_id);

        const parsed = parseCsv(csvText);

        if (parsed.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "No results parsed from response",
                    raw_preview: csvText.slice(0, 500),
                    _schema_warning:
                      "Response format may have changed. Raw preview included for diagnosis.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  provider,
                  job_id,
                  total_results: parsed.length,
                  results: parsed,
                },
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
    })
  );

  // -- check_credits ---------------------------------------------------------
  server.tool(
    "check_credits",
    "Check remaining email verification credits for all providers (Clearout and ZeroBounce). Costs 0 credits.",
    {},
    tracked("check_credits", { provider: null, emailCount: () => 0 },
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
    })
  );

  // -- reply_list_sequences ---------------------------------------------------
  server.tool(
    "reply_list_sequences",
    "List Reply.io sequences (campaigns). Returns id, name, status, health, and creation date. Use this to find the right sequence before adding contacts. Supports filtering by status (active/paused/new).",
    {
      status: z
        .enum(["active", "paused", "new"])
        .optional()
        .describe("Filter by sequence status"),
      top: z
        .number()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max results to return (default 100)"),
    },
    tracked("reply_list_sequences", { provider: "reply", emailCount: () => 0 },
    async ({ status, top }) => {
      try {
        const params = new URLSearchParams();
        params.set("top", String(top ?? 100));
        if (status) params.set("status", status);

        const data = (await replyGet(
          `/v3/sequences?${params}`
        )) as { items: unknown[]; hasMore: boolean };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total: data.items.length,
                  has_more: data.hasMore,
                  sequences: data.items,
                },
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
    })
  );

  // -- reply_get_sequence -----------------------------------------------------
  server.tool(
    "reply_get_sequence",
    "Get detailed info about a Reply.io sequence including email steps, templates, settings, and linked email accounts. Use to review campaign content or verify before adding contacts.",
    {
      sequence_id: z.number().describe("The sequence/campaign ID"),
    },
    tracked("reply_get_sequence", { provider: "reply", emailCount: () => 0 },
    async ({ sequence_id }) => {
      try {
        const data = await replyGet(`/v2/campaigns/${sequence_id}`);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
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
    })
  );

  // -- reply_search_contact ---------------------------------------------------
  server.tool(
    "reply_search_contact",
    "Look up a contact in Reply.io by email address. Returns profile details, custom fields, creation source, and which sequences they belong to.",
    {
      email: z.string().email().describe("Email address to search for"),
    },
    tracked("reply_search_contact", { provider: "reply", emailCount: () => 1 },
    async ({ email }) => {
      try {
        const data = await replyGet(
          `/v1/people?email=${encodeURIComponent(email)}`
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { found: false, email, message: "No contact found with this email" },
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    })
  );

  // -- reply_push_contacts ----------------------------------------------------
  server.tool(
    "reply_push_contacts",
    "Add one or more contacts to a Reply.io sequence. Creates the contact if new, updates if existing, then pushes to the specified campaign. This is the primary tool for the Grata → Reply.io pipeline. Always confirm with the user before calling.",
    {
      sequence_id: z.number().describe("The sequence/campaign ID to add contacts to"),
      contacts: z
        .array(
          z.object({
            email: z.string().email(),
            firstName: z.string(),
            lastName: z.string().optional(),
            title: z.string().optional(),
            company: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            country: z.string().optional(),
            phone: z.string().optional(),
            linkedInProfile: z.string().optional(),
            customFields: z
              .array(z.object({ key: z.string(), value: z.string() }))
              .optional(),
          })
        )
        .min(1)
        .max(500)
        .describe("Array of contacts to add"),
    },
    tracked("reply_push_contacts", { provider: "reply", emailCount: ({ contacts }: any) => contacts.length },
    async ({ sequence_id, contacts }) => {
      const results: Array<{
        email: string;
        status: "added" | "error";
        error?: string;
      }> = [];

      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        try {
          const payload: Record<string, unknown> = {
            campaignId: sequence_id,
            email: contact.email,
            firstName: contact.firstName,
          };
          if (contact.lastName) payload.lastName = contact.lastName;
          if (contact.title) payload.title = contact.title;
          if (contact.company) payload.company = contact.company;
          if (contact.city) payload.city = contact.city;
          if (contact.state) payload.state = contact.state;
          if (contact.country) payload.country = contact.country;
          if (contact.phone) payload.phone = contact.phone;
          if (contact.linkedInProfile)
            payload.linkedInProfile = contact.linkedInProfile;
          if (contact.customFields)
            payload.customFields = contact.customFields;

          const res = await replyPost(
            "/v1/actions/addandpushtocampaign",
            payload
          );

          if (res.status >= 200 && res.status < 300) {
            results.push({ email: contact.email, status: "added" });
          } else {
            const errMsg =
              typeof res.body === "object" && res.body !== null
                ? JSON.stringify(res.body)
                : String(res.body);
            results.push({
              email: contact.email,
              status: "error",
              error: `HTTP ${res.status}: ${errMsg}`,
            });
          }

          // Small delay between requests to avoid rate limits
          if (i < contacts.length - 1) {
            await new Promise((r) => setTimeout(r, 300));
          }
        } catch (err) {
          results.push({
            email: contact.email,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const added = results.filter((r) => r.status === "added").length;
      const errors = results.filter((r) => r.status === "error").length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sequence_id,
                total: contacts.length,
                added,
                errors,
                results,
              },
              null,
              2
            ),
          },
        ],
        isError: errors > 0 && added === 0,
      };
    })
  );

  // -- apollo_enrich_person ---------------------------------------------------
  server.tool(
    "apollo_enrich_person",
    "Enrich a single person via Apollo. Provide an email, LinkedIn URL, or name+company combo. Returns verified email, title, LinkedIn, employment history, location, and organization data. Costs 1 Apollo credit.",
    {
      email: z.string().optional().describe("Email address to match"),
      linkedin_url: z
        .string()
        .optional()
        .describe("LinkedIn profile URL to match"),
      first_name: z.string().optional().describe("First name (use with last_name + organization_name)"),
      last_name: z.string().optional().describe("Last name (use with first_name + organization_name)"),
      organization_name: z
        .string()
        .optional()
        .describe("Company name (use with first_name + last_name)"),
    },
    tracked("apollo_enrich_person", { provider: "apollo", emailCount: () => 1 },
    async (args) => {
      try {
        const data = (await apolloPost("/people/match", args)) as {
          person: Record<string, unknown> | null;
        };
        if (!data.person) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { found: false, query: args, message: "No match found" },
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data.person, null, 2) },
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
    })
  );

  // -- apollo_bulk_enrich_people ----------------------------------------------
  server.tool(
    "apollo_bulk_enrich_people",
    "Enrich up to 10 people per call via Apollo bulk match. Provide an array of lookup objects (each with email, linkedin_url, or first_name+last_name+organization_name). For batches larger than 10, call this tool multiple times. Costs 1 credit per matched person.",
    {
      details: z
        .array(
          z.object({
            email: z.string().optional(),
            linkedin_url: z.string().optional(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            organization_name: z.string().optional(),
          })
        )
        .min(1)
        .max(10)
        .describe("Array of person lookup objects (max 10)"),
    },
    tracked("apollo_bulk_enrich_people", { provider: "apollo", emailCount: ({ details }: any) => details.length },
    async ({ details }) => {
      try {
        const data = (await apolloPost("/people/bulk_match", {
          details,
        })) as { matches: Array<Record<string, unknown> | null> };

        const matched = data.matches.filter((m) => m !== null).length;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total: details.length,
                  matched,
                  not_found: details.length - matched,
                  matches: data.matches,
                },
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
    })
  );

  // -- apollo_enrich_org ------------------------------------------------------
  server.tool(
    "apollo_enrich_org",
    "Enrich a company/organization via Apollo. Provide a domain to get company details including industry, size, revenue, location, and technology stack.",
    {
      domain: z.string().describe("Company domain (e.g. 'wavelengthequity.com')"),
    },
    tracked("apollo_enrich_org", { provider: "apollo", emailCount: () => 0 },
    async ({ domain }) => {
      try {
        const data = await apolloPost("/organizations/enrich", { domain });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
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
    })
  );

  // -- apollo_search_people ---------------------------------------------------
  server.tool(
    "apollo_search_people",
    "Search Apollo's database for people matching criteria. Use to find contacts at a company when you don't have specific names. Returns up to 25 results per page.",
    {
      organization_domains: z
        .array(z.string())
        .optional()
        .describe("Company domains to search within"),
      person_titles: z
        .array(z.string())
        .optional()
        .describe("Job titles to filter (e.g. ['CEO', 'Founder', 'Owner'])"),
      person_seniorities: z
        .array(z.string())
        .optional()
        .describe("Seniority levels: owner, founder, c_suite, partner, vp, director, manager"),
      person_locations: z
        .array(z.string())
        .optional()
        .describe("Locations (e.g. ['United States', 'New York'])"),
      page: z.number().optional().describe("Page number (default 1)"),
    },
    tracked("apollo_search_people", { provider: "apollo", emailCount: () => 0 },
    async (args) => {
      try {
        const data = await apolloPost("/mixed_people/api_search", {
          ...args,
          page: args.page ?? 1,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
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
    })
  );

  // -- get_skill_learnings ----------------------------------------------------
  server.tool(
    "get_skill_learnings",
    "Retrieve learned adjustments for a skill. Returns all active learnings, optionally filtered by industry. Call this at the start of every skill run to load accumulated knowledge from previous runs across all users.",
    {
      skill: z
        .string()
        .describe("Skill name (e.g. 'company-processor', 'grata-search-enrichment')"),
      industry: z
        .string()
        .optional()
        .describe("Filter by industry (e.g. 'cybersecurity'). Omit to get all learnings for the skill."),
    },
    async ({ skill, industry }) => {
      const sql = getSql();
      if (!sql) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ learnings: [], note: "Database not configured" }, null, 2),
            },
          ],
        };
      }

      try {
        let rows;
        if (industry) {
          rows = await sql`
            SELECT id, skill, industry, category, content, created_by, created_at
            FROM wl_skill_learnings
            WHERE skill = ${skill}
              AND (industry = ${industry} OR industry IS NULL)
              AND is_active = true
            ORDER BY created_at ASC
          `;
        } else {
          rows = await sql`
            SELECT id, skill, industry, category, content, created_by, created_at
            FROM wl_skill_learnings
            WHERE skill = ${skill}
              AND is_active = true
            ORDER BY created_at ASC
          `;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  skill,
                  industry: industry ?? "all",
                  count: (rows as unknown[]).length,
                  learnings: rows,
                },
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

  // -- save_skill_learning ----------------------------------------------------
  server.tool(
    "save_skill_learning",
    "Save a new learning for a skill. Learnings accumulate across runs and users — every user's Claude instance sees them. Use after calibration, when encountering schema changes, edge cases in title filtering, business model patterns, or data quality issues. Each learning should be a single, actionable insight.",
    {
      skill: z
        .string()
        .describe("Skill name (e.g. 'company-processor', 'grata-search-enrichment')"),
      industry: z
        .string()
        .optional()
        .describe("Industry this learning applies to (e.g. 'cybersecurity'). Omit for global learnings."),
      category: z
        .enum(["adjustment", "schema-change", "edge-case", "pattern"])
        .default("adjustment")
        .describe("Type of learning: adjustment (calibration), schema-change (format change), edge-case (title/role), pattern (business model)"),
      content: z
        .string()
        .describe("The learning itself. Be specific and actionable. E.g. 'MSP with dedicated SOC practice = HIGH eligible, not automatic LOW'"),
    },
    async ({ skill, industry, category, content }) => {
      const sql = getSql();
      if (!sql) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ saved: false, error: "Database not configured" }, null, 2),
            },
          ],
          isError: true,
        };
      }

      try {
        const rows = await sql`
          INSERT INTO wl_skill_learnings (skill, industry, category, content, created_by)
          VALUES (${skill}, ${industry ?? null}, ${category}, ${content}, 'claude')
          RETURNING id, created_at
        `;

        const row = (rows as Record<string, unknown>[])[0];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  saved: true,
                  id: row.id,
                  skill,
                  industry: industry ?? "global",
                  category,
                  content,
                  created_at: row.created_at,
                },
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

  // -- admin_report -----------------------------------------------------------
  server.tool(
    "admin_report",
    "Generate an admin report of all MCP tool usage. Shows calls by tool and provider, credits consumed, error rates, and totals. Optionally filter by time range (default: last 7 days). Also fetches live credit balances from all providers.",
    {
      days: z
        .number()
        .min(1)
        .max(90)
        .optional()
        .describe("Number of days to look back (default 7)"),
    },
    async ({ days }) => {
      const lookback = days ?? 7;
      const report: Record<string, unknown> = { period_days: lookback };

      // -- Live credit balances --
      const credits: Record<string, unknown> = {};
      try {
        const { credits: co } = await getCredits();
        credits.clearout = co;
      } catch (err) {
        credits.clearout = { error: err instanceof Error ? err.message : String(err) };
      }
      try {
        const zb = await getZBCredits();
        credits.zerobounce = { available: zb };
      } catch (err) {
        credits.zerobounce = { error: err instanceof Error ? err.message : String(err) };
      }
      report.live_credits = credits;

      // -- DB usage stats --
      const sql = getSql();
      if (!sql) {
        report.usage = { note: "Database not configured — no usage history available" };
      } else {
        try {
          const summary = await sql`
            SELECT
              tool,
              provider,
              status,
              count(*)::int as call_count,
              coalesce(sum(email_count), 0)::int as total_emails,
              coalesce(sum(credits_used), 0)::int as total_credits,
              coalesce(avg(duration_ms), 0)::int as avg_duration_ms
            FROM wl_calls
            WHERE created_at >= now() - make_interval(days => ${lookback})
            GROUP BY tool, provider, status
            ORDER BY tool, provider, status
          `;

          const totals = await sql`
            SELECT
              count(*)::int as total_calls,
              coalesce(sum(email_count), 0)::int as total_emails,
              coalesce(sum(credits_used), 0)::int as total_credits,
              count(*) filter (where status = 'error')::int as error_count
            FROM wl_calls
            WHERE created_at >= now() - make_interval(days => ${lookback})
          `;

          const users = await sql`
            SELECT u.name, count(c.id)::int as call_count
            FROM wl_calls c
            LEFT JOIN wl_users u ON c.user_id = u.id
            WHERE c.created_at >= now() - make_interval(days => ${lookback})
            GROUP BY u.name
            ORDER BY call_count DESC
          `;

          report.usage = {
            by_tool: summary,
            totals: (totals as Record<string, unknown>[])[0] ?? {},
            by_user: users,
          };
        } catch (err) {
          report.usage = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(report, null, 2) },
        ],
      };
    }
  );

  return server;
}

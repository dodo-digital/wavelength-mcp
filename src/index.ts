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

  return server;
}

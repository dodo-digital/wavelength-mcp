import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSql } from "./db.js";
import * as clearout from "./clients/clearout.js";
import * as zerobounce from "./clients/zerobounce.js";
import * as apollo from "./clients/apollo.js";
import * as reply from "./clients/reply.js";
import { parseCsv } from "./utils/csv.js";

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export interface ServerContext {
  userId?: string | null;
  onToolCall?: (entry: {
    tool: string;
    provider?: string;
    email_count: number;
    credits_used: number;
    status: "success" | "error" | "partial";
    error_message?: string;
    duration_ms: number;
    details?: Record<string, unknown>;
  }) => Promise<void>;
}

// -- Row types for context tools --------------------------------------------

interface ContextRow {
  id: string;
  slug: string;
  doc_type: string;
  title: string;
  content?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  version: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ContextHistoryRow {
  version: number;
  change_type: string;
  changed_by: string | null;
  title: string;
  tags: string[];
  created_at: string;
}

interface UpsertResultRow {
  id: string;
  slug: string;
  doc_type: string;
  title: string;
  tags: string[];
  version: number;
  updated_at: string;
  change_type: "created" | "updated";
}

export function createServer(ctx?: ServerContext): McpServer {
  const server = new McpServer({
    name: "wavelength",
    version: "1.0.0",
  });

  // Gate a tool behind authenticated user — returns error response or null
  function requireAuth(label: string) {
    if (ctx?.userId) return null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Authentication required for ${label}` }, null, 2),
        },
      ],
      isError: true,
    };
  }

  // Tool result shape returned by handlers
  type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  };

  // Wrap a tool handler to log actual credits from its response
  function tracked<T>(
    tool: string,
    meta: {
      provider: string | null | ((args: T) => string | null);
      emailCount: (args: T) => number;
    },
    handler: (args: T, extra: unknown) => Promise<ToolResult>
  ): (args: T, extra: unknown) => Promise<ToolResult> {
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
          const result = await clearout.verifyEmail(emails[0]);

          // Fetch credit balance (non-fatal)
          let creditsRemaining: Record<string, unknown> | null = null;
          try {
            const { credits } = await clearout.getCredits();
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
                text: clearout.isCreditExhausted(msg)
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
        const { credits } = await clearout.getCredits();
        preflightCredits = credits;
        const avail = clearout.extractAvailableCredits(credits);
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
        clearout.ClearoutVerifyResult | { email: string; error: string }
      > = [];
      let rateLimited = false;
      let creditExhausted = false;
      let creditsUsed = 0;
      const BATCH_SIZE = 5;

      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        if (rateLimited || creditExhausted) {
          for (let j = i; j < emails.length; j++) {
            results.push({
              email: emails[j],
              error: creditExhausted
                ? "Skipped — credits exhausted"
                : "Skipped — rate limited",
            });
          }
          break;
        }

        const batch = emails.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map((addr) => clearout.verifyEmail(addr))
        );

        for (let j = 0; j < batchResults.length; j++) {
          const br = batchResults[j];
          if (br.status === "fulfilled") {
            results.push(br.value);
            creditsUsed++;
            if (
              br.value._rate_limit_remaining !== undefined &&
              br.value._rate_limit_remaining < 2
            ) {
              rateLimited = true;
            }
          } else {
            const msg =
              br.reason instanceof Error
                ? br.reason.message
                : String(br.reason);
            if (clearout.isCreditExhausted(msg)) {
              creditExhausted = true;
              results.push({ email: batch[j], error: "Credits exhausted" });
            } else if (
              msg.includes("429") ||
              msg.toLowerCase().includes("rate")
            ) {
              rateLimited = true;
              results.push({ email: batch[j], error: "Rate limited" });
            } else {
              results.push({ email: batch[j], error: msg });
            }
          }
        }

        // Delay between batches
        if (i + BATCH_SIZE < emails.length && !rateLimited && !creditExhausted) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Post-flight: fetch current credit balance
      let creditsRemaining: Record<string, unknown> | null = null;
      try {
        const { credits } = await clearout.getCredits();
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
          const result = await zerobounce.verifyEmail(emails[0]);

          let creditsRemaining: number | null = null;
          try {
            creditsRemaining = await zerobounce.getCredits();
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
                text: zerobounce.isCreditExhausted(msg)
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
        const avail = await zerobounce.getCredits();
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
        zerobounce.ZBVerifyResult | { email: string; error: string }
      > = [];
      let rateLimited = false;
      let creditExhausted = false;
      let creditsUsed = 0;
      const BATCH_SIZE = 5;

      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        if (rateLimited || creditExhausted) {
          for (let j = i; j < emails.length; j++) {
            results.push({
              email: emails[j],
              error: creditExhausted
                ? "Skipped — credits exhausted"
                : "Skipped — rate limited",
            });
          }
          break;
        }

        const batch = emails.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map((addr) => zerobounce.verifyEmail(addr))
        );

        for (let j = 0; j < batchResults.length; j++) {
          const br = batchResults[j];
          if (br.status === "fulfilled") {
            results.push(br.value);
            if (br.value.status !== "unknown") creditsUsed++;
          } else {
            const msg =
              br.reason instanceof Error
                ? br.reason.message
                : String(br.reason);
            if (zerobounce.isCreditExhausted(msg)) {
              creditExhausted = true;
              results.push({ email: batch[j], error: "Credits exhausted" });
            } else if (
              msg.includes("429") ||
              msg.toLowerCase().includes("rate")
            ) {
              rateLimited = true;
              results.push({ email: batch[j], error: "Rate limited" });
            } else {
              results.push({ email: batch[j], error: msg });
            }
          }
        }

        // Delay between batches
        if (i + BATCH_SIZE < emails.length && !rateLimited && !creditExhausted) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Post-flight credit balance
      let creditsRemaining: number | null = null;
      try {
        creditsRemaining = await zerobounce.getCredits();
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
            ? await clearout.bulkSubmit(emails)
            : await zerobounce.bulkSubmit(emails);

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
          const s = await clearout.bulkStatus(job_id);
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
          const s = await zerobounce.bulkStatus(job_id);
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
            ? await clearout.bulkResults(job_id)
            : await zerobounce.bulkResults(job_id);

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
        const { credits } = await clearout.getCredits();
        report.clearout = credits;
      } catch (err) {
        report.clearout = {
          error: err instanceof Error ? err.message : String(err),
        };
      }

      try {
        const credits = await zerobounce.getCredits();
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

        const data = (await reply.get(
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
        const data = await reply.get(`/v2/campaigns/${sequence_id}`);
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
        const data = await reply.get(
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
    "Add up to 50 contacts to a Reply.io sequence. Creates the contact if new, updates if existing, then pushes to the specified campaign. For larger batches, call multiple times. Always confirm with the user before calling.",
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
        .max(50)
        .describe("Array of contacts to add (max 50 per call)"),
    },
    tracked("reply_push_contacts", { provider: "reply", emailCount: ({ contacts }: any) => contacts.length },
    async ({ sequence_id, contacts }) => {
      const results: Array<{
        email: string;
        status: "added" | "error";
        error?: string;
      }> = [];

      const BATCH_SIZE = 5;

      async function pushOne(contact: typeof contacts[number]): Promise<{
        email: string;
        status: "added" | "error";
        error?: string;
      }> {
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

        try {
          const res = await reply.post(
            "/v1/actions/addandpushtocampaign",
            payload
          );
          if (res.status >= 200 && res.status < 300) {
            return { email: contact.email, status: "added" };
          }
          const errMsg =
            typeof res.body === "object" && res.body !== null
              ? JSON.stringify(res.body)
              : String(res.body);
          return {
            email: contact.email,
            status: "error",
            error: `HTTP ${res.status}: ${errMsg}`,
          };
        } catch (err) {
          return {
            email: contact.email,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
        const batch = contacts.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(pushOne));
        results.push(...batchResults);

        // Delay between batches to avoid rate limits
        if (i + BATCH_SIZE < contacts.length) {
          await new Promise((r) => setTimeout(r, 200));
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
        const data = (await apollo.post("/people/match", args)) as {
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
        const data = (await apollo.post("/people/bulk_match", {
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
        const data = await apollo.post("/organizations/enrich", { domain });
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
        const data = await apollo.post("/mixed_people/api_search", {
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
      const denied = requireAuth("get_skill_learnings");
      if (denied) return denied;

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
      const denied = requireAuth("save_skill_learning");
      if (denied) return denied;

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

  // -- query_context ----------------------------------------------------------
  server.tool(
    "query_context",
    `Search shared context documents (thesis, sources, scoring criteria, templates, etc.). Returns matching documents by slug, doc_type, tags, or full-text keyword search. Use this at the start of skill runs to load the latest thesis, scoring criteria, or any shared reference material.

TAG TAXONOMY — use these namespaced tags for querying:
  industry/{slug}    — Target industry (e.g. industry/cybersecurity, industry/fire-safety, industry/dental-it)
  skill/{slug}       — Which skill uses this (e.g. skill/deal-analysis, skill/grata-search-enrichment)
  source/{slug}      — Data source (e.g. source/hubspot, source/onedrive, source/grata, source/apollo)
  status/{status}    — Document state (e.g. status/active, status/draft, status/archived)
  topic/{slug}       — Subject matter (e.g. topic/scoring, topic/outreach, topic/thesis)
  company/{slug}     — Company-specific context (e.g. company/acme-security)
  person/{slug}      — Person-specific context (e.g. person/dino-bebeslic)

Query examples:
  slug: "thesis" → get the investment thesis (includes version number)
  tags: ["industry/cybersecurity"] → all context for cybersecurity deals
  tags: ["skill/deal-analysis"] → everything deal-analysis needs
  doc_type: "source" → all data source registries
  keyword: "EBITDA margin" → full-text search

When called with no parameters, returns a summary index (no content) to save tokens. Use slug to fetch full document.
Set include_history: true to see edit history for a document.`,
    {
      slug: z
        .string()
        .optional()
        .describe("Exact slug to retrieve (e.g. 'thesis', 'sources'). Returns one document with full content."),
      doc_type: z
        .string()
        .optional()
        .describe("Filter by document type: 'thesis', 'reference', 'source', 'criteria', 'template'"),
      tags: z
        .array(z.string().max(200))
        .max(50)
        .optional()
        .describe("Filter by namespaced tags — returns docs matching ANY tag. Use: industry/{slug}, skill/{slug}, source/{slug}, status/{status}, topic/{slug}, company/{slug}, person/{slug}"),
      keyword: z
        .string()
        .max(500, "Keyword too long")
        .optional()
        .describe("Full-text search across title and content"),
      include_history: z
        .boolean()
        .optional()
        .describe("Include edit history (version log with who changed what and when). Only works with slug lookup."),
    },
    async ({ slug, doc_type, tags, keyword, include_history }) => {
      const denied = requireAuth("query_context");
      if (denied) return denied;

      const sql = getSql();
      if (!sql) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ documents: [], note: "Database not configured" }, null, 2),
            },
          ],
        };
      }

      const start = Date.now();
      let result: { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      let logDetails: Record<string, unknown> = {
        query: { slug, doc_type, tags, keyword, include_history },
      };

      try {
        let payload: Record<string, unknown>;

        // Path 1: Exact slug lookup (with optional history)
        if (slug) {
          const rows = (await sql`
            SELECT id, slug, doc_type, title, content, tags, metadata, version, updated_by, created_at, updated_at
            FROM wl_context
            WHERE slug = ${slug}
            LIMIT 1
          `) as ContextRow[];

          if (include_history && rows.length > 0) {
            const history = (await sql`
              SELECT version, change_type, changed_by, title, tags, created_at
              FROM wl_context_history
              WHERE slug = ${slug}
              ORDER BY version DESC
              LIMIT 20
            `) as ContextHistoryRow[];

            payload = { count: 1, documents: rows, history };
          } else {
            payload = { count: rows.length, documents: rows };
          }

          logDetails.result_count = rows.length;
          logDetails.slugs = rows.map((r) => r.slug);
        } else if (keyword?.trim() || (tags && tags.length > 0) || doc_type) {
          // Path 2: Composable search (keyword + tags + doc_type — any combination)
          const rows = (await sql`
            SELECT id, slug, doc_type, title, tags, metadata, version, updated_by, created_at, updated_at
            FROM wl_context
            WHERE true
              ${keyword?.trim() ? sql`AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')) @@ plainto_tsquery('english', ${keyword.trim()})` : sql``}
              ${tags && tags.length > 0 ? sql`AND tags && ${tags}` : sql``}
              ${doc_type ? sql`AND doc_type = ${doc_type}` : sql``}
            ORDER BY updated_at DESC
            LIMIT 20
          `) as ContextRow[];

          payload = { count: rows.length, documents: rows };
          logDetails.result_count = rows.length;
          logDetails.slugs = rows.map((r) => r.slug);
        } else {
          // Path 3: List all — summary only (no content) to save tokens
          const rows = (await sql`
            SELECT id, slug, doc_type, title, tags, metadata, version, updated_by, created_at, updated_at
            FROM wl_context
            ORDER BY updated_at DESC
            LIMIT 50
          `) as ContextRow[];

          payload = { count: rows.length, documents: rows };
          logDetails.result_count = rows.length;
          logDetails.slugs = rows.map((r) => r.slug);
        }

        result = { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        console.error("[query_context]", err);
        result = {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Query failed" }, null, 2) }],
          isError: true,
        };
      }

      if (ctx?.onToolCall) {
        ctx.onToolCall({
          tool: "query_context",
          provider: undefined,
          email_count: 0,
          credits_used: 0,
          status: result.isError ? "error" : "success",
          error_message: result.isError ? result.content[0]?.text?.slice(0, 500) : undefined,
          duration_ms: Date.now() - start,
          details: logDetails,
        }).catch(() => {});
      }

      return result;
    }
  );

  // -- update_context ---------------------------------------------------------
  server.tool(
    "update_context",
    `Create or update a shared context document. Upserts by slug — if a document with this slug exists, it updates (and snapshots the previous version to history); otherwise creates a new one. Every edit is tracked with who made the change, the version number, and a timestamp. Use query_context with include_history: true to see the edit log.

TAG TAXONOMY — always tag documents with these namespaced tags:
  industry/{slug}    — Target industry (e.g. industry/cybersecurity, industry/fire-safety)
  skill/{slug}       — Which skill uses this (e.g. skill/deal-analysis, skill/grata-search-enrichment)
  source/{slug}      — Data source (e.g. source/hubspot, source/onedrive, source/grata)
  status/{status}    — Document state: active, draft, archived
  topic/{slug}       — Subject matter (e.g. topic/scoring, topic/outreach, topic/thesis)
  company/{slug}     — Company-specific context
  person/{slug}      — Person-specific context

SLUG CONVENTIONS — kebab-case, descriptive:
  "thesis" — main investment thesis
  "sources" — data source registry
  "scoring-criteria-{industry}" — industry-specific scoring
  "template-{type}" — reusable templates (e.g. template-memo, template-outreach)

METADATA — use for structured fields that don't fit in tags:
  { revenue_range: "$2M-$70M", sectors: ["cybersecurity", "fire-safety"] }`,
    {
      slug: z
        .string()
        .max(128, "Slug too long")
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be kebab-case (e.g. 'thesis', 'scoring-criteria-cybersecurity')")
        .describe("Unique kebab-case identifier (e.g. 'thesis', 'sources', 'scoring-criteria-cybersecurity')"),
      title: z
        .string()
        .max(500, "Title too long")
        .describe("Human-readable title"),
      content: z
        .string()
        .min(1, "Content cannot be empty")
        .max(100000, "Content exceeds 100KB limit")
        .describe("Full document content in markdown"),
      doc_type: z
        .enum(["thesis", "reference", "source", "criteria", "template"])
        .optional()
        .describe("Document type: thesis (investment thesis), reference (general), source (data source registry), criteria (scoring/evaluation), template (reusable format). Defaults to 'reference' for new documents. Omit on update to preserve existing type."),
      tags: z
        .array(z.string().max(200, "Tag too long"))
        .max(50, "Too many tags")
        .optional()
        .describe("Namespaced tags for queryability. Use: industry/{slug}, skill/{slug}, source/{slug}, status/{status}, topic/{slug}, company/{slug}, person/{slug}. Always include at least status/active and relevant skill/ or topic/ tags. When omitted on update, existing tags are preserved."),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe("Structured key-value data. When omitted on update, existing metadata is preserved."),
    },
    async ({ slug, title, content, doc_type, tags, metadata }) => {
      const denied = requireAuth("update_context");
      if (denied) return denied;

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

      const editor = ctx?.userId ?? "claude";
      const tagArray = tags ?? null;
      const meta = metadata ? JSON.stringify(metadata) : null;
      const docType = doc_type ?? null;

      const start = Date.now();
      let result: { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      let logDetails: Record<string, unknown> = {
        input: { slug, title, doc_type: docType, tags: tagArray, has_metadata: meta !== null },
      };

      try {
        // Atomic CTE: snapshot → upsert → creation log in one round-trip.
        // ON CONFLICT UPDATE reads the locked row's version, eliminating race conditions.
        const rows = (await sql`
          WITH prev AS (
            SELECT id, slug, version, doc_type, title, content, tags, metadata, updated_by
            FROM wl_context
            WHERE slug = ${slug}
            LIMIT 1
          ),
          snapshot AS (
            INSERT INTO wl_context_history (context_id, slug, version, doc_type, title, content, tags, metadata, changed_by, change_type)
            SELECT id, slug, version, doc_type, title, content, tags, metadata, updated_by, 'updated'
            FROM prev
            RETURNING context_id
          ),
          upserted AS (
            INSERT INTO wl_context (slug, doc_type, title, content, tags, metadata, updated_by, version)
            VALUES (
              ${slug},
              COALESCE(${docType}, 'reference'),
              ${title},
              ${content},
              COALESCE(${tagArray}, '{}'),
              COALESCE(${meta}, '{}')::jsonb,
              ${editor},
              COALESCE((SELECT version FROM prev), 0) + 1
            )
            ON CONFLICT (slug) DO UPDATE SET
              doc_type = ${docType ? sql`EXCLUDED.doc_type` : sql`wl_context.doc_type`},
              title = EXCLUDED.title,
              content = EXCLUDED.content,
              tags = ${tagArray !== null ? sql`EXCLUDED.tags` : sql`wl_context.tags`},
              metadata = ${meta !== null ? sql`EXCLUDED.metadata` : sql`wl_context.metadata`},
              updated_by = EXCLUDED.updated_by,
              version = wl_context.version + 1,
              updated_at = now()
            RETURNING id, slug, doc_type, title, tags, version, updated_at
          ),
          creation_log AS (
            INSERT INTO wl_context_history (context_id, slug, version, doc_type, title, content, tags, metadata, changed_by, change_type)
            SELECT id, slug, version, doc_type, title, ${content}, tags, ${meta ?? '{}'}::jsonb, ${editor}, 'created'
            FROM upserted
            WHERE NOT EXISTS (SELECT 1 FROM prev)
            RETURNING context_id
          )
          SELECT u.*,
            CASE WHEN EXISTS (SELECT 1 FROM prev) THEN 'updated' ELSE 'created' END AS change_type
          FROM upserted u
        `) as UpsertResultRow[];

        const row = rows[0];

        if (!row) {
          result = {
            content: [{ type: "text" as const, text: JSON.stringify({ saved: false, error: "Upsert returned no rows" }, null, 2) }],
            isError: true,
          };
        } else {
          logDetails.result = {
            change_type: row.change_type,
            version: row.version,
            slug: row.slug,
            doc_type: row.doc_type,
          };

          result = {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    saved: true,
                    change_type: row.change_type,
                    version: row.version,
                    changed_by: editor,
                    id: row.id,
                    slug: row.slug,
                    doc_type: row.doc_type,
                    title: row.title,
                    tags: row.tags,
                    updated_at: row.updated_at,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } catch (err) {
        console.error("[update_context]", err);
        const isDuplicateVersion = err instanceof Error && err.message.includes("idx_wl_context_history_unique_version");
        result = {
          content: [{ type: "text" as const, text: JSON.stringify({
            error: isDuplicateVersion ? "Concurrent edit detected — retry your update" : "Update failed",
            ...(isDuplicateVersion ? { retry: true } : {}),
          }, null, 2) }],
          isError: true,
        };
      }

      if (ctx?.onToolCall) {
        ctx.onToolCall({
          tool: "update_context",
          provider: undefined,
          email_count: 0,
          credits_used: 0,
          status: result.isError ? "error" : "success",
          error_message: result.isError ? result.content[0]?.text?.slice(0, 500) : undefined,
          duration_ms: Date.now() - start,
          details: logDetails,
        }).catch(() => {});
      }

      return result;
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
      const denied = requireAuth("admin_report");
      if (denied) return denied;

      const lookback = days ?? 7;
      const report: Record<string, unknown> = { period_days: lookback };

      // -- Live credit balances --
      const credits: Record<string, unknown> = {};
      try {
        const { credits: co } = await clearout.getCredits();
        credits.clearout = co;
      } catch (err) {
        credits.clearout = { error: err instanceof Error ? err.message : String(err) };
      }
      try {
        const zb = await zerobounce.getCredits();
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

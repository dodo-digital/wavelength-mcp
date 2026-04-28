import { z } from "zod";

const CLEAROUT_BASE = "https://api.clearout.io/v2";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const VerifyDataSchema = z.object({
  email_address: z.string(),
  safe_to_send: z.string(),
  status: z.string(),
  sub_status: z.object({ code: z.number(), desc: z.string() }).optional(),
  disposable: z.string(),
  free: z.string(),
  role: z.string(),
  gibberish: z.string(),
  bounce_type: z.string(),
  time_taken: z.number().optional(),
});

const VerifyResponseSchema = z.object({
  status: z.string(),
  data: VerifyDataSchema.optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const CreditResponseSchema = z.object({
  status: z.string(),
  data: z.object({ credits: z.record(z.unknown()) }).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const BulkSubmitResponseSchema = z.object({
  status: z.string(),
  data: z.object({ list_id: z.string() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

const BulkStatusResponseSchema = z.object({
  status: z.string(),
  data: z
    .object({ progress_status: z.string(), percentile: z.number() })
    .optional(),
});

const BulkDownloadResponseSchema = z.object({
  status: z.string(),
  data: z.object({ url: z.string() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClearoutVerifyResult {
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
  _rate_limit_remaining?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getKey(): string {
  const key = process.env.CLEAROUT_API_KEY;
  if (!key) throw new Error("CLEAROUT_API_KEY not set");
  return key;
}

export function isCreditExhausted(errorMsg: string): boolean {
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

export function extractAvailableCredits(
  credits: Record<string, unknown>
): number | null {
  for (const key of ["available", "remaining", "balance"]) {
    if (typeof credits[key] === "number") return credits[key] as number;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Instant verification
// ---------------------------------------------------------------------------

export async function verifyEmail(
  email: string
): Promise<ClearoutVerifyResult> {
  const res = await fetch(`${CLEAROUT_BASE}/email_verify/instant`, {
    method: "POST",
    headers: {
      Authorization: `Bearer:${getKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, timeout: 130000 }),
  });

  const rateLimitRemaining = res.headers.get("x-ratelimit-remaining");

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout API ${res.status}: ${body}`);
  }

  const json = VerifyResponseSchema.parse(await res.json());

  if (json.status === "error" || !json.data) {
    throw new Error(
      `Clearout error: ${json.error?.message ?? "Unknown error"}`
    );
  }

  const result: ClearoutVerifyResult = { ...json.data };

  if (rateLimitRemaining !== null) {
    result._rate_limit_remaining = parseInt(rateLimitRemaining, 10);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export async function getCredits(): Promise<{
  credits: Record<string, unknown>;
}> {
  const res = await fetch(`${CLEAROUT_BASE}/email_verify/getcredits`, {
    method: "GET",
    headers: {
      Authorization: `Bearer:${getKey()}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout API ${res.status}: ${body}`);
  }

  const json = CreditResponseSchema.parse(await res.json());

  if (json.status === "error" || !json.data) {
    throw new Error(
      `Clearout error: ${json.error?.message ?? "Unknown error"}`
    );
  }

  return { credits: json.data.credits };
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

function emailsToCsv(emails: string[]): string {
  return "email\n" + emails.join("\n");
}

export async function bulkSubmit(emails: string[]): Promise<string> {
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
    headers: { Authorization: `Bearer:${getKey()}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout bulk API ${res.status}: ${body}`);
  }

  const json = BulkSubmitResponseSchema.parse(await res.json());

  if (json.status === "error" || !json.data?.list_id) {
    throw new Error(
      `Clearout bulk submit failed: ${json.error?.message ?? JSON.stringify(json)}`
    );
  }

  return json.data.list_id;
}

export async function bulkStatus(
  listId: string
): Promise<{ progress_status: string; percentile: number }> {
  const params = new URLSearchParams({ list_id: listId });
  const res = await fetch(
    `${CLEAROUT_BASE}/email_verify/bulk/progress_status?${params}`,
    { headers: { Authorization: `Bearer:${getKey()}` } }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout status API ${res.status}: ${body}`);
  }

  const json = BulkStatusResponseSchema.parse(await res.json());

  return {
    progress_status: json.data?.progress_status ?? "unknown",
    percentile: json.data?.percentile ?? 0,
  };
}

export async function bulkResults(listId: string): Promise<string> {
  const res = await fetch(`${CLEAROUT_BASE}/download/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer:${getKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ list_id: listId }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clearout download API ${res.status}: ${body}`);
  }

  const json = BulkDownloadResponseSchema.parse(await res.json());

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

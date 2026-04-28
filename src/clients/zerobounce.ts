import { z } from "zod";

const ZEROBOUNCE_BASE = "https://api.zerobounce.net/v2";
const ZEROBOUNCE_BULK_BASE = "https://bulkapi.zerobounce.net/v2";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const VerifyResponseSchema = z.object({
  address: z.string().default(""),
  status: z.string().default(""),
  sub_status: z.string().default(""),
  free_email: z.boolean().default(false),
  did_you_mean: z.string().nullable().default(null),
  domain: z.string().nullable().default(null),
  domain_age_days: z.string().default(""),
  smtp_provider: z.string().default(""),
  mx_found: z.string().default(""),
  mx_record: z.string().default(""),
  firstname: z.string().default(""),
  lastname: z.string().default(""),
  gender: z.string().default(""),
  error: z.string().optional(),
});

const CreditsResponseSchema = z.object({
  Credits: z.number(),
});

const BulkSubmitResponseSchema = z.object({
  success: z.boolean(),
  file_id: z.string().optional(),
  message: z.string().optional(),
});

const BulkStatusResponseSchema = z.object({
  file_status: z.string().default("unknown"),
  complete_percentage: z.string().default("0"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ZBVerifyResult = z.infer<typeof VerifyResponseSchema> & {
  _schema_warning?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getKey(): string {
  const key = process.env.ZERO_BOUNCE_API_KEY;
  if (!key) throw new Error("ZERO_BOUNCE_API_KEY not set");
  return key;
}

export function isCreditExhausted(errorMsg: string): boolean {
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
// Instant verification
// ---------------------------------------------------------------------------

export async function verifyEmail(email: string): Promise<ZBVerifyResult> {
  const params = new URLSearchParams({
    api_key: getKey(),
    email,
    ip_address: "",
  });

  const res = await fetch(`${ZEROBOUNCE_BASE}/validate?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce API ${res.status}: ${body}`);
  }

  const json = await res.json();
  const parsed = VerifyResponseSchema.parse(json);

  if (parsed.error) {
    throw new Error(`ZeroBounce error: ${parsed.error}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export async function getCredits(): Promise<number> {
  const params = new URLSearchParams({ api_key: getKey() });
  const res = await fetch(`${ZEROBOUNCE_BASE}/getcredits?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce API ${res.status}: ${body}`);
  }

  const json = CreditsResponseSchema.parse(await res.json());

  if (json.Credits === -1) {
    throw new Error("ZeroBounce: Invalid API key");
  }

  return json.Credits;
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
  formData.append("api_key", getKey());
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

  const json = BulkSubmitResponseSchema.parse(await res.json());

  if (!json.success || !json.file_id) {
    throw new Error(
      `ZeroBounce bulk submit failed: ${json.message ?? "Unknown error"}`
    );
  }

  return json.file_id;
}

export async function bulkStatus(
  fileId: string
): Promise<{ file_status: string; complete_percentage: string }> {
  const params = new URLSearchParams({
    api_key: getKey(),
    file_id: fileId,
  });
  const res = await fetch(`${ZEROBOUNCE_BULK_BASE}/filestatus?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce status API ${res.status}: ${body}`);
  }

  const json = BulkStatusResponseSchema.parse(await res.json());
  return {
    file_status: json.file_status,
    complete_percentage: json.complete_percentage,
  };
}

export async function bulkResults(fileId: string): Promise<string> {
  const params = new URLSearchParams({
    api_key: getKey(),
    file_id: fileId,
  });
  const res = await fetch(`${ZEROBOUNCE_BULK_BASE}/getfile?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ZeroBounce results API ${res.status}: ${body}`);
  }

  return await res.text();
}

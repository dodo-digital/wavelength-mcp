# Wavelength MCP

MCP server for the Wavelength Equity team. Email validation, contact enrichment, outreach sequencing, shared context management, and skill learnings — all behind OAuth 2.1 auth.

Deployed on Vercel. Postgres on Neon.

## Tools

### Email Validation

| Tool | Provider | Description |
|------|----------|-------------|
| `validate_email` | Clearout | Real-time validation, up to 20 emails |
| `zb_validate_email` | ZeroBounce | Real-time validation, up to 20 emails |
| `bulk_validate` | Either | Async batch validation (>20 emails), returns job_id |
| `bulk_status` | Either | Check bulk job progress |
| `bulk_results` | Either | Download completed bulk results |
| `check_credits` | Clearout, ZeroBounce, Apollo | Check live Clearout/ZeroBounce balances plus Apollo API health and rate limits |

### Outreach (Reply.io)

| Tool | Description |
|------|-------------|
| `reply_list_sequences` | List sequences, filter by status |
| `reply_get_sequence` | Sequence details (steps, templates, accounts) |
| `reply_search_contact` | Look up contact by email |
| `reply_push_contacts` | Upsert + push up to 50 contacts to a sequence |

### Enrichment (Apollo)

| Tool | Description |
|------|-------------|
| `apollo_enrich_person` | Person enrichment by email, LinkedIn, or name+company |
| `apollo_bulk_enrich_people` | Bulk person match, up to 10 per call |
| `apollo_enrich_org` | Company enrichment by domain |
| `apollo_search_people` | Search people database by domain, title, seniority |

Apollo does not expose the live account credit balance through its public API. `check_credits` reports Apollo API health and rate-limit usage only; use Apollo's Billing > Credit usage page or Developer Portal Usage page for remaining plan credits.

### Shared Context

| Tool | Description |
|------|-------------|
| `query_context` | Search context docs by slug, tags, keyword, or doc_type; supports `tag_match` any/all |
| `list_context_tags` | List existing memory tags grouped by namespace with document counts |
| `update_context` | Upsert context docs with version history, normalized tags, and `metadata.summary` |

### Skill Learnings

| Tool | Description |
|------|-------------|
| `get_skill_learnings` | Load accumulated cross-user learnings for a skill |
| `save_skill_learning` | Save an actionable learning (visible to all users) |

### Admin

| Tool | Description |
|------|-------------|
| `admin_report` | Usage report with call stats plus live provider balances/status |

## Setup

```sh
npm install
cp .env.local.example .env.local  # fill in API keys
npm run dev                        # local dev server
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLEAROUT_API_KEY` | Yes | Clearout email validation |
| `ZEROBOUNCE_API_KEY` | Yes | ZeroBounce email validation |
| `APOLLO_API_KEY` | Yes | Apollo enrichment |
| `REPLY_IO_API_KEY` | Yes | Reply.io outreach |
| `POSTGRES_URL` | Yes | Neon connection string |
| `AUTH_SECRET` | Yes | OAuth 2.1 session signing |
| `BETTER_AUTH_URL` | Yes | Server base URL |

## Database

Migrations in `migrations/` — run sequentially against Neon:

```
001_init.sql          — wl_users, wl_calls tables
002_auth.sql          — Better Auth tables (user, session, account, etc.)
003_skill_learnings.sql — wl_skill_learnings table
004_unique_auth_user_id.sql — unique constraint on auth user mapping
005_context.sql       — wl_context table with full-text search index
006_context_history.sql — wl_context_history for version tracking
007_context_integrity.sql — ON DELETE RESTRICT, unique version index
008_call_details.sql  — JSONB details column on wl_calls
009_admin_and_bulk_jobs.sql — admin flag and owned bulk job tracking
010_context_history_triggers.sql — database-managed context history
```

Admin-only tools require `wl_users.is_admin = true`. Set that manually for the users who should be able to run `admin_report`.

## Architecture

```
src/
  index.ts       — MCP server with all tool registrations
  auth.ts        — Better Auth + OAuth 2.1 provider
  db.ts          — Neon client, user resolution, call logging
  serve.ts       — Local Express dev server
  clients/       — API clients (clearout, zerobounce, apollo, reply)
  utils/         — CSV parser
api/             — Vercel serverless functions
public/          — OAuth sign-in and consent pages
migrations/      — SQL migrations (run manually)
```

## Deploy

```sh
npx vercel --prod
```

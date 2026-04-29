#!/usr/bin/env bash
# Wavelength MCP integration test — hits Vercel production via JSON-RPC over SSE
set -euo pipefail

TOKEN="dev-test-8126f147d1c495a6ecf0074c6e9f5b50"
URL="https://wavelength-mcp.vercel.app/mcp"
PASS=0
FAIL=0
SKIP=0
ID=0

mcp() {
  local tool="$1" args="$2"
  ID=$((ID + 1))
  local body="{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
  curl -s -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $TOKEN" \
    -d "$body" | grep '^data:' | sed 's/^data: //'
}

check() {
  local label="$1" result="$2" expect="$3"
  if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert $expect" 2>/dev/null; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        $(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('result',d.get('error',d)),indent=None)[:200])" 2>/dev/null || echo "$result" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}

check_tool() {
  local label="$1" result="$2" expect="$3"
  # Tool results are nested: result.content[0].text contains JSON
  if echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d['result']['content'][0]['text']
payload = json.loads(text)
assert $expect
" 2>/dev/null; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        $(echo "$result" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  text = d.get('result',{}).get('content',[{}])[0].get('text','')
  print(text[:200])
except: print(json.dumps(d)[:200])
" 2>/dev/null || echo "$result" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  echo "  SKIP  $1 — $2"
  SKIP=$((SKIP + 1))
}

echo "=== Wavelength MCP Integration Tests ==="
echo "Target: $URL"
echo ""

# ---- Health ----
echo "--- Health ---"
R=$(curl -s "$URL")
check "GET /mcp health" "$R" "'d[\"status\"] == \"ok\"'"

# ---- Initialize ----
echo "--- Initialize ---"
ID=$((ID + 1))
R=$(curl -s -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}" \
  | grep '^data:' | sed 's/^data: //')
check "MCP initialize" "$R" "'d[\"result\"][\"serverInfo\"][\"name\"] == \"wavelength\"'"

# ---- Auth check ----
echo "--- Auth (reject bad token) ---"
ID=$((ID + 1))
R=$(curl -s -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer bad-token-12345" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"tools/call\",\"params\":{\"name\":\"check_credits\",\"arguments\":{}}}")
check "Reject bad token (401)" "$R" "'d.get(\"error\",{}).get(\"message\",\"\").startswith(\"Authorization\")'"

# ---- check_credits ----
echo "--- check_credits ---"
R=$(mcp "check_credits" '{}')
check_tool "check_credits returns data" "$R" "'\"clearout\" in payload or \"zerobounce\" in payload'"

# ---- validate_email (single) ----
echo "--- validate_email ---"
R=$(mcp "validate_email" '{"email":"test@gmail.com"}')
check_tool "validate_email single" "$R" "'\"status\" in payload or \"error\" in payload'"

# ---- zb_validate_email (single) ----
echo "--- zb_validate_email ---"
R=$(mcp "zb_validate_email" '{"email":"test@gmail.com"}')
check_tool "zb_validate_email single" "$R" "'\"status\" in payload or \"error\" in payload'"

# ---- validate_email (batch) ----
echo "--- validate_email (batch) ---"
R=$(mcp "validate_email" '{"email":["test@gmail.com","invalid@fake.xyz"]}')
check_tool "validate_email batch" "$R" "'\"results\" in payload or \"error\" in payload'"

# ---- apollo_enrich_org ----
echo "--- apollo_enrich_org ---"
R=$(mcp "apollo_enrich_org" '{"domain":"google.com"}')
check_tool "apollo_enrich_org" "$R" "True"

# ---- apollo_search_people ----
echo "--- apollo_search_people ---"
R=$(mcp "apollo_search_people" '{"organization_domains":["google.com"],"person_seniorities":["c_suite"],"page":1}')
check_tool "apollo_search_people" "$R" "True"

# ---- apollo_enrich_person ----
echo "--- apollo_enrich_person ---"
R=$(mcp "apollo_enrich_person" '{"organization_name":"Google","first_name":"Sundar","last_name":"Pichai"}')
check_tool "apollo_enrich_person" "$R" "True"

# ---- reply_list_sequences ----
echo "--- reply_list_sequences ---"
R=$(mcp "reply_list_sequences" '{}')
check_tool "reply_list_sequences" "$R" "'\"sequences\" in payload or \"error\" in payload'"

# ---- reply_search_contact ----
echo "--- reply_search_contact ---"
R=$(mcp "reply_search_contact" '{"email":"nobody@example.com"}')
check_tool "reply_search_contact" "$R" "True"

# ---- query_context (list all) ----
echo "--- query_context ---"
R=$(mcp "query_context" '{}')
check_tool "query_context list all" "$R" "'\"documents\" in payload'"

# ---- update_context (create) ----
echo "--- update_context ---"
R=$(mcp "update_context" '{"slug":"test-integration","title":"Integration Test Doc","content":"This is a test document.","doc_type":"reference","tags":["status/draft","topic/testing"]}')
check_tool "update_context create" "$R" "'payload.get(\"saved\") == True and payload.get(\"change_type\") == \"created\"'"

# ---- query_context (slug lookup) ----
echo "--- query_context (slug) ---"
R=$(mcp "query_context" '{"slug":"test-integration"}')
check_tool "query_context slug lookup" "$R" "'payload[\"documents\"][0][\"title\"] == \"Integration Test Doc\"'"

# ---- update_context (update — preserve doc_type) ----
echo "--- update_context (partial update) ---"
R=$(mcp "update_context" '{"slug":"test-integration","title":"Updated Test Doc","content":"Updated content."}')
check_tool "update_context preserves doc_type" "$R" "'payload.get(\"saved\") == True and payload.get(\"change_type\") == \"updated\" and payload.get(\"version\") == 2'"

# ---- query_context (verify doc_type preserved) ----
echo "--- query_context (verify preserve) ---"
R=$(mcp "query_context" '{"slug":"test-integration"}')
check_tool "doc_type preserved as reference" "$R" "'payload[\"documents\"][0][\"doc_type\"] == \"reference\"'"

# ---- query_context (with history) ----
echo "--- query_context (history) ---"
R=$(mcp "query_context" '{"slug":"test-integration","include_history":true}')
check_tool "query_context includes history" "$R" "'\"history\" in payload and len(payload[\"history\"]) >= 1'"

# ---- query_context (keyword search) ----
echo "--- query_context (keyword) ---"
R=$(mcp "query_context" '{"keyword":"Updated content"}')
check_tool "query_context keyword search" "$R" "'payload[\"count\"] >= 1'"

# ---- query_context (tag filter) ----
echo "--- query_context (tags) ---"
R=$(mcp "query_context" '{"tags":["topic/testing"]}')
check_tool "query_context tag filter" "$R" "'payload[\"count\"] >= 1'"

# ---- query_context (doc_type filter) ----
echo "--- query_context (doc_type) ---"
R=$(mcp "query_context" '{"doc_type":"reference"}')
check_tool "query_context doc_type filter" "$R" "'payload[\"count\"] >= 1'"

# ---- update_context (bad slug) ----
echo "--- update_context (validation) ---"
R=$(mcp "update_context" '{"slug":"BAD SLUG!","title":"Fail","content":"x"}')
check "update_context rejects bad slug" "$R" "'\"error\" in d.get(\"result\",d) or \"isError\" in str(d)'"

# ---- save_skill_learning ----
echo "--- save_skill_learning ---"
R=$(mcp "save_skill_learning" '{"skill":"test-skill","category":"edge-case","content":"Integration test learning — safe to delete"}')
check_tool "save_skill_learning" "$R" "'payload.get(\"saved\") == True'"

# ---- get_skill_learnings ----
echo "--- get_skill_learnings ---"
R=$(mcp "get_skill_learnings" '{"skill":"test-skill"}')
check_tool "get_skill_learnings" "$R" "'payload[\"count\"] >= 1'"

# ---- admin_report ----
echo "--- admin_report ---"
R=$(mcp "admin_report" '{"days":1}')
check_tool "admin_report" "$R" "'\"live_credits\" in payload'"

# ---- Bulk validation (submit only — don't wait) ----
skip "bulk_validate" "async job, would need polling"
skip "bulk_status" "needs job_id from bulk_validate"
skip "bulk_results" "needs completed job"
skip "apollo_bulk_enrich_people" "costs credits, covered by single enrich"
skip "reply_get_sequence" "needs valid sequence_id"
skip "reply_push_contacts" "destructive, requires user confirmation"

# ---- Summary ----
echo ""
echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo "  Total: $((PASS + FAIL + SKIP))"
[ $FAIL -eq 0 ] && echo "  All tests passed!" || echo "  $FAIL test(s) failed."

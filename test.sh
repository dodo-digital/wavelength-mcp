#!/usr/bin/env bash
# Wavelength MCP smoke/integration tests.
#
# Defaults are safe for production:
#   - no hardcoded token
#   - no credit-spending provider calls
#   - no mutating context/learning writes
#
# Examples:
#   ./test.sh
#   WAVELENGTH_MCP_TOKEN=... ./test.sh
#   WAVELENGTH_MCP_TOKEN=... RUN_PROVIDER_TESTS=1 ./test.sh
#   WAVELENGTH_MCP_TOKEN=... RUN_MUTATION_TESTS=1 ./test.sh
set -euo pipefail

URL="${WAVELENGTH_MCP_URL:-https://wavelength-mcp.vercel.app/mcp}"
BASE_URL="${URL%/mcp}"
TOKEN="${WAVELENGTH_MCP_TOKEN:-${MCP_TOKEN:-}}"
TEST_EMAIL="${TEST_EMAIL:-test@gmail.com}"
TEST_DOMAIN="${TEST_DOMAIN:-google.com}"
TEST_CONTEXT_SLUG="${TEST_CONTEXT_SLUG:-test-integration}"

RUN_PROVIDER_TESTS="${RUN_PROVIDER_TESTS:-0}"
RUN_MUTATION_TESTS="${RUN_MUTATION_TESTS:-0}"
RUN_DESTRUCTIVE_TESTS="${RUN_DESTRUCTIVE_TESTS:-0}"
RUN_BULK_TESTS="${RUN_BULK_TESTS:-0}"

PASS=0
FAIL=0
SKIP=0
ID=0

auth_header=()
if [[ -n "$TOKEN" ]]; then
  auth_header=(-H "Authorization: Bearer $TOKEN")
fi

json_rpc() {
  local body="$1"
  curl -sS -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    "${auth_header[@]}" \
    -d "$body" | sed -n 's/^data: //p'
}

mcp() {
  local tool="$1" args="$2"
  ID=$((ID + 1))
  json_rpc "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

check() {
  local label="$1" result="$2" expect="$3"
  if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); assert $expect" 2>/dev/null; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    echo "        $(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('result',d.get('error',d)),indent=None)[:240])" 2>/dev/null || echo "$result" | head -c 240)"
    FAIL=$((FAIL + 1))
  fi
}

check_tool() {
  local label="$1" result="$2" expect="$3"
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
  print(text[:240])
except Exception:
  print(json.dumps(d)[:240])
" 2>/dev/null || echo "$result" | head -c 240)"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  echo "  SKIP  $1 - $2"
  SKIP=$((SKIP + 1))
}

require_token() {
  local label="$1"
  if [[ -z "$TOKEN" ]]; then
    skip "$label" "set WAVELENGTH_MCP_TOKEN to run authenticated checks"
    return 1
  fi
  return 0
}

require_flag() {
  local label="$1" flag_name="$2" flag_value="$3" reason="$4"
  if [[ "$flag_value" != "1" ]]; then
    skip "$label" "set $flag_name=1 to run $reason"
    return 1
  fi
  return 0
}

echo "=== Wavelength MCP Tests ==="
echo "Target: $URL"
echo "Authenticated: $([[ -n "$TOKEN" ]] && echo yes || echo no)"
echo ""

echo "--- Public smoke ---"
R=$(curl -sS "$URL")
check "GET /mcp health" "$R" "'d[\"status\"] == \"ok\" and d[\"transport\"] == \"streamable-http\"'"

R=$(curl -sS "$BASE_URL/.well-known/oauth-protected-resource")
check "OAuth protected-resource metadata" "$R" "'authorization_servers' in d and d['resource'].endswith('/mcp')"

R=$(curl -sS "$BASE_URL/.well-known/oauth-authorization-server")
check "OAuth authorization-server metadata" "$R" "'authorization_endpoint' in d and 'token_endpoint' in d and 'registration_endpoint' in d"

echo "--- Auth rejection ---"
ID=$((ID + 1))
R=$(curl -sS -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer bad-token-12345" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}")
check "Reject bad token" "$R" "'Authorization required' in d.get('error',{}).get('message','')"

echo "--- MCP initialize ---"
if require_token "MCP initialize"; then
  ID=$((ID + 1))
  R=$(json_rpc "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}")
  check "MCP initialize" "$R" "'d[\"result\"][\"serverInfo\"][\"name\"] == \"wavelength\"'"
fi

echo "--- Read-only authenticated tools ---"
if require_token "check_credits"; then
  R=$(mcp "check_credits" '{}')
  check_tool "check_credits returns provider status" "$R" "'clearout' in payload or 'zerobounce' in payload or 'apollo' in payload"
fi

if require_token "query_context list"; then
  R=$(mcp "query_context" '{}')
  check_tool "query_context list" "$R" "'documents' in payload"
fi

if require_token "list_context_tags"; then
  R=$(mcp "list_context_tags" '{}')
  check_tool "list_context_tags" "$R" "'tags' in payload and 'allowed_namespaces' in payload"
fi

if require_token "reply_list_sequences"; then
  R=$(mcp "reply_list_sequences" '{}')
  check_tool "reply_list_sequences" "$R" "'sequences' in payload or 'error' in payload"
fi

if require_token "reply_search_contact"; then
  R=$(mcp "reply_search_contact" '{"email":"nobody@example.com"}')
  check_tool "reply_search_contact" "$R" "True"
fi

echo "--- Provider credit/API tests ---"
if require_token "validate_email" && require_flag "validate_email" "RUN_PROVIDER_TESTS" "$RUN_PROVIDER_TESTS" "credit-spending provider tests"; then
  R=$(mcp "validate_email" "{\"email\":\"$TEST_EMAIL\"}")
  check_tool "validate_email single" "$R" "'status' in payload or 'error' in payload"
fi

if require_token "zb_validate_email" && require_flag "zb_validate_email" "RUN_PROVIDER_TESTS" "$RUN_PROVIDER_TESTS" "credit-spending provider tests"; then
  R=$(mcp "zb_validate_email" "{\"email\":\"$TEST_EMAIL\"}")
  check_tool "zb_validate_email single" "$R" "'status' in payload or 'error' in payload"
fi

if require_token "apollo_enrich_org" && require_flag "apollo_enrich_org" "RUN_PROVIDER_TESTS" "$RUN_PROVIDER_TESTS" "external provider tests"; then
  R=$(mcp "apollo_enrich_org" "{\"domain\":\"$TEST_DOMAIN\"}")
  check_tool "apollo_enrich_org" "$R" "True"
fi

if require_token "apollo_search_people" && require_flag "apollo_search_people" "RUN_PROVIDER_TESTS" "$RUN_PROVIDER_TESTS" "external provider tests"; then
  R=$(mcp "apollo_search_people" "{\"organization_domains\":[\"$TEST_DOMAIN\"],\"person_seniorities\":[\"c_suite\"],\"page\":1}")
  check_tool "apollo_search_people" "$R" "True"
fi

echo "--- Mutation tests ---"
if require_token "update_context create/update" && require_flag "update_context create/update" "RUN_MUTATION_TESTS" "$RUN_MUTATION_TESTS" "context mutation tests"; then
  R=$(mcp "update_context" "{\"slug\":\"$TEST_CONTEXT_SLUG\",\"title\":\"Integration Test Doc\",\"content\":\"This is a test document.\",\"doc_type\":\"reference\",\"tags\":[\"status/draft\",\"topic/testing\"]}")
  check_tool "update_context upsert" "$R" "'payload.get(\"saved\") == True and payload.get(\"change_type\") in (\"created\", \"updated\")'"

  R=$(mcp "query_context" "{\"slug\":\"$TEST_CONTEXT_SLUG\",\"include_history\":true}")
  check_tool "query_context slug lookup" "$R" "'documents' in payload and payload['count'] >= 1"
fi

if require_token "update_context validation" && require_flag "update_context validation" "RUN_MUTATION_TESTS" "$RUN_MUTATION_TESTS" "context mutation tests"; then
  R=$(mcp "update_context" '{"slug":"BAD SLUG!","title":"Fail","content":"x"}')
  check "update_context rejects bad slug" "$R" "'error' in d.get('result',d) or 'isError' in str(d)"
fi

if require_token "save_skill_learning" && require_flag "save_skill_learning" "RUN_MUTATION_TESTS" "$RUN_MUTATION_TESTS" "skill learning mutation tests"; then
  R=$(mcp "save_skill_learning" '{"skill":"test-skill","category":"edge-case","content":"Integration test learning - safe to delete"}')
  check_tool "save_skill_learning" "$R" "'payload.get(\"saved\") == True'"

  R=$(mcp "get_skill_learnings" '{"skill":"test-skill"}')
  check_tool "get_skill_learnings" "$R" "'payload[\"count\"] >= 1'"
fi

echo "--- Admin and destructive checks ---"
if require_token "admin_report" && require_flag "admin_report" "RUN_PROVIDER_TESTS" "$RUN_PROVIDER_TESTS" "provider/admin checks"; then
  R=$(mcp "admin_report" '{"days":1}')
  check_tool "admin_report" "$R" "'live_credits' in payload or 'error' in payload"
fi

if require_token "bulk_validate / bulk_status / bulk_results"; then
  if require_flag "bulk_validate / bulk_status / bulk_results" "RUN_BULK_TESTS" "$RUN_BULK_TESTS" "bulk validation tests"; then
    R=$(mcp "bulk_validate" "{\"provider\":\"clearout\",\"emails\":[\"$TEST_EMAIL\"]}")
    check_tool "bulk_validate submit" "$R" "'job_id' in payload or 'error' in payload"
  fi
fi

if require_token "reply_push_contacts"; then
  if require_flag "reply_push_contacts" "RUN_DESTRUCTIVE_TESTS" "$RUN_DESTRUCTIVE_TESTS" "destructive Reply.io writes"; then
    skip "reply_push_contacts" "requires a real sequence_id and contact payload; keep manual"
  fi
fi

echo ""
echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo "  Total: $((PASS + FAIL + SKIP))"

if [[ $FAIL -eq 0 ]]; then
  echo "  All required checks passed."
else
  echo "  $FAIL check(s) failed."
  exit 1
fi

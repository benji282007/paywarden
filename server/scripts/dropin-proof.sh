#!/usr/bin/env bash
# Drop-in proof: the official MCP Inspector CLI (a third-party MCP client) talks to Paywarden
# using only the session URL, exactly as it would talk to PayPal's MCP server.
#   bash server/scripts/dropin-proof.sh [base-url]
set -euo pipefail
BASE="${1:-http://localhost:8787}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
json() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String($1))"; }
inspect() { npx -y @modelcontextprotocol/inspector@2.13.0 --cli "$URL" --transport http "$@" < /dev/null; }

URL="$BASE$(curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/api/sessions" -H 'content-type: application/json' ${MERCHANT_API_TOKEN:+-H "authorization: Bearer $MERCHANT_API_TOKEN"} -d '{"customerId":"sam"}' | json 'j.mcpPath')"
ORDER="$(curl -s -b "$JAR" "$BASE/api/ledger" | json 'j.find(e=>e.description==="Cold brew bundle").orderId')"
CAPTURE="$(curl -s -b "$JAR" "$BASE/api/ledger" | json 'j.find(e=>e.description==="Cold brew bundle").captureId')"

echo "1. tools/list (PayPal Agent Toolkit names):"
inspect --method tools/list | json 'j.tools.map(t=>"   - "+t.name).join("\n")'; echo
echo "2. get_order $ORDER (the order carrying the injected note):"
inspect --method tools/call --tool-name get_order --tool-arg "id=$ORDER" | json '"   note: "+JSON.parse(j.content[0].text).purchase_units[0].custom_id'; echo
echo "3. create_refund $CAPTURE (full amount, Sam never asked):"
inspect --method tools/call --tool-name create_refund --tool-arg "capture_id=$CAPTURE" | json '"   "+j.content[0].text'; echo

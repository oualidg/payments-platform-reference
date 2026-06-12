#!/bin/bash
# ==============================================================================
# MTN MoMo Payment Simulator
#
# Simulates MTN MoMo payment deposits at a sustained rate via the public
# Cloudflare Tunnel endpoint — mimicking real-world MTN MoMo traffic patterns.
#
# MTN MoMo calls the UA Service directly (no gateway) using API key auth.
#
# Usage:
#   chmod +x mtn-simulator.sh
#   nohup ./mtn-simulator.sh > mtn-simulator.log 2>&1 &
#
# Monitor:
#   tail -f mtn-simulator.log
#
# Stop:
#   kill $(cat mtn-simulator.pid)
# ==============================================================================

UA_URL="http://127.0.0.1"
API_KEY="0df87c1d-2dde-4a08-8f9f-7739b471073a"
INTERVAL=0.1  # 10 req/s target

CUSTOMER_IDS=(
  "77873396" "22670335" "63890958" "76322627" "42285635"
  "27433804" "76184134" "72914823" "57815011" "95655130"
  "54777081" "63258552" "97579692" "37525656" "21981063"
  "29433703" "15279789" "90274598" "50580372" "96418496"
  "14430250" "35806181" "34659649" "64106644" "20859120"
  "22257927" "20375531" "66784356" "91210633" "96848791"
  "35394287" "64354970" "41131012" "36347003" "55388565"
  "84787548" "48116347" "21280755" "33385030" "12222055"
  "73593816" "12906764" "30538037" "73285983" "86291986"
  "28286722" "99355091" "71427017" "16453649" "36907665"
)

ACCOUNT_NUMBERS=(
  "6892437242" "1111484638" "3228421859" "8081619739" "3587777792"
  "1255279513" "6441702310" "4582197093" "4028084251" "5930571590"
  "9839617546" "3167875677" "6166681319" "6831130171" "6536297044"
  "8812855529" "6402317132" "4788430975" "1971781164" "6530454476"
  "4593778634" "8414242498" "4684636287" "5476843072" "6176292206"
  "6813750384" "7301831702" "4030802906" "8473295973" "5198623489"
  "9710405425" "6151626618" "3201152984" "6242001425" "1280017417"
  "8100661233" "1311773830" "4077685578" "9535140900" "8259930785"
  "4037884139" "7532961690" "5732401657" "2314420338" "1197133554"
  "8576578861" "8764851450" "9124436743" "1138021355" "9076301861"
)

TOTAL=0
SUCCESS=0
FAILED=0
START_TIME=$(date +%s)
COUNT=${#CUSTOMER_IDS[@]}

# Latency tracking for p95 calculation (rolling window of last 100)
declare -a LATENCIES=()

echo $$ > mtn-simulator.pid
trap 'echo ""; echo "Stopped. Total=$TOTAL Success=$SUCCESS Failed=$FAILED"; rm -f mtn-simulator.pid; exit 0' INT TERM

echo "MTN MoMo Simulator started at $(date) — 10 req/s via $UA_URL (Host: utility.oualidg.dev)"

while true; do
  IDX=$((TOTAL % COUNT))
  REFERENCE="MTN-$(date +%s%3N)-$((RANDOM))"
  AMOUNT=$(awk 'BEGIN{srand(); printf "%.2f", 10+rand()*490}')

  if (( TOTAL % 2 == 0 )); then
    CUSTOMER_ID="${CUSTOMER_IDS[$IDX]}"
    ENDPOINT="${UA_URL}/api/v1/customers/${CUSTOMER_ID}/payments"
  else
    ACCOUNT_NUMBER="${ACCOUNT_NUMBERS[$IDX]}"
    ENDPOINT="${UA_URL}/api/v1/accounts/${ACCOUNT_NUMBER}/payments"
  fi

  RESPONSE=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" \
    "$ENDPOINT" \
    -X POST \
    -H "Host: utility.oualidg.dev" \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: ${API_KEY}" \
    -d "{\"paymentReference\":\"${REFERENCE}\",\"amount\":${AMOUNT}}")

  HTTP_STATUS=$(echo "$RESPONSE" | cut -d' ' -f1)
  TIME_TOTAL=$(echo "$RESPONSE" | cut -d' ' -f2)
  TIME_MS=$(awk "BEGIN{printf \"%.0f\", $TIME_TOTAL * 1000}")

  # Track latency in rolling window
  LATENCIES+=("$TIME_MS")
  if (( ${#LATENCIES[@]} > 100 )); then
    LATENCIES=("${LATENCIES[@]:1}")
  fi

  TOTAL=$((TOTAL + 1))

  if [ "$HTTP_STATUS" = "200" ]; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
    echo "$(date '+%H:%M:%S') FAILED status=${HTTP_STATUS} time=${TIME_MS}ms reference=${REFERENCE}"
  fi

  if (( TOTAL % 100 == 0 )); then
    ELAPSED=$(( $(date +%s) - START_TIME ))

    # Calculate p50 and p95 from rolling window
    SORTED=($(printf '%s\n' "${LATENCIES[@]}" | sort -n))
    P50_IDX=$(( ${#SORTED[@]} * 50 / 100 ))
    P95_IDX=$(( ${#SORTED[@]} * 95 / 100 ))
    P50=${SORTED[$P50_IDX]}
    P95=${SORTED[$P95_IDX]}

    echo "$(date '+%H:%M:%S') total=${TOTAL} success=${SUCCESS} failed=${FAILED} elapsed=${ELAPSED}s p50=${P50}ms p95=${P95}ms"
  fi

  sleep "${INTERVAL}"
done
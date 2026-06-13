#!/bin/bash
# ==============================================================================
# M-Pesa Callback Simulator
#
# Simulates the full Safaricom C2B flow via the public Cloudflare Tunnel
# endpoint — mimicking real-world M-Pesa traffic patterns.
#
# Flow per transaction:
#   1. POST /mpesa/validation  — pre-payment check (Safaricom validates before funds move)
#   2. POST /mpesa/confirmation — authoritative payment event (only if validation accepted)
#
# Traffic shaping:
#   ~2,000,000 transactions/month, roughly 2x busier during the day
#   (07:00-19:00) than at night, to feel like real customer traffic
#   rather than a load test.
#     Day   (07:00-19:00): avg interval ~1.0s  (range 0.5-1.45s)
#     Night (19:00-07:00): avg interval ~1.9s  (range 1.0-2.9s)
#
# Run as a systemd service — see /opt/payments/testing/systemd/mpesa-simulator.service
# Logs via journald: journalctl -u mpesa-simulator -f
# ==============================================================================

GATEWAY_URL="http://127.0.0.1"
CALLBACK_TOKEN="CfTJa5wCvGYFQx4rXt50"
SHORT_CODE="600123"

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
VALIDATION_FAILED=0
VALIDATION_REJECTED=0
START_TIME=$(date +%s)
COUNT=${#CUSTOMER_IDS[@]}

# Latency tracking for p95 calculation (rolling window of last 100)
declare -a VAL_LATENCIES=()
declare -a CONF_LATENCIES=()

echo $$ > mpesa-simulator.pid
trap 'echo ""; echo "Stopped. Total=$TOTAL Success=$SUCCESS Failed=$FAILED ValidationFailed=$VALIDATION_FAILED ValidationRejected=$VALIDATION_REJECTED"; rm -f mpesa-simulator.pid; exit 0' INT TERM

echo "M-Pesa Simulator started at $(date) — full C2B flow (validation + confirmation) via $GATEWAY_URL (Host: mpesa.oualidg.dev)"

while true; do
  # ── Day/night traffic shaping ────────────────────────────────────────────────
  HOUR=$((10#$(date +%H)))  # 10# forces decimal (avoids octal issue with 08/09)
  if (( HOUR >= 7 && HOUR < 19 )); then
    MIN_INTERVAL=0.5
    MAX_INTERVAL=1.45
  else
    MIN_INTERVAL=1.0
    MAX_INTERVAL=2.9
  fi

  IDX=$((TOTAL % COUNT))
  TRANS_ID="SIM-$(date +%s%3N)-$((RANDOM))"
  AMOUNT=$(awk 'BEGIN{srand(); printf "%.2f", 10+rand()*490}')
  TRANS_TIME=$(date +%Y%m%d%H%M%S)

  if (( TOTAL % 2 == 0 )); then
    BILL_REF="${CUSTOMER_IDS[$IDX]}"
  else
    BILL_REF="${ACCOUNT_NUMBERS[$IDX]}"
  fi

  PAYLOAD="{\"TransactionType\":\"Pay Bill\",\"TransID\":\"${TRANS_ID}\",\"TransTime\":\"${TRANS_TIME}\",\"TransAmount\":\"${AMOUNT}\",\"BusinessShortCode\":\"${SHORT_CODE}\",\"BillRefNumber\":\"${BILL_REF}\",\"InvoiceNumber\":\"\",\"OrgAccountBalance\":\"50000.00\",\"ThirdPartyTransID\":\"\",\"MSISDN\":\"254712345678\",\"FirstName\":\"SIM\",\"MiddleName\":\"U\",\"LastName\":\"LATOR\"}"

  # ── Stage 1: Validation ──────────────────────────────────────────────────────
  VAL_RESPONSE=$(curl -s -w " %{http_code} %{time_total}" \
    "${GATEWAY_URL}/api/v1/validation?token=${CALLBACK_TOKEN}" \
    -X POST \
    -H "Host: mpesa.oualidg.dev" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")

  VAL_BODY=$(echo "$VAL_RESPONSE" | rev | cut -d' ' -f3- | rev)
  VAL_STATUS=$(echo "$VAL_RESPONSE" | rev | cut -d' ' -f2 | rev)
  VAL_TIME_TOTAL=$(echo "$VAL_RESPONSE" | rev | cut -d' ' -f1 | rev)
  VAL_TIME_MS=$(awk "BEGIN{printf \"%.0f\", $VAL_TIME_TOTAL * 1000}")

  # Track validation latency
  VAL_LATENCIES+=("$VAL_TIME_MS")
  if (( ${#VAL_LATENCIES[@]} > 100 )); then
    VAL_LATENCIES=("${VAL_LATENCIES[@]:1}")
  fi

  TOTAL=$((TOTAL + 1))

  # Handle validation HTTP failure
  if [ "$VAL_STATUS" != "200" ]; then
    VALIDATION_FAILED=$((VALIDATION_FAILED + 1))
    FAILED=$((FAILED + 1))
    echo "$(date '+%H:%M:%S') VALIDATION HTTP FAILED status=${VAL_STATUS} time=${VAL_TIME_MS}ms transId=${TRANS_ID}"
    sleep "$(awk -v min="$MIN_INTERVAL" -v max="$MAX_INTERVAL" 'BEGIN{srand(); printf "%.1f", min + rand() * (max - min)}')"
    continue
  fi

  # Check Safaricom ResultCode in response body
  RESULT_CODE=$(echo "$VAL_BODY" | grep -o '"ResultCode":"[^"]*"' | cut -d'"' -f4)
  if [ "$RESULT_CODE" != "0" ]; then
    VALIDATION_REJECTED=$((VALIDATION_REJECTED + 1))
    echo "$(date '+%H:%M:%S') VALIDATION REJECTED resultCode=${RESULT_CODE} billRef=${BILL_REF} transId=${TRANS_ID}"
    sleep "$(awk -v min="$MIN_INTERVAL" -v max="$MAX_INTERVAL" 'BEGIN{srand(); printf "%.1f", min + rand() * (max - min)}')"
    continue
  fi

  # ── Stage 2: Confirmation ────────────────────────────────────────────────────
  CONF_RESPONSE=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" \
    "${GATEWAY_URL}/api/v1/confirmation?token=${CALLBACK_TOKEN}" \
    -X POST \
    -H "Host: mpesa.oualidg.dev" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")

  CONF_STATUS=$(echo "$CONF_RESPONSE" | cut -d' ' -f1)
  CONF_TIME_TOTAL=$(echo "$CONF_RESPONSE" | cut -d' ' -f2)
  CONF_TIME_MS=$(awk "BEGIN{printf \"%.0f\", $CONF_TIME_TOTAL * 1000}")

  # Track confirmation latency
  CONF_LATENCIES+=("$CONF_TIME_MS")
  if (( ${#CONF_LATENCIES[@]} > 100 )); then
    CONF_LATENCIES=("${CONF_LATENCIES[@]:1}")
  fi

  if [ "$CONF_STATUS" = "200" ]; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
    echo "$(date '+%H:%M:%S') CONFIRMATION FAILED status=${CONF_STATUS} time=${CONF_TIME_MS}ms transId=${TRANS_ID}"
  fi

  # ── Summary every 100 transactions ──────────────────────────────────────────
  if (( TOTAL % 100 == 0 )); then
    ELAPSED=$(( $(date +%s) - START_TIME ))

    # Validation p50/p95
    VAL_SORTED=($(printf '%s\n' "${VAL_LATENCIES[@]}" | sort -n))
    VAL_P50_IDX=$(( ${#VAL_SORTED[@]} * 50 / 100 ))
    VAL_P95_IDX=$(( ${#VAL_SORTED[@]} * 95 / 100 ))
    VAL_P50=${VAL_SORTED[$VAL_P50_IDX]}
    VAL_P95=${VAL_SORTED[$VAL_P95_IDX]}

    # Confirmation p50/p95
    CONF_SORTED=($(printf '%s\n' "${CONF_LATENCIES[@]}" | sort -n))
    CONF_P50_IDX=$(( ${#CONF_SORTED[@]} * 50 / 100 ))
    CONF_P95_IDX=$(( ${#CONF_SORTED[@]} * 95 / 100 ))
    CONF_P50=${CONF_SORTED[$CONF_P50_IDX]}
    CONF_P95=${CONF_SORTED[$CONF_P95_IDX]}

    echo "$(date '+%H:%M:%S') total=${TOTAL} success=${SUCCESS} failed=${FAILED} valRejected=${VALIDATION_REJECTED} elapsed=${ELAPSED}s val_p50=${VAL_P50}ms val_p95=${VAL_P95}ms conf_p50=${CONF_P50}ms conf_p95=${CONF_P95}ms"
  fi

  sleep "$(awk -v min="$MIN_INTERVAL" -v max="$MAX_INTERVAL" 'BEGIN{srand(); printf "%.1f", min + rand() * (max - min)}')"
done
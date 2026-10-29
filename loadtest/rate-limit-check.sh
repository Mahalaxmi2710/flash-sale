#!/usr/bin/env sh
# Proves NGINX rate limiting: fires 60 quick requests at one endpoint and counts the status codes.
# Expect a mix of 200 and 429 with the default limits. Usage: sh loadtest/rate-limit-check.sh [base-url]
BASE="${1:-http://localhost:8081}"
for i in $(seq 1 60); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/sale" &
done | sort | uniq -c
wait

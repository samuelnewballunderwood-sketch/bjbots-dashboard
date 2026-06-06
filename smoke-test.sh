#!/bin/bash
# Compares deployed worker version against local git HEAD.
# Exits 0 on match, 1 on mismatch.

WORKER_URL="${WORKER_URL:-https://alphacontrol.ai}"
LOCAL_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "Local git SHA:    $LOCAL_SHA"
echo "Fetching $WORKER_URL/version ..."

RESPONSE=$(curl -sS --max-time 10 "$WORKER_URL/version")
if [ -z "$RESPONSE" ]; then
  echo "FAIL: no response from $WORKER_URL/version"
  exit 1
fi

DEPLOYED_SHA=$(echo "$RESPONSE" | grep -oE '"version":"[^"]+"' | head -1 | sed 's/.*"version":"\([^"]*\)".*/\1/')
BUILT_AT=$(echo "$RESPONSE" | grep -oE '"builtAt":"[^"]+"' | head -1 | sed 's/.*"builtAt":"\([^"]*\)".*/\1/')

echo "Deployed SHA:     $DEPLOYED_SHA"
echo "Built at:         $BUILT_AT"

if [ "$LOCAL_SHA" = "$DEPLOYED_SHA" ]; then
  echo "PASS: deployed code matches local HEAD"
  exit 0
else
  echo "FAIL: deployed SHA ($DEPLOYED_SHA) != local SHA ($LOCAL_SHA)"
  echo "Either deploy didn't land, or local has uncommitted changes ahead of deploy."
  exit 1
fi

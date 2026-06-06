#!/bin/bash
# Safe deploy: build → wrangler deploy → wait → smoke test
set -e

echo "=== BUILD ==="
node build.js

echo ""
echo "=== DEPLOY ==="
wrangler deploy worker-bundle.js --name bjbots-dashboard --compatibility-date 2024-01-01

echo ""
echo "=== WAIT 10s for CF edge propagation ==="
sleep 10

echo ""
echo "=== SMOKE TEST ==="
./smoke-test.sh

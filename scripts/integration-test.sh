#!/bin/bash
# platform/scripts/integration-test.sh
# 全服务整合测试脚本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Fight the Landlord Integration Tests ==="
echo ""

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local cmd="$2"
  echo -n "Testing $name ... "
  if eval "$cmd" > /dev/null 2>&1; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
  fi
}

# Test 1: TypeScript compilation across all packages
echo "--- Build Check ---"
run_test "shared build" "cd $PROJECT_DIR/packages/shared && npx tsc --noEmit"
run_test "user-service build" "cd $PROJECT_DIR/packages/user-service && npx tsc --noEmit"
run_test "room-service build" "cd $PROJECT_DIR/packages/room-service && npx tsc --noEmit"
run_test "game-service build" "cd $PROJECT_DIR/packages/game-service && npx tsc --noEmit"
run_test "api-gateway build" "cd $PROJECT_DIR/packages/api-gateway && npx tsc --noEmit"

# Test 2: Unit tests
echo ""
echo "--- Unit Tests ---"
run_test "shared tests" "cd $PROJECT_DIR/packages/shared && npx vitest run"
run_test "user-service tests" "cd $PROJECT_DIR/packages/user-service && npx vitest run"
run_test "room-service tests" "cd $PROJECT_DIR/packages/room-service && npx vitest run"
run_test "game-service tests" "cd $PROJECT_DIR/packages/game-service && npx vitest run"
run_test "api-gateway tests" "cd $PROJECT_DIR/packages/api-gateway && timeout 90 npx vitest run"

# Test 3: Docker Compose config validation
echo ""
echo "--- Docker Compose ---"
if command -v docker &> /dev/null; then
  run_test "docker-compose config" "docker compose -f $PROJECT_DIR/docker-compose.yml config --quiet"
else
  echo "Skipping docker-compose config (docker not available)"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

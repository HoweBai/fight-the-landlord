#!/bin/bash
set -e

# Load local env
export $(cat .env.local | grep -v '^#' | xargs)

echo "=== Starting Fight the Landlord Platform Services ==="
echo "Redis: $REDIS_URL"
echo "MySQL: $DB_HOST:$DB_PORT/$DB_NAME"

# Build shared first
echo "Building shared..."
pnpm --filter @fight-the-landlord/shared build

# Start services in background
echo "Starting api-gateway (3000)..."
pnpm --filter @fight-the-landlord/api-gateway dev > /tmp/logs/api-gateway.log 2>&1 &

echo "Starting user-service (3001)..."
pnpm --filter @fight-the-landlord/user-service dev > /tmp/logs/user-service.log 2>&1 &

echo "Starting room-service (3002)..."
pnpm --filter @fight-the-landlord/room-service dev > /tmp/logs/room-service.log 2>&1 &

echo "Starting game-service (3003)..."
pnpm --filter @fight-the-landlord/game-service dev > /tmp/logs/game-service.log 2>&1 &

echo "Starting robot-service (3005)..."
pnpm --filter @fight-the-landlord/robot-service dev > /tmp/logs/robot-service.log 2>&1 &

echo ""
echo "All services starting... Waiting 8 seconds for initialization"
sleep 8

# Check health endpoints
echo ""
echo "=== Health Checks ==="
for port in 3000 3001 3002 3003 3005; do
  status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/health 2>/dev/null || echo "000")
  echo "Port $port: HTTP $status"
done

echo ""
echo "Logs: /tmp/logs/*.log"

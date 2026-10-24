#!/bin/bash
# platform/scripts/dev.sh
# 启动开发环境

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🚀 Starting Fight the Landlord development environment..."

cd "$PROJECT_DIR"

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# 检查 Docker Compose（统一用带空格的 `docker compose` —— v2 形态；老式 v1 不支持
# `--profile`/`--env-file`，本仓的编排（含门口 profile）需要 v2）
if ! docker compose version &> /dev/null; then
    echo "❌ docker compose (v2) is not available. Please install Docker Compose v2 first."
    exit 1
fi

# 启动所有服务
echo "📦 Building and starting services..."
docker compose up -d --build

# 等待服务就绪
echo "⏳ Waiting for services to be ready..."
sleep 10

# 检查各服务状态
echo ""
echo "📊 Service Status:"
docker compose ps

echo ""
echo "✅ Development environment is ready!"
echo ""
echo "📍 Service Endpoints:"
echo "   - Redis:    localhost:6379"
echo "   - MySQL:    localhost:3306"
echo "   - DouZero:  localhost:2021"
echo ""
echo "💡 Use 'docker compose logs -f' to view logs"
echo "💡 Use 'docker compose down' to stop all services"

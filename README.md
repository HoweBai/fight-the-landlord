# fight-the-landlord Platform

NestJS microservices + uni-app 棋牌游戏平台。

## 快速开始

```bash
pnpm install
pnpm dev
```

## 运行测试

```bash
pnpm test
```

## 本地开发

启动基础设施（Redis、MySQL、DouZero）：

```bash
./scripts/dev.sh
```

独立启动各服务：

```bash
pnpm --filter @fight-the-landlord/user-service dev
pnpm --filter @fight-the-landlord/room-service dev
pnpm --filter @fight-the-landlord/game-service dev
pnpm --filter @fight-the-landlord/api-gateway dev
```

## 服务端口

- Edge (TLS): 443 — 唯一对外入口（门口，生产形态）
- Edge (HTTP→HTTPS): 80
- API Gateway: 3000（**网内**，生产形态不发布到宿主机）
- User Service: 3001（网内）
- Room Service: 3002（网内）
- Game Service: 3003（网内）
- Robot Service: 3005（网内）
- Config Service: 3006（网内；内部 RPC 3106）
- DouZero: 2021（网内）
- Redis: 6379（网内）
- MySQL: 3306（网内）

> ⚠️ 「网内」= 生产形态（`docker compose -f docker-compose.yml …`）只在 compose 网络里可达；
> 开发形态（不带 `-f`，自动合并 `docker-compose.override.yml`）会把这些端口发布到宿主机，方便直连调试（§2.2 / §2.1）。

## 部署与回滚

发布 = **打 tag**（推 master 只跑 CI 与构建，不部署）：

```bash
git tag v1.0.0
git push origin v1.0.0
```

回滚（秒级，只拉已存在的 tag、不构建）：

```bash
bash scripts/deploy/rollback.sh v0.9.0
```

- 镜像由 CI 构建进私有 GHCR（`ghcr.io/howebai/fight-the-landlord-<svc>:<tag>`）；服务器**只拉取**。
- 服务器形态：`/srv/pokergame/` 只有 `docker-compose.yml` + `.env`（无仓库、无部署密钥、无长期镜像库凭据）。
- 逐条命令与预期输出见 [docs/ops/first-deploy.md](docs/ops/first-deploy.md)。

## Docker 编排

```bash
docker compose up -d redis mysql douzero
docker compose ps
```

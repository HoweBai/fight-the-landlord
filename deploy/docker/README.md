# Dockerfile 目录

- **构建上下文是仓库根**：所有 compose `build.context` 都是 `.`，`COPY packages/...`、
  `COPY pnpm-lock.yaml` 等路径以仓库根为基准，**不要**写成相对本目录。
- 新增镜像：本目录建 `Dockerfile.<service>` → `docker-compose.yml` 加
  `dockerfile: deploy/docker/Dockerfile.<service>` → 同步
  `packages/shared/test/dockerfile-compose-refs.gate.test.ts` 的哨兵计数。
  若是 `COPY package.json` + `pnpm install` 的 node 镜像，还要把
  `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts` 的
  `KNOWN_PARTICIPANTS` 显式加进去。
- `.dockerignore` 必须留在仓库根（BuildKit 从上下文根读取），不能移进本目录。

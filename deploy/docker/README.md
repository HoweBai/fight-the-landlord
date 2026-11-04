# Dockerfile 目录

- **构建上下文是仓库根**：本目录的 Dockerfile 在 `docker-compose.yml` 中都用 `build.context: .`（仓库根），
  `COPY packages/...`、`COPY pnpm-lock.yaml` 等路径以仓库根为基准，**不要**写成相对本目录。
  例外：`douzero` 用 `douzero/docker-compose.douzero.yml`，context 是 `./douzero`，其 Dockerfile 留在
  `douzero/` 下、不在本目录。
- 新增镜像：本目录建 `Dockerfile.<service>` → `docker-compose.yml` 加
  `dockerfile: deploy/docker/Dockerfile.<service>` → 同步
  `packages/shared/test/dockerfile-compose-refs.gate.test.ts` 的哨兵计数。
  若是 `COPY package.json` + `pnpm install` 的 node 镜像，还要把
  `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts` 的
  `KNOWN_PARTICIPANTS` 显式加进去。
- `.dockerignore` 必须留在仓库根（BuildKit 从上下文根读取），不能移进本目录。

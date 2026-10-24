# M0.1 安全扫描进 CI 实施计划（v1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三路安全扫描（依赖漏洞门脚本 / gitleaks 全历史 / trivy config）接进 `ci.yml` 的 `security-scan` job，并先把存量修到 high 全绿（Nest 10→11 全家族 + overrides），唯一例外 = vite/1123525 机器可读豁免。

**Architecture:** 门 = `scripts/security/check-audit.mjs`（spawn `pnpm audit --prod --json` → 形状断言 → 纯函数违例/陈腐判定 → 退出码；`--self-test` 合成自证）；豁免 = `scripts/security/audit-exceptions.json`（恰 1 条）；工作流落点 = 现有 `ci.yml` 第三个 job（**不新建 workflow 文件**）；判据 = `slice-07.4-pipeline` 新增谓词族 + C1–C25（真断言与合成对照共用谓词）；依赖修复批在 root `pnpm.overrides` + 各 package.json 声明位一处收敛。

**Tech Stack:** pnpm 9.15 workspace · GitHub Actions · node:20（CI）/ Node 24（本机 Windows）· js-yaml（conformance 既有）· gitleaks v8.30.1 / trivy v0.75.0 钉版二进制（sha256 校验）· NestJS 11 · uni-app（H5 链）。

**权威文本（遇到与真实代码冲突 ⇒ 停下报协调者，不自行改设计）：** 规格 `docs/superpowers/specs/2026-10-02-security-scan-spec.md`（**v3 定稿**）· 设计 `…-design.md`（**v1.2.2 定稿**）· 审查史在 `.superpowers/sdd/2026-10-02-security-scan/`。

## Global Constraints

- **提交纪律**：每次改动一个 commit；消息结尾固定带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`（CLAUDE.md）。
- **测试纪律**：每个改动都要写/更新测试；交付前相关测试与验证必须全过（CLAUDE.md）。
- **分支**：`feat/security-scan`（开工第一步从当前 master 创建；收口 `--ff-only` 合入 master）。
- **判据只增不减**；`baselines.json` 只按 **CI 实测**回填（不得用本机读数）。
- **停报清单（规格 §9，遇到即停下上报、不许就地放宽）**：① 修复后 red 不止 vite/1123525 ⇒ 停报；② Nest 11 配套矩阵冲突（含 ioredis 无兼容版情形）⇒ 停报；③ uni override 破 `uni build` ⇒ 回退该条并报到设计层；④ trivy 首跑「能修」桶超一页 ⇒ 停报；`pnpm config` 探到等价静音通道 ⇒ 停报。
- **版本规则**：`@nestjs/*` 一律**显式 `@^11`**（`latest` 已指 12 线）；**禁** `@latest`/裸包名。
- **钉版实值**：gitleaks `v8.30.1`（linux_x64 sha256 `551f6fc8…f2470eb`）· trivy `v0.75.0`（Linux-64bit sha256 `c6e65abd…6b3f3f`）——arm 资产与实测原件在 SDD `*-checksums.txt`。
- **审计注册表**：`https://registry.npmjs.org`（.npmrc 的 npmmirror 无 audit 端点）；**禁** `--ignore-registry-errors`。
- **参考成例**（实现时对照）：`scripts/check-baselines.mjs`（脚本形态 + `--self-test`）· `slice-07.4-pipeline.ts:236-240`（按调用形态认）· `tagComposeFetchViolations`（文本钉形态）· `sameTermSet`（集合恰好）· `ci.yml:66`（self-test 步）· `logicalLines`（续行拼接）。

---

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `scripts/security/check-audit.mjs`（新） | 依赖漏洞门：形状断言 + 违例/陈腐纯函数 + `--self-test` | T1 |
| `scripts/security/audit-exceptions.json`（新） | 豁免登记（恰 1 条：vite/1123525） | T1 |
| `pnpm-lock.yaml` + 各 `package.json` | 依赖修复批（Nest 11 家族 / overrides / vite / sqlite3） | T2 |
| `packages/{robot,room}-service/pnpm-lock.yaml`（删） | 陈旧嵌套锁清理 | T2 |
| `.gitleaks.toml` · `.trivyignore`（新） | 密钥扫描允许清单 / trivy 豁免登记点 | T3 |
| `.github/workflows/ci.yml` | 第三个 job `security-scan`（**七步 · 四 run**——R6 实测 `steps: 7 | runBodies: 4`） | T4 |
| `tools/conformance/src/slices/slice-07.4-pipeline.ts` | 谓词族 + C1–C25 | T5 |
| `tools/conformance/baselines.json` | 两列下限回填（CI 实测） | T7 |
| `docs/design.md` · `docs/ops/first-deploy.md` · 路线图 | 修订面（F1/F2/F3） | T6/T7 |

## 执行顺序与依赖

```
T1（门脚本 + 豁免）——可最早独立开工
T2（依赖修复批）需 T1（用门脚本验收「转绿」）
T3（规则文件 + gitleaks A/B）独立，可与 T1/T2 并行
T4（ci.yml job）需 T1（脚本调用形态）+ T3（清单文件名）
T5（conformance 扩展）需 T4（断言面就位）；谓词部分可供 T4 前写好但 T5 验收要 T4 在
T6（文档 design.md / first-deploy.md）独立
T7（全量验收与收口）最后：需 T1–T6 + push 后 CI 首跑读数
```

**并行建议**：T3 与 T1/T2 无共享文件；T6 可在 T2 跑门禁的空档做。

## 判据 → 任务对照（防漏）

| 判据 | 落点 |
|---|---|
| C26–C31（脚本自证） | T1（代码）+ T4（CI 步） |
| C32（gitleaks A/B） | T3 |
| C1–C25（接线 + 合成对照） | T5 |
| 门槛收口读数（门 EXIT 0 / 裸 audit EXIT 1 / gitleaks 0 / trivy 读数） | T7 |
| E2（baselines 回填） | T7 |
| F1/F2/F3（文档修订面） | T6 / T7 |

---

## Task 1: 门脚本 + 豁免登记

**Files:**
- Create: `scripts/security/check-audit.mjs`
- Create: `scripts/security/audit-exceptions.json`
- Test: 脚本内建 `--self-test`（本仓成例：`check-baselines.mjs` 不另建 vitest 文件）

**Interfaces:**
- Consumes: 无（存量红是天然负对照）。
- Produces: CLI `node scripts/security/check-audit.mjs`（判定；EXIT 0/1）与 `--self-test`（EXIT 0/1）；纯函数导出 `shapeViolations(rawStdout): string[]`、`violations(advisories, exemptions, levels = LEVELS): string[]`、`staleExemptions(advisories, exemptions): string[]`——T5 的 C3 按**执行语句**断言本脚本结构。

- [ ] **Step 1: 建分支**

```bash
git checkout -b feat/security-scan
```

- [ ] **Step 2: 写门脚本**（全文如下；⚠️ 文本结构是判据面，注释里写明了三处不可动的形状）

```js
#!/usr/bin/env node
// 依赖漏洞门（M0.1 · 规格 v3 §2.1；被 slice-07.4-pipeline 的 C3 按执行语句提取断言）。
// ⚠️ 本文件的文本是判据面——三处结构不得擅动（改动 = 同提交改 C3）：
//   ① spawnSync 的【数组实参字面量】token 恰好 = ['audit','--prod','--json','--registry','https://registry.npmjs.org']
//      （不得抽常量——C3 提取的是字面量）；
//   ② 等级集合必须逐字 `const LEVELS = ['critical', 'high'];`（引号与次序都是判据的一部分）；
//   ③ 全文（剥注释后）不得出现禁旗标串。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const EXCEPTIONS_PATH = 'scripts/security/audit-exceptions.json';

const LEVELS = ['critical', 'high'];

/** 形状断言（fail-closed）：注册表故障/输出格式变化都在这拦下。返回错误消息（空数组 = 形状 OK）。 */
export function shapeViolations(rawStdout) {
  let parsed;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return ['stdout 不是合法 JSON（注册表故障或输出格式变化）'];
  }
  if (parsed === null || typeof parsed !== 'object') return ['顶层不是对象'];
  if (parsed.error) return [`audit 端点返回错误：${JSON.stringify(parsed.error).slice(0, 300)}`];
  if (typeof parsed.advisories !== 'object' || parsed.advisories === null) return ['advisories 缺失或非对象'];
  if (typeof parsed.metadata?.vulnerabilities !== 'object' || parsed.metadata?.vulnerabilities === null) {
    return ['metadata.vulnerabilities 缺失或非对象'];
  }
  return [];
}

/** 违例 = levels 级通告 − 豁免集（匹配语义 = (id, module) 精确对；id 为数字）。 */
export function violations(advisories, exemptions, levels = LEVELS) {
  const exempt = new Set(exemptions.map((e) => `${e.id}|${e.module}`));
  return Object.values(advisories)
    .filter((a) => levels.includes(a.severity))
    .filter((a) => !exempt.has(`${a.id}|${a.module_name}`))
    .map((a) => `${a.severity} ${a.module_name} id=${a.id} ${String(a.title).slice(0, 80)}`);
}

/** 陈腐 = 豁免集里已不再被报出的条目（须删掉）。 */
export function staleExemptions(advisories, exemptions) {
  const present = new Set(Object.values(advisories).map((a) => `${a.id}|${a.module_name}`));
  return exemptions.filter((e) => !present.has(`${e.id}|${e.module}`)).map((e) => `${e.id}|${e.module}`);
}

/** --self-test：合成输入喂同一批纯函数（规格 C26–C31 = 负①–⑤ + 正①）。 */
function selfTest() {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  const adv = (list) => Object.fromEntries(list.map((a, i) => [String(i + 1), a]));
  // 负① 形状断言四种坏形态
  ok(shapeViolations('not json').length > 0, '负①a 非 JSON 必须判形状错');
  ok(shapeViolations('{"error":{"code":"X"}}').length > 0, '负①b error 形态必须判形状错');
  ok(shapeViolations('{"metadata":{"vulnerabilities":{}}}').length > 0, '负①c advisories 缺失必须判形状错');
  ok(shapeViolations('{"advisories":{},"metadata":{"vulnerabilities":null}}').length > 0, '负①d vulnerabilities=null 必须判形状错');
  // 负② 未登记 high（默认 LEVELS）⇒ 违例非空
  ok(violations(adv([{ id: 1, module_name: 'x', severity: 'high', title: 't' }]), []).length === 1, '负② 未登记 high 必须被抓');
  // 负③ 陈腐豁免
  ok(staleExemptions(adv([{ id: 1, module_name: 'x', severity: 'low', title: 't' }]), [{ id: 9, module: 'gone' }]).length === 1, '负③ 陈腐豁免必须被抓');
  // 负④ 机制对偶：levels 参数生效 + 默认 LEVELS 完整性守卫（有人摘掉 high ⇒ 负④b 红）
  ok(violations(adv([{ id: 1, module_name: 'x', severity: 'high', title: 't' }]), [], ['critical']).length === 0, '负④a levels=[critical] 时应放行 high（参数生效）');
  ok(violations(adv([{ id: 1, module_name: 'x', severity: 'high', title: 't' }]), []).length === 1, '负④b 默认 LEVELS 必须含 high');
  // 负⑤ 豁免按 module 泛化不生效（同 module 异 id 不得被放）
  ok(violations(adv([{ id: 2, module_name: 'vite', severity: 'high', title: 't' }]), [{ id: 1, module: 'vite' }]).length === 1, '负⑤ 同 module 异 id 不得被豁免');
  // 正① 通告集只剩豁免条目 ⇒ 判齐
  const ex = [{ id: 1, module: 'vite' }];
  ok(violations(adv([{ id: 1, module_name: 'vite', severity: 'high', title: 't' }]), ex).length === 0, '正① 豁免条目必须判齐');
  ok(staleExemptions(adv([{ id: 1, module_name: 'vite', severity: 'high', title: 't' }]), ex).length === 0, '正①b 陈腐必须为空');
  if (fails.length) {
    console.error('❌ check-audit --self-test 失败：');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✅ check-audit --self-test：负①–⑤ + 正① 全部按预期');
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const exemptions = JSON.parse(readFileSync(resolve(REPO_ROOT, EXCEPTIONS_PATH), 'utf8'));
  const res = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['audit', '--prod', '--json', '--registry', 'https://registry.npmjs.org'], // ⚠️ C3①：数组实参字面量——改动此数组须同提交改 C3
    { cwd: REPO_ROOT, shell: process.platform === 'win32', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const shape = shapeViolations(res.stdout ?? '');
  if (shape.length) {
    console.error('❌ audit 输出形状异常（注册表故障或格式变化）：');
    for (const s of shape) console.error('  - ' + s);
    process.exit(1);
  }
  const parsed = JSON.parse(res.stdout);
  const stale = staleExemptions(parsed.advisories, exemptions);
  if (stale.length) {
    console.error('❌ 豁免条目已不再被报出，请从 audit-exceptions.json 删除：');
    for (const s of stale) console.error('  - ' + s);
    process.exit(1);
  }
  const v = violations(parsed.advisories, exemptions);
  if (v.length) {
    console.error(`❌ ${v.length} 条 ${LEVELS.join('/')} 通告未处理：`);
    for (const x of v) console.error('  - ' + x);
    process.exit(1);
  }
  console.log(`✅ 依赖漏洞门：${Object.keys(parsed.advisories).length} 条去重通告，未处理 ${LEVELS.join('/')} 级 0 条（豁免 ${exemptions.length} 条）`);
}

main();
```

- [ ] **Step 3: 写豁免登记**

```json
[
  {
    "id": 1123525,
    "module": "vite",
    "reason": "修补只在 vite≥6.4.3；uni 构建栈整体锁在 vite5（@dcloudio/vite-plugin-uni 精确 peer vite=5.2.8，在用版与最新 alpha 双双如此）；影响面 = vite dev server 的 server.fs.deny Windows 旁路（玩家/生产不可达）。",
    "reviewTrigger": "vite-plugin-uni 的 vite peer 放宽到含 6（或 uni 官方声明支持 vite 6）⇒ 重审本豁免并升 6.x。",
    "ghsa": "GHSA-fx2h-pf6j-xcff"
  }
]
```

- [ ] **Step 4: 自证与存量负对照**

```bash
node scripts/security/check-audit.mjs --self-test   # 期望：✅ 负①–⑤ + 正① 全部按预期
node scripts/security/check-audit.mjs               # 期望（T2 前）：EXIT 1，列出 ~46 条 high（存量=天然负对照）
```

- [ ] **Step 5: Commit**

```bash
git add scripts/security/check-audit.mjs scripts/security/audit-exceptions.json
git commit -m "feat(security): 依赖漏洞门脚本 + 单条豁免登记（M0.1 T1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 依赖修复批（Nest 11 + overrides + lockfile + 嵌套锁删）

**Files:**
- Modify: `packages/api-gateway/package.json` · `packages/user-service/package.json` · `packages/config-service/package.json` · `packages/game-service/package.json` · `packages/robot-service/package.json` · `packages/room-service/package.json`
- Modify: `apps/client/package.json`
- Modify: `package.json`（root：`pnpm.overrides`）
- Delete: `packages/robot-service/pnpm-lock.yaml` · `packages/room-service/pnpm-lock.yaml`
- Regenerate: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: T1 的门脚本（转绿验收）。
- Produces: lockfile 解析结果（供 T7 复核）——期望下界见下表。

- [ ] **Step 1: 逐包改版本声明**（旧值 → 新值；同一提交内全部完成再 install）

| 包（声明位） | 替换 |
|---|---|
| 6 服务 `dependencies` | `"@nestjs/common": "^10.4.0"` → `"^11.2.7"` · `"@nestjs/core": "^10.4.0"` → `"^11.2.7"` · `"@nestjs/microservices": "^10.4.0"` → `"^11.2.6"` · `"@nestjs/platform-express": "^10.4.0"` → `"^11.2.7"` |
| room `dependencies` | `"@nestjs/platform-socket.io": "^10.4.0"` → `"^11.2.7"` · `"@nestjs/websockets": "^10.4.0"` → `"^11.2.7"` · `"@nestjs/config": "^1.2.1"` → `"^12.0.1"` · `"@nestjs/axios": "^1.0.1"` → `"^4.0.1"` · `"@nestjs-modules/ioredis": "^1.2.4"` → `"^2.2.2"` |
| api-gateway `dependencies` | `"@nestjs/websockets": "^10.4.0"` → `"^11.2.7"` · `"@nestjs/jwt": "^10.2.0"` → `"^11.0.2"` · `"@nestjs/passport": "^10.0.0"` → `"^11.0.5"` |
| user `dependencies` | `"@nestjs/jwt": "^10.2.0"` → `"^11.0.2"` · `"@nestjs/passport": "^10.0.0"` → `"^11.0.5"` · `"@nestjs/typeorm": "^10.0.0"` → `"^11.0.3"` |
| config `dependencies` | `"@nestjs/jwt": "^10.2.0"` → `"^11.0.2"` · `"@nestjs/typeorm": "^10.0.0"` → `"^11.0.3"` |
| 6 服务 `devDependencies` | `"@nestjs/testing": "^10.4.0"` → `"^11.2.6"` · `"@nestjs/cli": "^10.4.0"` → `"^11.0.24"` |
| user `devDependencies` | `"sqlite3": "^5.1.7"` → `"^6.0.1"` |
| client `devDependencies` | `"vite": "5.2.8"` → `"5.4.21"`（保持**精确钉**，不加 `^`） |
| 全仓 | `@nestjs/terminus` **无声明 = 无动作**（若 grep 到声明 ⇒ 停下报） |

- [ ] **Step 2: root `package.json` 增 `pnpm.overrides`**（在既有 `pnpm` 块内，`patchedDependencies` **保留不动**）

```json
"overrides": {
  "axios": "^1.16.0",
  "tar": "^7.5.22",
  "brace-expansion@1": "^1.1.20",
  "brace-expansion@2": "^2.1.6",
  "adm-zip": "^0.6.1",
  "jpeg-js": "^0.4.4",
  "ws": "^8.21.3",
  "postcss": "^8.5.18",
  "@intlify/core-base": "9.1.11",
  "@intlify/message-resolver": "9.1.11",
  "vite": "5.4.21"
}
```
⚠️ 选择子形态（`brace-expansion@1`）以实现期实测为准：若 pnpm 9.15 不认此写法 ⇒ 用 `"brace-expansion@<2": "…"` / `"brace-expansion@>=2": "…"`（二选一，以 install 成功 + Step 4 矩阵为准）。

- [ ] **Step 3: 删陈旧嵌套锁 + 重建 lockfile**

```bash
git rm packages/robot-service/pnpm-lock.yaml packages/room-service/pnpm-lock.yaml
pnpm install   # 允许 lockfile 更新；观察 vite-plugin-uni 的 peer warning（预期存在、非失败）
```

- [ ] **Step 4: `pnpm why` 矩阵核验**（逐条，期望值为**下界**；实解更新也可，但不得低于）

```bash
pnpm why tar              # 期望：全部 ≥ 7.5.22（7.5.22 唯一）
pnpm why axios            # 期望：≥ 1.16.0（实解预期 1.20.0）
pnpm why @nestjs/platform-express  # 期望：≥ 11.2.6（携 multer ≥ 2.4.0；解析 < 11.2.6 ⇒ 停下报）
pnpm why multer           # 期望：无 < 2.4.0 的拷贝
pnpm why brace-expansion  # 期望：1.x 线 ≥1.1.20 且 2.x 线 ≥2.1.6（无 1.1.18 / 2.1.4 残留）
pnpm why lodash           # 期望：无 ≤4.17.23 的拷贝
pnpm why adm-zip          # 期望：≥ 0.6.1
pnpm why jpeg-js          # 期望：≥ 0.4.4
pnpm why ws               # 期望：≥ 8.21.3
pnpm why postcss          # 期望：≥ 8.5.18
pnpm why @intlify/core-base  # 期望：9.1.11
pnpm why vite             # 期望：5.4.21（唯一）
pnpm why sqlite3          # 期望：6.0.1
pnpm why @nestjs/microservices  # 期望：≥ 11.2.6
pnpm why @nestjs/config   # 期望：12.0.1
# 其余 @nestjs/*（common/core/microservices/testing/cli/jwt/passport/typeorm/websockets/platform-socket.io）
#   逐包按 §2.6 目标核 ≥（`pnpm why <pkg>`）
```

- [ ] **Step 5: 门脚本转绿 + 豁免生效自证**

```bash
node scripts/security/check-audit.mjs                          # 期望：EXIT 0（✅ …未处理 0 条（豁免 1 条））
pnpm audit --prod --audit-level high --registry https://registry.npmjs.org   # 期望：EXIT 1（= 豁免生效的自证：裸口仍红）
pnpm install --frozen-lockfile                                 # 证明重建后的 lockfile 与 manifests 自洽（CI 形态——R6-🟡8）
```

- [ ] **Step 6: 六阶段 + 客户端单测**

```bash
pnpm run ci                                             # 六阶段全绿（含阶段 3 的 uni build——uni 工具链 overrides 的兼容性检验）
pnpm --filter @fight-the-landlord/client test           # 客户端单测全绿
```

- [ ] **Step 7: Commit**

```bash
git add package.json packages/*/package.json apps/client/package.json pnpm-lock.yaml
git commit -m "chore(deps): Nest 10→11 全家族 + 安全修复 overrides + sqlite3 6 + vite 5.4.21；删陈旧嵌套锁（M0.1 T2）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 规则文件 + gitleaks 本地 A/B 自证（C32）

**Files:**
- Create: `.gitleaks.toml`
- Create: `.trivyignore`

**Interfaces:**
- Produces: 两个文件（T4 的步骤引用其文件名；T5 的 C6③/C7 断言其内容）。

- [ ] **Step 1: 写 `.gitleaks.toml`**（逐字——C6③ 按「剥 `#` 注释后」断言；注释里**不得**出现禁用键字面量）

```toml
# 本仓的 gitleaks 配置（全历史扫描；见 docs/superpowers/specs/2026-10-02-security-scan-*）。
# 允许项只许是「保留字面量」型豁免（测试夹具 / 文档示例），不许是「修不了」型；每条必须带理由。
# ⛔ 禁用键四类（名单见规格 C6 判据行——本文件不得出现其字面量）。
[extend]
useDefault = true

[[allowlists]]
description = "日志脱敏用例的测试夹具 JWT（redact.test.ts:53 构造的样本，非真密钥、无泄露面）"
paths = ['''packages/shared/src/logging/redact\.test\.ts$''']

[[allowlists]]
description = "dev 内部占位 token 字面量（生产 compose 无默认值 ${INTERNAL_SERVICE_TOKEN:-}；文档 curl 示例必须保留该字面量）"
regexTarget = "match"
regexes = ['''dev-internal-token-change-in-production''']
```

- [ ] **Step 2: 写 `.trivyignore`**（政策头；首跑读数处置前先只有注释）

```
# trivy config 豁免登记（M0.1）。依据：docs/superpowers/specs/2026-10-02-security-scan-design.md D4。
# 规则：逐 ID 一行；每条的上一行必须是 # 理由行；不许通配、不许 exp: 形态。
# 首跑读数处置后在此逐条登记（能修则修优先）。
```

- [ ] **Step 3: 本地 A/B 自证（C32）**——钉版 windows 二进制 + 允许项 ② 的拆卸重跑

```bash
cd .superpowers/sdd/2026-10-02-security-scan
gh release download v8.30.1 -R gitleaks/gitleaks -p "gitleaks_8.30.1_windows_x64.zip" -O gitleaks-win.zip --clobber
grep "windows_x64" gitleaks-checksums.txt   # 取该行 sha256，校验 zip（sha256sum -c 或 certutil）
unzip -o gitleaks-win.zip -d gitleaks-win
cd ../.. && .superpowers/sdd/2026-10-02-security-scan/gitleaks-win/gitleaks.exe detect --source . --config .gitleaks.toml --redact --no-banner -v --exit-code 1
# 期望：0 findings（3 条存量全被允许项覆盖）⇒ EXIT 0；产物存档 SDD
# 负对照：临时把允许项 ② **整块注释**（⚠️ 只注释 regexes 行在钉版上**不可执行**——allowlist 校验要求至少一个 check，实测 FTL；整块注释为语义等价形态，见 c32-negative-literal-form-config-fatal.txt）⇒ 必须重新报出那 2 条（curl-auth-header）⇒ 装回 ⇒ 0
# ⚠️ A/B 的两次输出都存 SDD（c32-allowlist-ab-*.txt）——这就是 C32 的留档
```

- [ ] **Step 4: Commit**

```bash
git add .gitleaks.toml .trivyignore
git commit -m "feat(security): gitleaks 允许清单（两条带理由）+ trivy 豁免登记点（M0.1 T3）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `ci.yml` · `security-scan` job

**Files:**
- Modify: `.github/workflows/ci.yml`（**追加**第三个 job；现有 `ci`/`render-gate` 与文件头注释**不动**）

**Interfaces:**
- Consumes: T1 脚本调用形态 · T3 两个清单文件名。
- Produces: 断言面（T5 的 C1–C25 对着它判）。

- [ ] **Step 1: 追加 job**（逐字；⚠️ `run:` 体禁 `${{ }}`、禁 `|| true`/`; exit 0`/`set +e`；gitleaks 命令行的旗标集合是 C6① 的白名单面）

```yaml
  # ⚠️ M0.1：第三个 job —— 三路安全扫描（依赖漏洞 / 密钥泄露 / 配置误配），与上面两个 job **并行**。
  #    与 `render-gate` 同理由不进六阶段：六阶段真源在 `scripts/ci.sh`，安全扫描不是规格里那张表的一部分。
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # gitleaks 全历史的地基（浅检出 = 静默只扫 1 commit）
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20      # ⚠️ 不加 cache: pnpm——本 job 不跑 install、无 store 可缓（修复轮订正：带缓存会在 post-step 保存失败把 job 判红）
      - name: 依赖漏洞（门脚本）
        run: node scripts/security/check-audit.mjs
      - name: 门脚本行为自证
        run: node scripts/security/check-audit.mjs --self-test
      - name: 密钥泄露（gitleaks 全历史）
        run: |
          curl -fsSLo /tmp/gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
          echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  /tmp/gitleaks.tar.gz" | sha256sum -c -
          tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks
          /tmp/gitleaks detect --source . --config .gitleaks.toml --redact --no-banner -v --exit-code 1
      - name: 配置误配（trivy config）
        run: |
          curl -fsSLo /tmp/trivy.tar.gz https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz
          echo "c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f  /tmp/trivy.tar.gz" | sha256sum -c -
          tar -xzf /tmp/trivy.tar.gz -C /tmp trivy
          /tmp/trivy config --severity HIGH,CRITICAL --exit-code 1 --ignorefile .trivyignore .
```

- [ ] **Step 2: 本地 YAML 自检**（不真跑 actions；`js-yaml` 从 `tools/conformance` 侧解析——R6-🟡5 修正形态）

```bash
(cd tools/conformance && node --input-type=module -e "
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
const ci = load(readFileSync('../../.github/workflows/ci.yml', 'utf8'));
const j = ci.jobs['security-scan'];
if (!j) throw new Error('security-scan job 缺失');
if (j['continue-on-error']) throw new Error('job 级 continue-on-error 出现');
const co = j.steps.find((s) => s.with && 'fetch-depth' in s.with);
if (!(co && co.with['fetch-depth'] === 0)) throw new Error('fetch-depth: 0 缺失');
const runs = j.steps.filter((s) => s.run).map((s) => s.run);
console.log('✅ security-scan job 形状 OK：steps=' + j.steps.length + ' runBodies=' + runs.length);
")
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(security): ci.yml 第三 job security-scan（三扫描器 · 钉版+sha256 · M0.1 T4）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: conformance 扩展（谓词族 + C1–C25）

**Files:**
- Modify: `tools/conformance/src/slices/slice-07.4-pipeline.ts`（**追加**新谓词族 + 新 step；既有断言不动；**导入行**须把 `import { readFileSync, readdirSync } from 'node:fs';` 增补为 `…, existsSync }`——Step 4 用到）

**Interfaces:**
- Consumes: T1 脚本文本 · T3 两个规则文件 · T4 ci.yml job · root package.json。
- Produces: `securityJobViolations(input): string[]` 与逐项谓词（真断言与合成对照**共用**）。

- [ ] **Step 1: 写谓词族**（追加到 `slice-07.4-pipeline.ts` 末尾、`runSlice074Pipeline` 之前；`node:fs`/`node:path` 已在文件头导入，`load` 已导入）

```ts
// ── M0.1：安全扫描接线判据（C1–C25；真断言与合成对照共用一族谓词）────────────────
// ⚠️ 合成夹具内的字面量一律**运行时拼接**（C6⑤ 会全仓扫这些字面量；源码不得落连续字面量）。
// C6⑤ 的跳列在调用点（Step 4）给出：node_modules / .git / .superpowers / .worktrees / test-results /
// dist / .pnpm-store / tools/conformance / docs/superpowers（**前缀判定**——不跳整个 docs）。
// ⚠️ 跳列按「相对路径前缀」判定：顶层命中即跳；嵌套 dist（如 packages/protocol/dist）仍会被扫——现语义，登记（R6 观测项）。

/** 有界遍历：收集文本文件全文（相对路径 → 内容）。 */
export function collectTexts(root: string, skipPrefixes: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    if (skipPrefixes.some((p) => rel === p || rel.startsWith(p + '/'))) return;
    const abs = join(root, rel);
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const child = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) { walk(child); continue; }
      try {
        const buf = readFileSync(join(root, child));
        if (buf.includes(0)) continue;                       // 二进制跳过
        out.set(child, buf.toString('utf8'));
      } catch { /* 读不了就跳过（无判据价值） */ }
    }
  };
  walk('');
  return out;
}

/** 剥 shell 注释：丢弃「行首（trim 后）为 #」的行（成例纪律：提到 ≠ 执行）。 */
export function stripHashLines(text: string): string {
  return text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
}

/** 剥 JS 行注释：仅字符串外起剥（简化状态机——模板串按普通串处理）。 */
export function stripJsComments(text: string): string {
  let out = '';
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out;
}

/** 逻辑行（续行拼接；成例 logicalLines）。 */
export function joinContinuations(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.endsWith('\\')) out[out.length - 1] = `${prev.slice(0, -1)} ${raw}`;
    else out.push(raw);
  }
  return out;
}

/** C6①：取「以 gitleaks 起的命令行」的 tokens（作用域 = 该逻辑行）。 */
export function gitleaksCommandTokens(runBody: string): string[] | null {
  for (const line of joinContinuations(runBody)) {
    const toks = line.trim().split(/\s+/).filter((t) => t !== '');
    if (toks.length === 0) continue;
    if (/(^|\/)gitleaks(\.exe)?$/.test(toks[0]) && toks.includes('detect')) return toks;
  }
  return null;
}

/** C6① 旗标白名单（含值钉子）。返回违例。 */
export function gitleaksFlagViolations(tokens: string[]): string[] {
  const v: string[] = [];
  const ALLOWED = new Set(['--source', '--config', '--redact', '--no-banner', '-v', '--exit-code']);
  const count = (f: string): number => tokens.filter((t) => t === f).length;
  const valueOf = (f: string): string | undefined => { const i = tokens.indexOf(f); return i >= 0 ? tokens[i + 1] : undefined; };
  const offending = tokens.filter((t, i) => i > 0 && t.startsWith('-') && !ALLOWED.has(t));
  if (offending.length > 0) v.push(`gitleaks 命令行出现白名单外旗标：${JSON.stringify(offending)}`);
  if (count('--config') !== 1 || valueOf('--config') !== '.gitleaks.toml') v.push('--config 必须恰好一次且值 = .gitleaks.toml');
  if (count('--exit-code') !== 1 || valueOf('--exit-code') !== '1') v.push('--exit-code 必须恰好一次且值 = 1');
  if (count('--redact') !== 1) v.push('--redact 必须恰好一次');
  if (count('--source') !== 1 || valueOf('--source') !== '.') v.push('--source 必须恰好一次且值 = .');
  return v;
}

/** C3：从门脚本文本提取 spawn 数组实参的 tokens / LEVELS 值（先剥 JS 注释）。 */
export function auditScriptTokens(scriptText: string): { spawnArgs: string[] | null; levels: string[] | null; hasExceptionsPath: boolean } {
  const code = stripJsComments(scriptText);
  const spawn = /spawnSync\([^,]+,\s*\[([^\]]*)\]/.exec(code);
  const spawnArgs = spawn ? [...spawn[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : null;
  const lv = /const LEVELS = \[([^\]]*)\]/.exec(code);
  const levels = lv ? [...lv[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : null;
  return { spawnArgs, levels, hasExceptionsPath: scriptText.includes('scripts/security/audit-exceptions.json') };
}

/** C2：四模式各取首个命中的步骤下标。 */
export function securityStepIndexes(steps: ReadonlyArray<{ run?: unknown; [k: string]: unknown }>): { idx: number[]; firsts: Array<number | -1> } {
  const bodies = steps.map((st) => (typeof st?.run === 'string' ? stripHashLines(st.run) : ''));
  const pats = [/node scripts\/security\/check-audit\.mjs(?!\s*--self-test)/, /node scripts\/security\/check-audit\.mjs\s+--self-test/, /gitleaks\s+detect/, /trivy\s+config/];
  const firsts = pats.map((re) => bodies.findIndex((b) => re.test(b)));
  return { idx: bodies.map((_, i) => i), firsts };
}
```

- [ ] **Step 2: 写 `securityJobViolations` 主谓词**（在上一段后追加；返回违例清单，真/合成共用）

```ts
export interface SecurityInputs {
  ciYaml: string;                    // ci.yml 文本（合成时喂构造文本）
  scriptText: string;                // 门脚本文本
  gitleaksToml: string;              // .gitleaks.toml 文本
  trivyignore: string;               // .trivyignore 文本
  exceptionsJson: string;            // audit-exceptions.json 文本
  rootPkgJson: string;               // root package.json 文本
  gitleaksignoreExists: boolean;     // 仓库根 .gitleaksignore 是否存在
  textFiles: Map<string, string>;    // C6⑤ 的全仓文本面（合成时给构造 Map）
}

const ALLOWLIST_KEYS = ['disabledRules', 'rules.disabled', 'rules.allowlists', 'disableRuleIDs'];

export function securityJobViolations(inp: SecurityInputs): string[] {
  const v: string[] = [];
  const ci = load(inp.ciYaml) as any;
  const job = ci?.jobs?.['security-scan'];
  if (!job) return ['ci.yml 缺 job security-scan（C1）'];
  // C5：job 级 continue-on-error + 步骤级禁令
  if (job['continue-on-error'] === true) v.push('security-scan 不得带 job 级 continue-on-error（C5）');
  const steps = (job.steps ?? []) as Array<{ run?: unknown; if?: unknown; 'continue-on-error'?: unknown }>;
  for (const [i, st] of steps.entries()) {
    if (st['continue-on-error'] === true) v.push(`第 ${i + 1} 步不得带 continue-on-error（C5）`);
    const body = typeof st.run === 'string' ? st.run : '';
    for (const pat of [/\|\|\s*true/, /;\s*exit\s+0\b/, /\bset\s+\+e\b/]) {
      if (pat.test(body)) v.push(`第 ${i + 1} 步 run 体含旁路形态 ${pat}（C5）`);
    }
  }
  // C2：四步按序（首个命中 + 严格递增）
  const { firsts } = securityStepIndexes(steps);
  if (firsts.some((x) => x < 0)) v.push(`四步识别缺项：${JSON.stringify(firsts)}（C2）`);
  else if (!(firsts[0] < firsts[1] && firsts[1] < firsts[2] && firsts[2] < firsts[3])) v.push(`四步未严格递增：${JSON.stringify(firsts)}（C2）`);
  // C8：fetch-depth: 0
  if (!/fetch-depth:\s*0\b/.test(inp.ciYaml)) v.push('checkout 缺 fetch-depth: 0（C8）');
  // C3：门脚本执行语句提取
  const at = auditScriptTokens(inp.scriptText);
  const wantArgs = ['audit', '--prod', '--json', '--registry', 'https://registry.npmjs.org'];
  if (at.spawnArgs === null || JSON.stringify(at.spawnArgs) !== JSON.stringify(wantArgs)) v.push(`spawn 数组实参 token 不恰好：${JSON.stringify(at.spawnArgs)}（C3①）`);
  if (JSON.stringify(at.levels) !== JSON.stringify(['critical', 'high'])) v.push(`LEVELS 不恰好：${JSON.stringify(at.levels)}（C3②）`);
  if (stripJsComments(inp.scriptText).includes('--ignore-registry-errors')) v.push('脚本出现禁旗标（C3③）');
  if (!at.hasExceptionsPath) v.push('脚本未引用 audit-exceptions.json 路径（C3④）');
  // C4：豁免文件
  let exemptions: any[] = [];
  try { exemptions = JSON.parse(inp.exceptionsJson); } catch { v.push('豁免文件不是合法 JSON（C4）'); }
  const wantEx = [{ id: 1123525, module: 'vite' }];
  if (exemptions.length !== 1 || exemptions.some((e) => typeof e.id !== 'number' || !e.module || !e.reason || !e.reviewTrigger)) {
    v.push('豁免条目必须恰 1 条且四字段非空、id 为 number（C4）');
  }
  if (JSON.stringify(exemptions.map((e) => ({ id: e.id, module: e.module }))) !== JSON.stringify(wantEx)) {
    v.push(`豁免 (id,module) 集合不恰好：${JSON.stringify(exemptions.map((e) => [e.id, e.module]))}（C4）`);
  }
  // C6：gitleaks 封禁组
  const gStep = steps.find((st) => typeof st.run === 'string' && /gitleaks/.test(st.run));
  if (!gStep) v.push('找不到 gitleaks 步骤（C6）');
  else {
    const toks = gitleaksCommandTokens(String(gStep.run));
    if (toks === null) v.push('取不到 gitleaks 命令行（C6①）');
    else v.push(...gitleaksFlagViolations(toks).map((x) => x + '（C6①/②）'));
  }
  const tomlCode = stripHashLines(inp.gitleaksToml);
  if (!/useDefault\s*=\s*true/.test(tomlCode)) v.push('.gitleaks.toml 缺 useDefault = true（C6③）');
  const topAllow = (tomlCode.match(/^\s*\[\[allowlists\]\]/gm) ?? []).length;
  if (topAllow !== 2) v.push(`[[allowlists]] 行首计数 = ${topAllow}（须恰好 2；C6③）`);
  if (!tomlCode.includes("'''packages/shared/src/logging/redact\\.test\\.ts$'''")) v.push('path 条目 ≠ 带 $ 锚定的登记字面量（C6③）');
  if (!tomlCode.includes("'''dev-internal-token-change-in-production'''")) v.push('regex 条目 ≠ 登记字面量（C6③）');
  for (const k of ALLOWLIST_KEYS) if (tomlCode.includes(k)) v.push(`.gitleaks.toml 禁键 ${k} 出现（C6③）`);
  if (inp.gitleaksignoreExists) v.push('仓库根 .gitleaksignore 不得存在（C6④）');
  const marker = 'gitleaks' + ':' + 'allow';   // ⚠️ 运行时拼接（C6⑤ 的残面约定）
  const hits = [...inp.textFiles.entries()].filter(([, t]) => t.includes(marker)).map(([p]) => p);
  if (hits.length > 0) v.push(`全仓出现行内注释放行字面量：${JSON.stringify(hits.slice(0, 5))}（C6⑤）`);
  // C7：trivy
  const tStep = steps.find((st) => typeof st.run === 'string' && /trivy\s+config/.test(st.run));
  if (!tStep) v.push('找不到 trivy 步骤（C7）');
  else {
    const body = String(tStep.run); // 注意：该断言用「含」形态 —— 值均在骨架字面量中
    for (const need of ['--exit-code 1', '--ignorefile .trivyignore', '--severity HIGH,CRITICAL']) {
      if (!body.includes(need)) v.push(`trivy 步缺 ${need}（C7）`);
    }
  }
  const FAMILY = /^(CVE-[0-9]{4}-[0-9]{4,}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|AVD-DS-[0-9]{4})$/;
  const tLines = inp.trivyignore.split('\n').map((l) => l.trimEnd());
  for (let i = 0; i < tLines.length; i++) {
    const l = tLines[i];
    if (l === '' || l.startsWith('#')) continue;
    if (/[*]/.test(l) || /\bexp:/.test(l)) v.push(`.trivyignore 第 ${i + 1} 行含禁形态：${l}（C7）`);
    else if (!FAMILY.test(l)) v.push(`.trivyignore 第 ${i + 1} 行 ID 不在族白名单：${l}（C7）`);
    if (i === 0 || !tLines[i - 1].startsWith('#')) v.push(`.trivyignore 第 ${i + 1} 行缺上一行 # 理由行（C7）`);
  }
  // C9：self-test 步（C2 已覆盖识别，这里显式点名步骤文本）
  if (!steps.some((st) => typeof st.run === 'string' && /check-audit\.mjs\s+--self-test/.test(st.run))) v.push('缺 self-test 步（C9）');
  // C10：root package.json 键禁令（任意嵌套）
  const pkgCode = stripJsComments(inp.rootPkgJson);
  for (const k of ['auditConfig', 'ignoreCves', 'ignoreGhsas']) if (pkgCode.includes(k)) v.push(`root package.json 出现禁键 ${k}（C10）`);
  return v;
}
```

- [ ] **Step 3: 决策与说明**（写进 `slice-07.4-pipeline.ts` 的注释——实现先记下三条取舍）

```
（a）若扫描器步骤识别在真文件上因多行 YAML 折行假红/假绿，可把识别放宽为「逻辑行拼接后」——但必须保持
     C22（正对照）与 C2 的正/负两向；放宽须在注释登记「合法替代形态」，与 tagComposeFetchViolations 同法。
（b）tokens 提取正则假设脚本文本以单引号写数组与 LEVELS——真文件即以骨架为准（写脚本时保持单引号）。
（c）C6① 的「作用域行」在真文件里是含 `/tmp/gitleaks` 的那一行（joinContinuations 已把 `curl` 等行排除在外，
    因为它们不含 `gitleaks detect` 的词元对——若未来把 detect 写进 curl 行 ⇒ 定位会偏，届时按 (a) 登记后修）。
```

- [ ] **Step 4: 写新 step 与真断言（C1–C10）+ 合成对照（C11–C25）**

```ts
  // ── M0.1：安全扫描接线（C1–C25）───────────────────────────────────────────
  step('M0.1 安全扫描：接线断言（C1–C10）');
  const seRoot = REPO_ROOT;
  const seInputsReal: SecurityInputs = {
    ciYaml: readFileSync(join(WF_DIR, 'ci.yml'), 'utf8'),
    scriptText: readFileSync(join(seRoot, 'scripts/security/check-audit.mjs'), 'utf8'),
    gitleaksToml: readFileSync(join(seRoot, '.gitleaks.toml'), 'utf8'),
    trivyignore: readFileSync(join(seRoot, '.trivyignore'), 'utf8'),
    exceptionsJson: readFileSync(join(seRoot, 'scripts/security/audit-exceptions.json'), 'utf8'),
    rootPkgJson: readFileSync(join(seRoot, 'package.json'), 'utf8'),
    gitleaksignoreExists: existsSync(join(seRoot, '.gitleaksignore')),
    textFiles: collectTexts(seRoot, ['node_modules', '.git', '.superpowers', '.worktrees', 'test-results', 'dist', '.pnpm-store', 'tools/conformance', 'docs/superpowers']),
  };
  const seReal = securityJobViolations(seInputsReal);
  checks.that(seReal.length === 0, `M0.1 接线断言 C1–C10 全过 —— 违例：${JSON.stringify(seReal)}`);
  checks.that(seInputsReal.textFiles.size > 500, `C6⑤ 全仓文本面必须真的扫到东西（实际 ${seInputsReal.textFiles.size} 个文件）`);

  // 合成对照（C11–C25）：每条 = 一条具体改写，喂同一谓词 ⇒ 必须红（C25 = 正对照 ⇒ 必须判齐）
  const mut = (f: (s: SecurityInputs) => void): SecurityInputs => { const c = structuredClone(seInputsReal); f(c); return c; };
  const red = (name: string, f: (s: SecurityInputs) => void): void => {
    checks.that(securityJobViolations(mut(f)).length > 0, `负对照 ${name} ⇒ 必须红`);
  };
  red('C11 裸命令（删门脚本调用）', (s) => { s.ciYaml = s.ciYaml.replace('node scripts/security/check-audit.mjs\n', 'pnpm audit --prod\n'); });
  red('C12 等级集合缩水', (s) => { s.scriptText = s.scriptText.replace("const LEVELS = ['critical', 'high'];\n", "const LEVELS = ['critical'];\n"); }); // ⚠️ 串含 `const LEVELS = ` 前缀——防首命中落进头部注释（R6-🟠1 实测修正）
  red('C13 禁旗标出现', (s) => { s.scriptText = s.scriptText.replace("\nconst LEVELS", "\nconst X = '--ignore-registry-errors';\nconst LEVELS"); }); // ⚠️ 前导换行同因（R6-🟠2 实测修正）
  red('C14 continue-on-error（步骤级）', (s) => { s.ciYaml = s.ciYaml.replace('      - name: 依赖漏洞（门脚本）', '      - name: 依赖漏洞（门脚本）\n        continue-on-error: true'); });
  red('C14b continue-on-error（job 级）', (s) => { s.ciYaml = s.ciYaml.replace('  security-scan:\n', '  security-scan:\n    continue-on-error: true\n'); });
  red('C15 || true 旁路', (s) => { s.ciYaml = s.ciYaml.replace('run: node scripts/security/check-audit.mjs\n', 'run: node scripts/security/check-audit.mjs || true\n'); });
  red('C16 gitleaks 缺 --config', (s) => { s.ciYaml = s.ciYaml.replace('--config .gitleaks.toml ', ''); });
  red('C17 允许项放宽（path 整目录 / regex .*）', (s) => { s.gitleaksToml = s.gitleaksToml.replace("redact\\.test\\.ts$", "redact"); });
  red('C18 豁免多一条未登记', (s) => { s.exceptionsJson = JSON.stringify([...JSON.parse(s.exceptionsJson), { id: 1, module: 'x', reason: 'r', reviewTrigger: 't' }]); });
  red('C19 删 fetch-depth', (s) => { s.ciYaml = s.ciYaml.replace('fetch-depth: 0', 'fetch-depth: 1'); });
  red('C20 auditConfig.ignoreCves', (s) => { s.rootPkgJson = s.rootPkgJson.replace('"pnpm":', '"pnpm": { "auditConfig": { "ignoreCves": ["X"] } },'); });
  red('C21 trivy severity 缩水', (s) => { s.ciYaml = s.ciYaml.replace('--severity HIGH,CRITICAL', '--severity LOW'); });
  red('C22 gitleaks 加 --baseline-path', (s) => { s.ciYaml = s.ciYaml.replace('--redact', '--redact --baseline-path /tmp/b.json'); });
  red('C23 配置加禁用键', (s) => { s.gitleaksToml = s.gitleaksToml + '\n[extend.extra]\ndisabledRules = ["x"]\n'; });
  red('C24 .gitleaksignore 存在 / 行内放行', (s) => { s.gitleaksignoreExists = true; });
  checks.that(
    securityJobViolations(mut((s) => { s.gitleaksignoreExists = false; })).length === 0 &&
      securityJobViolations(mut((s) => { s.textFiles = new Map([...s.textFiles, ['x.md', 'gitleaks' + ':' + 'allow']]); })).length > 0,
    '负对照 C24b 行内放行字面量（运行时拼接喂入）⇒ 必须红；合成 Map 移除后 ⇒ 判齐',
  );
  checks.that(securityJobViolations(mut(() => {})).length === 0, '正对照 C25 真文件形态（修毕）⇒ 判齐（防谓词恒红）');
```

（⚠️ 以上 C11–C24 的 replace 目标串必须与 T4 落盘后的真实文本**逐字对齐**——实现时先跑一次，把不命中的 replace 修正为真实子串；每条 `red(...)` 的断言消息即其证据。）

- [ ] **Step 5: 本地全绿**

```bash
pnpm exec turbo run build --filter=@fight-the-landlord/conformance...
node tools/conformance/dist/run.js slice-07.4-pipeline --render
# 期望：✅ 通过 ≈75（56 + 19；A 组聚合为 4 条 + red()×15——R6 实测口径；以 CI 实测为准）
# 任何红 ⇒ 按消息定位（多为 replace 目标未对齐——⚠️ 注意「命中错位置」形态：串在注释里也「命中」）
```

- [ ] **Step 6: Commit**

```bash
git add tools/conformance/src/slices/slice-07.4-pipeline.ts
git commit -m "test(conformance): slice-07.4 安全扫描接线判据 C1–C25（谓词族 + 合成对照，M0.1 T5）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 文档修订面（F1/F2）

**Files:**
- Modify: `docs/design.md`（`:1656` 一带，render-gate 段落**之后**追加；先读 `:1646-1670` 确认上下文）
- Modify: `docs/ops/first-deploy.md`（`:688` 与 `:723-724`；先读 `:678-735` 确认逐字文本）

**Interfaces:**
- Consumes: T4 的 job 名与步骤数。
- Produces: 与真实形态一致的手册/设计文（片②血训：手册的「预期输出」是判据的一部分）。

- [ ] **Step 0: 先扫面**（片②纪律：改前先全仓 grep；R6 已代跑，结论登记在此）

```bash
grep -rn "render-gate" docs/   # 期望命中 4 行：design.md:1656/1658、first-deploy.md:688/723
# —— 全部落在本任务两文件内；:1658 的「render-gate 不受影响」句不受新增 job 影响、仍准确
```

- [ ] **Step 1: `docs/design.md` 追加**（在 render-gate 段后另起一段）

```markdown
`ci.yml` 另有第三个 job **`security-scan`**（M0.1，每次 push 与 PR 跑）：三路全阻断——依赖漏洞（`scripts/security/check-audit.mjs`，`pnpm audit --prod` 的 critical/high 必须清零，唯一条机器可读豁免 = `scripts/security/audit-exceptions.json` 的 vite/1123525）· 密钥泄露（gitleaks v8.30.1 钉版全历史）· 配置误配（trivy v0.75.0 钉版 config）。它与 `render-gate` 同理由**不进六阶段**（六阶段真源在 `scripts/ci.sh`）。判据 = `slice-07.4-pipeline` 的 C1–C25。
```

- [ ] **Step 2: `docs/ops/first-deploy.md` 改 job 枚举**（按现文逐字替换；示例 = R1 引用的 :723-724 原文，实现时以实际读到的文本为准）

```
:723 「feature 分支上 push ⇒ 只跑 `ci`（六阶段）+ `render-gate`（纯渲染判据）。」
  →「feature 分支上 push ⇒ 只跑 `ci`（六阶段）+ `render-gate`（纯渲染判据）+ `security-scan`（三路安全扫描）。」
:724 「push 到 `master` ⇒ 额外跑 `images` 与 `conformance`」——措辞不变（仍准确）
:688 「预期：push `master` 那一次 ⇒ `ci`、`render-gate`、`images` 绿」
  → 预期清单补 `security-scan`（与 `ci`/`render-gate` 并列）
```

- [ ] **Step 3: Commit**

```bash
git add docs/design.md docs/ops/first-deploy.md
git commit -m "docs(security): design.md 登记 security-scan job + 手册 job 枚举同改（M0.1 T6）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 全量验收与收口

**Files:**
- Modify: `tools/conformance/baselines.json`（CI 实测回填）
- Modify: `docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md`（M0.1 状态 + vite 豁免复查触发）
- SDD 报告（不入库）

- [ ] **Step 1: 本地全量**（六阶段 + client 单测 + 全序 conformance——真栈起来跑一次）

```bash
pnpm run ci                                   # 六阶段全绿
pnpm --filter @fight-the-landlord/client test # 客户端单测
docker compose up -d --build                  # 真栈（按既有脚本/流程）
node tools/conformance/dist/run.js --list     # 全序（切片逐个跑；或既有全序入口）
```

- [ ] **Step 2: 三扫描器收口读数（存档 SDD）**

```bash
node scripts/security/check-audit.mjs                       # EXIT 0
pnpm audit --prod --audit-level high --registry https://registry.npmjs.org   # EXIT 1（豁免自证）
.superpowers/sdd/2026-10-02-security-scan/gitleaks-win/gitleaks.exe detect --source . --config .gitleaks.toml --redact --no-banner -v --exit-code 1   # 0 findings
# trivy：本机连不上检验束 ⇒ 读数从 CI 首跑取（见 Step 4）
# §4-6 静默通道探针（R6-🟠4）：
pnpm config list > .superpowers/sdd/2026-10-02-security-scan/pnpm-config.txt 2>&1
#   检 .npmrc / NPM_CONFIG_* 面有无等价 ignoreCves 类静音通道；找不到 ⇒ 报告登记「已核（无）」；找到 ⇒ 停报清单 ④
# §4-7 耗时登记：记 C6⑤ 全仓遍历耗时（本机热身实测 ≈8.6s——R6 读数）
```

- [ ] **Step 3: push 分支 → CI 首跑读数**

```bash
git push -u origin feat/security-scan
gh run list --branch feat/security-scan --limit 5
gh run view <run-id> --log   # 取 security-scan job 的三步读数：audit ✅ / gitleaks 全量读数 / trivy 读数
```

- [ ] **Step 4: trivy 首跑读数处置（规格 §4-5 / D4 规则）**

```
读数全空 ⇒ .trivyignore 保持只有头注释；提交（如无变化则跳过）
读数有「能修」项 ⇒ 根 Dockerfile.* / douzero/Dockerfile 微调（超一页 ⇒ 停报）
读数有「确需豁免」项 ⇒ .trivyignore 逐 ID 一行 + 上一行 # 理由行（同时核 C7 族白名单命中）
读数全空 ⇒ 仍须证明 `--exit-code 1` 会红（C33 空读数分支，R6-🟠3）：临时目录（不入库）合成 Dockerfile
  （如 `FROM alpine:3.19` 且无 USER ⇒ DS002 类 HIGH）⇒ 钉版 `trivy config --severity HIGH,CRITICAL
  --exit-code 1 --ignorefile .trivyignore <临时目录>` 跑红；移除后再跑 ⇒ 绿；两次输出存 SDD（c33-demo-*.txt）
```

- [ ] **Step 5: baselines 回填（按 CI 实测，不许本机读数）**

```
从 CI 日志取 slice-07.4-pipeline 的 render 侧读数（render-gate 日志的 ✅ 行）⇒ 回填 render 列
  （预期 ≈75 = 56 + 19——实现形态聚合后；以 CI 实测为准，见 T5 S5）
full 列在 tag/master 的真栈 conformance 读数出来后回填（或按既有做法同批）
```

- [ ] **Step 6: 收口提交（roadmap 状态 + baselines）**

```bash
git add tools/conformance/baselines.json docs/superpowers/plans/2026-10-02-post-mvp-roadmap.md
git commit -m "docs(security-scan): M0.1 收口 —— baselines 按 CI 实测回填 + 路线图状态与 vite 豁免复查触发（M0.1 T7）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: 合并 master + 终态 CI**

```bash
git checkout master && git merge --ff-only feat/security-scan && git push origin master
gh run list --limit 5    # ci / conformance / images 三 workflow 全绿
git branch -d feat/security-scan
```

---

## 自审记录（写计划时自查）

- **规格覆盖**：§1 的 19 行 → T1（A1/A2）· T2（C1–C6/D1/D2）· T3（A3/A4）· T4（B1）· T5（E1）· T6（F1/F2）· T7（E2/F3/G1 条件行）；§3 的 C1–C33 → 对照表已列；§4 的 7 项自证 → T1/T3/T5/T7 分配完毕。
- **占位符扫描**：无 TBD；两处「实现期实测为准」= 规格明定的受控口径（overrides 选择子形态 / replace 目标串对齐），均带替代方案。
- **类型一致**：`securityStepIndexes` 在 C2 与 C9 共用；`SecurityInputs` 字段名与 Step 4 的用例一致；`stripHashLines`/`stripJsComments` 分别只用于各自语言面。

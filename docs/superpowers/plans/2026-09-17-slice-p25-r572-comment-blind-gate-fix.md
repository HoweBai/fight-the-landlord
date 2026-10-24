# 切片 P25 Implementation Plan：R572 —— §12 源码闸「对注释盲」的收口（剥注释单一实现 + 判据不弱化证明）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `apps/client/test/source-boundary.test.ts` 的**全部 7 条源码扫描**在**剥掉注释后**的文本上判定，
把 `stripComments` 收敛成**全仓（客户端）唯一一份**，并用**机械不变量**证明这一次改动**只让闸更严、不可能更松**（R435）。

**Architecture:** 三层，自下而上：① 把 `stripComments` 落到既有的共享扫描器 `apps/client/test/helpers/source-scan.ts`，
并给它**自己的判别力闸**（合成样本 + 真实语料上的「新剥注释 ⊆ 旧剥注释」不变量）；② `source-boundary.test.ts`
的 7 条断言改读剥注释视图（**每条都配一条正对照**，证明真违规仍被抓）；③ 把客户端另外 **3 份逐字重复**的副本
换成同一个 import（行为按不变量可证不变）。**跨包的 5 处副本不在本片**（另立 N46；⭐ 其中 1 处是**箭头函数常量**（`const … =`），A 判据抓不到、**B₂** 抓得到 —— 见 Task 4）。

**Tech Stack:** Vitest（`pnpm --filter @fight-the-landlord/client test`）· 纯 Node `fs`/`path`（零新依赖）· 无需容器/CDP。

**Spec:**
- `docs/design.md` —— **§12.2 FORBIDDEN 清单**（F01/F02/F10/M09）· **§12.4 违规检测**（六条源码闸 + §13.4 第 6 阶段）· §0.2 标记约定
- `docs/superpowers/plans/deviation-ledger.md` —— **§3 的 R572 登记行**（本片的作业面）· §1.5（若翻出新项则追加）· §5 维护约定
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实」的 P19 第 2 条（本缺陷的**第一次**实测记录）· 「切片 P19 新增的通用教训」第 3 条
- `apps/client/test/source-boundary.test.ts` · `apps/client/test/helpers/source-scan.ts`（现状两个真源）

## Global Constraints

1. **只许让闸更严，不许更松**（R435 逐字：不得放宽 §12 的任何一条闸）。本片用**可执行的不变量**证明这一点
   （Task 1 的 `新剥注释 ⊆ 旧剥注释`），**不许**用「我检查过了」代替。
2. **不改任何生产代码**：`apps/client/src/**`、`packages/**/src/**`、`scripts/**`、`tools/**` **一律不动**。
   本片只改 `apps/client/test/**` + `docs/**`。
3. **零新依赖**（不引入 `strip-json-comments`、`comment-parser` 之类；本仓有零依赖传统）。
4. **H5/小程序/App 的运行时行为一字不改** ⇒ 不跑 conformance / docker / 真浏览器探针（它们**不读 `test/**`**），
   但**必须**跑 `pnpm run ci`（第 6 阶段就是这六条源码闸 —— 那是本片的核心判据）。
5. **计数只按形态**，命令里不得写死行号当判据（P7 教训 7）。
6. **一个真源**：`stripComments` 在 `apps/client/test/**` 下只允许有**一处实现**（Task 3 收口后由 `grep` 自证）。
7. 派子 agent 时**禁止** `git stash` / `git reset` / `git checkout <旧 commit>` / `git switch`。

---

## 绑定数值（开工前实测，本片判据的底数）

| 项 | 数值 | 命令 |
|---|---|---|
| 起点 commit | `4f0857a`（P24 收口） | `git log --oneline -1` |
| `source-boundary.test.ts` 的断言总数 | **8**（`it(`）：其中**违规类**（注释盲）**7** 条 + **存在性** 1 条（「扫描器确实读到了文件」） | `grep -c "^  it(" apps/client/test/source-boundary.test.ts` |
| `apps/client/test` 下的注释剥离实现数 | **5** —— ⚠️ **按名字数会漏**：`uni-api-access:25` · `import-meta-guard.gate:43` · `http.test:252` 三份 `stripComments(source)`，**外加 `ui-tokens.test.ts:33` 的 `stripSfcComments(source)`**（与前三份**逐字相同的全 3 规则副本**，只因为换了名字而被 `grep "function stripComments"` 整个漏掉），再加 `ui-tokens.test.ts:56` 的 `(scss: string)` 2 规则变体 | `grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test --exclude-dir=helpers \| wc -l` ⇒ **5**（副本，不含 helper 自身）|
| 其中**逐字相同**的全 3 规则副本 | **4** —— 判据用**签名 + 名字无关的模式**（不能用单一名字） | `grep -rnE "function strip[A-Za-z]*Comments?\(source: string\)" apps/client/test --exclude-dir=helpers \| wc -l` ⇒ **4** · `grep -rn "function stripComments(scss: string)" apps/client/test \| wc -l` ⇒ **1**（**故意不同**，见 R619） |
| 全仓（含 `packages/`）的实现数 | **8** | `grep -rn "function stripComments" apps/client/test packages/*/test` |
| 客户端 `src/**` 的裸依赖集合（现状） | `pinia` · `socket.io-client` · `vue` | 见 Task 0 Step 3 |
| 客户端 `src/**` 的 `@fight-the-landlord/*` 引用集合 | 只有 `@fight-the-landlord/protocol` | 同上 |
| 正则字面量里含 `\/\/` 的源码行 | **1 处**（`apps/client/src/net/http.ts:147` 的 `/^https?:\/\//i`） | `grep -rnE "= */\^?[^/*]*\\\\\\\\/" apps/client/src` |
| 已用最大裁决号 | **R616**（P24 声明的区间 R601–R616） | `grep -rhoE "R[0-9]{3}" docs/ --include=*.md \| sort -u \| tail` |

---

## 协调者裁决（本片新增，区间 **R617–R634**）

- **R617 本片**做**一件事**：把 `source-boundary.test.ts` 的注释盲问题收口。
  **不做**：「顺手把全部注释剥离实现一次收敛」—— 跨包的 **5 处**在**别的包**、**三种写法 / 两套守卫语义**
  （`no-internal-http.gate.test.ts` 那份**没有 `:` 守卫**，会把 `'http://x'` 截成 `'http:`，其文件头**自己写着**
  「字符串里的 `//` 理论上会误剥」），动它们要各自重跑该包的门禁 ⇒ **登记为 N46，不在本片**（R435 的同一精神）。
- **R618 判据的强度只许升不许降，且必须**机械证明**。本片用两条可执行不变量：
  ① **逐文件长度**：`stripComments_new(x).length >= stripComments_old(x).length`（新实现删得**不会更多**）；
  ② **违规集合包含**：对**每一条**客户端闸的违规谓词，`offenders_old ⊆ offenders_new`。
  两条都在**真实语料**（`collectSourceFiles()`）+ **合成样本**上跑。⇒ 只要它们在，就不可能出现「改完闸变松」。
  ⚠️ **范围（固定轮订正）**：这两条不变量证明的是「**相对被替掉的旧副本**只更严」——它们**不**比较「**原始文本** vs 剥注释文本」，而后者才是这 7 条闸实际做的那一步；剥注释器的**引号盲**（字面量里的 `//`・`/*`・`<!--`）因此仍是切视图时引进的**一处已知变松**，固定轮给它单独上闸（`comment-stripping.test.ts` 的「C1 守卫」），**建模字面量**归 **N46** 待裁决。
- **R619 `ui-tokens.test.ts` 的那份**（2 规则 SCSS 变体）**不并入**：它只服务 `<style>` 块的 px 闸，
  合并会**给它加上 `<!-- -->` 规则**（删得更多 = 更松）⇒ 违反 R618。本片只给它补一行**指向**规范实现的注释。
- **R620 7 条注释盲断言全部覆盖**（不许只修登记点名的那一条 —— 那正是 P13 教训 3「一处清理由必须配一处补清理」）：
  ① `@fight-the-landlord/shared` 原文扫描 · ② `@fight-the-landlord/*` 集合断言 · ③ `import`/`require` 目标扫描 ·
  ④ 规则标识符扫描 · ⑤ 底分字面量扫描 · ⑥ `大王`/`小王` 行内判定 · ⑦ 应用层 `emit('ping'|'pong')` 扫描。
- **R621 每条违规断言配一条正对照**（P19 的「判别力自证」规矩）：把**真违规 + 解释它的注释**成对注入合成样本
  ⇒ 每条断言必须**只报真违规那一个文件**。否则「剥注释」会变成把闸变绿的手段（本仓已付过代价的形态）。
  ⇒ 7 条违规断言 = **7 条正对照**（Task 2 Step 1）。
- **R622 视图分层**：`sources` 仍是**原始**内容（供「扫描器读到了文件」这类**存在性**断言用），
  新增 `codeSources`（剥注释后）供**违规**断言用。**不得**把存在性断言也剥注释
  （实测陷阱：`readAllSources()` 的 `toDisplay` 断言——`toDisplay` 目前在 `Card.vue` 的**真代码**里，
  但若哪天只出现在注释里，剥注释会让这条断言**假红**）。
- **R623 本片门禁**：`pnpm exec turbo run test lint --force`（29/29、0 cached）+ **`pnpm run ci` 六阶段全绿**
  + Task 1/3 的两条不变量 + 逐闸自证。**明确不跑**：`build --force`（`test/**` 不进产物）· docker ·
  13 条 conformance · 真浏览器探针（**它们不读 `test/**`**，信息量为零）。⚠️ 与 P16 的先例同款。
- **R624 顶回授权**：执行者若实测发现本计划的事实断言有误（行号、计数、某条断言其实不注释盲），
  **先实测、再跳过并汇报**，不得照抄。

---

## File Structure

```
apps/client/test/helpers/source-scan.ts        Modify: 新增唯一的 stripComments + 类型注释
apps/client/test/helpers/comment-stripping.test.ts   Create: 剥注释器的判别力闸 + 两条不变量（新文件）
apps/client/test/source-boundary.test.ts       Modify: 7 条注释盲断言改读 codeSources；补正对照
apps/client/test/uni-api-access.test.ts        Modify: 删本地副本，改 import（行为按不变量不变）
apps/client/test/import-meta-guard.gate.test.ts Modify: 同上
apps/client/test/http.test.ts                  Modify: 同上
apps/client/test/ui-tokens.test.ts             Modify: 只加一行指向注释（**不**并入，R619）
docs/superpowers/plans/deviation-ledger.md     Modify: §3 的 R572 行定终态 + §1.5 追加 N46 + §0 重算（若需）
docs/superpowers/plans/agent-briefs.md         Modify: 交接现状 + 「下一步」行同步 + 门禁实测 + 教训
docs/superpowers/plans/2026-09-17-slice-p25-r572-comment-blind-gate-fix.md   本文件：执行期裁决 + 门禁实测
```

---

### Task 0: 基线取证（协调者，可复核、可回退）

**Files:** 无（只读）

- [ ] **Step 1: 记下起点**

```bash
cd /home/howe/pokergame
git rev-parse HEAD                     # 期望 4f0857a
git status --short                     # 必须为空
grep -c "^  it(" apps/client/test/source-boundary.test.ts    # 期望 8
grep -rn "function stripComments" apps/client/test          # 期望 4 份
```

- [ ] **Step 2: 逐条枚举 7 个注释盲扫描点（**按形态，不按行号**）**

```bash
grep -nE "file\.content|readAllSources\(\)" apps/client/test/source-boundary.test.ts
```
把命中的每一处对照本计划 R620 的 ①–⑦ 列表逐条记账（汇报里要写「7 = ①…⑦ 逐条可点」）。

- [ ] **Step 3: 记下两条不变量在**改动前**的读数（后面要对比）**

```bash
cd apps/client
pnpm exec vitest run test/source-boundary.test.ts test/http.test.ts \
  test/uni-api-access.test.ts test/import-meta-guard.gate.test.ts test/ui-tokens.test.ts
# 期望：全绿。把每个文件的 `Tests N passed` 抄下来（改动后必须逐一相等或更多）
```

- [ ] **Step 4: 量出「正则字面量」危险面（`\)` 守卫的依据）**

```bash
cd /home/howe/pokergame
grep -rnE "= */[^/*]" apps/client/src | grep -F '\/' || echo "(0 处)"
# 期望恰 1 处：apps/client/src/net/http.ts 的 /^https?:\/\//i
```

---

### Task 1: 把唯一的 `stripComments` 落到共享扫描器（**TDD：先写闸，再写实现**）

**Files:**
- Modify: `apps/client/test/helpers/source-scan.ts`（在 `readAllSources` 之后追加）
- Create: `apps/client/test/helpers/comment-stripping.test.ts`

**Interfaces:**
- Consumes: `collectSourceFiles(): ScannedFile[]`（已存在）
- Produces:
  - `stripComments(source: string): string` —— 从 `./helpers/source-scan` 导出；唯一实现。
  - `stripCommentsNaive(source: string): string` —— **只在测试文件里**定义的「旧规则」参照实现
    （用于 R618 的不变量 ①），**不导出到 helper**。

- [ ] **Step 1: 写失败测试（剥注释器的判别力 + 两条不变量）**

`apps/client/test/helpers/comment-stripping.test.ts`：

```ts
/**
 * R572：剥注释器的**判别力闸**。
 *
 * 为什么它自己也要有闸：这个函数唯一的用途是「让别的闸读得更准」，
 * 一旦它剥多了，下游的 §12 闸会**静默变松** —— 那是本仓最贵的失效形态。
 * 所以这里有 ①合成样本的逐规则判别力，②真实语料上的**单调性不变量**。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './source-scan';

/** 改动前的旧规则（客户端 3 份副本逐字如此）——只作**参照**，用于不变量 ①。 */
function stripCommentsNaive(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('剥注释器：只删注释，且只会删得更少（R618/R571）', () => {
  it('删掉三种注释形态', () => {
    expect(stripComments('const a = 1; // 行注释\nconst b = 2;')).not.toContain('行注释');
    expect(stripComments('const a = 1; /* 块注释 */ const b = 2;')).not.toContain('块注释');
    expect(stripComments('<template><!-- 模板注释 --><view/></template>')).not.toContain('模板注释');
  });

  it('不误伤 URL：`http://` 与 `ws://` 里的 `//` 前面的字符是 `:`', () => {
    const src = "const u = 'http://192.168.1.5:3000/api'; import x from 'vue';";
    const out = stripComments(src);
    expect(out).toContain('http://192.168.1.5:3000/api');
    expect(out).toContain("import x from 'vue'");
  });

  it('不误伤正则字面量里的 `\\/\\/`（`\\` 守卫）—— 这是旧实现会吃掉的形态', () => {
    const src = 'const ABSOLUTE = /^https?:\\/\\//i; import y from "vue";';
    const out = stripComments(src);
    expect(out).toContain('/i;');
    expect(out).toContain('import y from "vue"');
    // 旧实现把 `/i; import y from "vue";` 整段当成行注释吃掉 ⇒ 这正是被修掉的**假阴性面**
    expect(stripCommentsNaive(src)).not.toContain('import y from "vue"');
  });

  it('注释里的违规写法不算违规（P19 实测的形态：`require("url")` 只出现在注释里）', () => {
    const src = '// 反面例子：const r = require("url");\nconst ok = 1;';
    expect(stripComments(src)).not.toContain('require');
  });

  it('不变量①：真实语料上，新实现删掉的**不会比**旧实现多（逐文件长度单调不减）', () => {
    const relaxed: string[] = [];
    for (const file of collectSourceFiles()) {
      const before = stripCommentsNaive(file.content).length;
      const after = stripComments(file.content).length;
      if (after < before) relaxed.push(`${file.path}: ${before} → ${after}`);
    }
    expect(relaxed, `新剥注释删得更多 ⇒ 下游闸可能变松：\n${relaxed.join('\n')}`).toEqual([]);
  });

  it('不变量②：对每条客户端闸的违规谓词，旧实现抓到的，新实现必须仍抓到', () => {
    // 谓词按**闸自己的定义**抄（不是重写规则）——见 source-boundary.test.ts / http.test.ts
    const VIOLATIONS: { name: string; re: RegExp }[] = [
      { name: 'shared 引用', re: /@fight-the-landlord\/shared/ },
      { name: '禁止的 import 目标', re: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]*(?:room-service|packages\/shared))['"]/ },
      { name: '规则标识符', re: /\bHandType\b/ },
      { name: '底分字面量', re: /\bbaseScore\s*=\s*[\d_]+/ },
      { name: '应用层心跳', re: /emit\(\s*['"](?:ping|pong)['"]/ },
      { name: '裸 fetch', re: /\bfetch\s*\(/ },
      { name: 'import.meta 实体化', re: /typeof\s+import\.meta\b/ },
    ];
    const relaxed: string[] = [];
    for (const file of collectSourceFiles()) {
      for (const { name, re } of VIOLATIONS) {
        if (re.test(stripCommentsNaive(file.content)) && !re.test(stripComments(file.content))) {
          relaxed.push(`${file.path}: ${name}`);
        }
      }
    }
    expect(relaxed, `新实现漏掉了旧实现抓到的违规：\n${relaxed.join('\n')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `cd apps/client && pnpm exec vitest run test/helpers/comment-stripping.test.ts`
Expected: FAIL —— `stripComments is not a function`（或 `undefined`）⇒ 编译/导入错误

- [ ] **Step 3: 写最小实现（落进 `helpers/source-scan.ts`）**

在 `readAllSources` 之后追加：

```ts
/**
 * 去掉注释，返回**可扫描的代码文本**（R572）。
 *
 * ## 为什么必须有它
 *
 * 本仓的注释习惯是**逐字引用真实写法**：解释一个坑时就会写出 `require("url")`、`const api = uni`、
 * `emit('ping')`、`@fight-the-landlord/shared`。按原始文本匹配会把**解释本身**打红 ⇒
 * 唯一能让人变绿的做法是**删掉解释** —— 那是把判别力换成注释洁净度，方向反了。
 * （本仓已实测三次：`ui-tokens` · `uni-api-access` · P19 的 `require("url")`。）
 *
 * ## 规则（只有三条，且**保守**）
 *
 *  ① `<!-- … -->`（`.vue` 模板里的 HTML 注释）⇒ 换成空格；
 *  ② `/* … *\/`（块注释 / JSDoc）⇒ 换成空格；
 *  ③ `//…`（行注释）⇒ 换成一个空格 —— **但前一个字符是 `:` 或 `\` 时不动**：
 *     · `:` 覆盖 `http://` / `ws://`（URL 出现在代码与字符串里是常态，`src/net/http.ts` 就有）；
 *     · `\` 覆盖正则字面量里的 `\/\/`（`src/net/http.ts:147` 的 `/^https?:\/\//i`）——
 *       没有这个守卫时，那个正则的**行尾**会被当成行注释吃掉（`comment-stripping.test.ts` 的第 3 条钉住它）。
 *
 * ## 已知边界（**故意**不处理的）
 *
 *  · **不建模字符串/模板字面量**：`'a // b'` 这种字符串里的 `//` 仍会被剥掉。
 *    本仓当前语料**没有**这种形态（实测：`src/**` 里 `//` 的每一个出现都被 `:` 保护）；
 *    且下面的**不变量**保证这不会让任何闸变松（见 `comment-stripping.test.ts`）。
 *  · **不建模正则字面量的起止**：只靠 `\` 守卫覆盖 `\/\/`。
 *
 * ⚠️ **唯一实现**（R617/R623）：`apps/client/test/**` 下不得再出现第二份
 * （`grep -rn "function stripComments" apps/client/test` 必须只剩 `ui-tokens.test.ts` 的那份 SCSS 变体，
 * 它**故意**不同 —— 并入会给它加上 `<!-- -->` 规则 ⇒ 删得更多 ⇒ 更松，见 R619）。
 */
export function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/client && pnpm exec vitest run test/helpers/comment-stripping.test.ts`
Expected: PASS，`6 passed`

- [ ] **Step 5: 提交**

```bash
cd /home/howe/pokergame
git add apps/client/test/helpers/source-scan.ts apps/client/test/helpers/comment-stripping.test.ts
git commit -m "test(client): 剥注释收敛成唯一实现 + 判别力闸与两条单调性不变量（P25/R617-R618）"
```

---

### Task 2: `source-boundary.test.ts` 的 7 条注释盲断言改读剥注释视图

**Files:**
- Modify: `apps/client/test/source-boundary.test.ts`

**Interfaces:**
- Consumes: `stripComments`（Task 1 产出）、既有的 `collectSourceFiles` / `readAllSources`
- Produces: 无（测试内部）

- [ ] **Step 1: 先加**两组**合成样本控制（正对照 + 负对照）—— Step 1a 正对照、Step 1b 负对照（**这一组才是本任务的 RED**）**

在文件末尾（`describe('⑤ …')` 之后）追加：

```ts
describe('R572 正对照：剥注释不得把真违规一起剥掉', () => {
  /** 合成样本：真违规 + 解释它的注释（本仓注释习惯的真实形态）。 */
  const synthetic = [
    {
      path: 'src/fake-shared.ts',
      content: `// 反例：不得 import '@fight-the-landlord/shared'\nimport { x } from '@fight-the-landlord/shared';`,
    },
    {
      path: 'src/fake-svc.ts',
      content: `// 反例：require('room-service')\nconst h = require('room-service');`,
    },
    {
      path: 'src/fake-rule.ts',
      content: `// 反例：前端不得出现 HandType\nconst t = HandType.Single;`,
    },
    {
      path: 'src/fake-score.ts',
      content: `// 反例：M09 禁止底分字面量\nconst baseScore = 100;`,
    },
    {
      path: 'src/fake-ping.ts',
      content: `// 反例：§6.1 不得有应用层心跳\nsocket.emit('ping');`,
    },
    {
      path: 'src/fake-import.ts',
      content: `// 说明：这里解释为什么不能引用别的包\nimport { y } from 'room-service';`,
    },
  ];

  it('① 注释里提到 shared ⇒ 放行；真 import ⇒ 报出', () => {
    const offenders = synthetic
      .map((f) => ({ ...f, code: stripComments(f.content) }))
      .filter((f) => /@fight-the-landlord\/shared/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual(['src/fake-shared.ts']); // ⚠️ 注释那行不算，真 import 那行算
  });

  it('② 只能引用 protocol：注释里提别的包名 ⇒ 不计入裸依赖集合', () => {
    const referenced = new Set<string>();
    for (const f of synthetic) {
      for (const m of stripComments(f.content).matchAll(/@fight-the-landlord\/[a-z-]+/g)) {
        referenced.add(m[0]);
      }
    }
    expect([...referenced].sort()).toEqual(['@fight-the-landlord/shared']);
  });

  it('③ import/require 目标扫描：真 require('room-service') 必须报出', () => {
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const hit = synthetic
      .flatMap((f) => [...stripComments(f.content).matchAll(re)].map((m) => m[1]!))
      .filter((t) => t.includes('room-service'));
    /**
     * ⚠️ **R627（执行期订正）**：期望值是**两条**，不是一条 —— `synthetic` 里有两处**真**依赖语句
     * （`fake-svc.ts` 的 `require(` 分支 + `fake-import.ts` 的 `from` 分支），一条注释放行、两条代码命中。
     * 按**原始**文本算会是**三条**（`fake-svc.ts` 那条注释里的 `require('room-service')` 也被算进去）
     * ⇒ 这个字面量**恰好也钉住了「读的是剥注释视图」**，比原来的单条期望更严。
     */
    expect(hit).toEqual(['room-service', 'room-service']);
  });

  it('④ 规则标识符：注释里的 HandType 放行，代码里的报出', () => {
    const hit = synthetic
      .filter((f) => /\bHandType\b/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-rule.ts']);
  });

  it('⑤ 底分字面量：注释里的 `baseScore = 100` 放行，代码里的报出', () => {
    const hit = synthetic
      .filter((f) => /\b(?:const|let|var)\s+\w*(?:base|unit)?score\w*\s*=\s*[\d_]+/i.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-score.ts']);
  });

  it('⑦ 应用层心跳：注释里的 emit(\'ping\') 放行，代码里的报出', () => {
    const hit = synthetic
      .filter((f) => /emit\(\s*['"](?:ping|pong)['"]/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-ping.ts']);
  });

  it('⑥ 自制点数映射：注释里的 `大王` 放行，代码里的报出', () => {
    // ⑥ 现在的实现是「按行猜这行是不是注释」——剥注释后不再需要那个补丁（R620 的 ⑥）
    const withTpl = [
      { path: 'src/fake-face.ts', content: `// 反例：不得自制牌面映射，如 '大王'\nconst f = (n: number) => (n === 17 ? '小王' : '');` },
      { path: 'src/fake-face-ok.ts', content: `// 这里只解释：'大王'/'小王' 必须走 toDisplay\nconst f = (n: number) => toDisplay(n);` },
    ];
    const hit = withTpl
      .filter((f) => /['"](?:大王|小王)['"]/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hit).toEqual(['src/fake-face.ts']); // ⚠️ 注释里那行不算，代码里那行算
  });
});
```

#### Step 1b: 负对照 —— **纯注释文件必须零违规**（这一组才是本任务的 RED）

上面 7 条是**正**对照（真违规必须被报出）；本组是**负**对照：拿**只含注释**的样本喂给**这 7 条判据本身**，
断言「零违规」。它在改动前**必红**（判据读原始文本 ⇒ 注释里的写法被当成违规），改动后**必绿**
⇒ 这才是「本任务真的修好了注释盲」的**持久**证据（一次性临时探针随报告消失，不作数）。

```ts
describe('R572 负对照（R626）：纯注释样本对 7 条判据必须零违规', () => {
  /** 只有注释、没有任何真代码的样本 —— 抄的是本仓注释的真实习惯。 */
  const commentOnly = [
    { path: 'src/c1.ts', content: `// 不得 import '@fight-the-landlord/shared'（会把规则带进前端）` },
    { path: 'src/c2.ts', content: `// 反例：const h = require('room-service');` },
    { path: 'src/c3.ts', content: `// 反例：前端不得出现 HandType.Single` },
    { path: 'src/c4.ts', content: `// 反例：M09 禁止 const baseScore = 100;` },
    { path: 'src/c5.ts', content: `// 反例：§6.1 不得有 socket.emit('ping')` },
    { path: 'src/c6.ts', content: `/* 块注释里也不能被误判：'大王' / '小王' 必须走 toDisplay */` },
    { path: 'src/c7.ts', content: `<!-- 模板注释：HandType 与 baseScore = 100 -->` },
  ];
  const code = commentOnly.map((f) => ({ path: f.path, content: stripComments(f.content) }));

  it('① 没有任何 shared 引用', () => {
    expect(code.filter((f) => /@fight-the-landlord\/shared/.test(f.content)).map((f) => f.path)).toEqual([]);
  });
  it('② shared 命名空间集合为空', () => {
    const referenced = new Set<string>();
    for (const f of code) for (const m of f.content.matchAll(/@fight-the-landlord\/[a-z-]+/g)) referenced.add(m[0]);
    expect([...referenced].sort()).toEqual([]);
  });
  it('③ 没有禁止的 import/require 目标，也没有裸依赖', () => {
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    const targets = code.flatMap((f) => [...f.content.matchAll(re)].map((m) => m[1]!));
    expect(targets.filter((t) => t.includes('room-service'))).toEqual([]);
    expect(targets.filter((t) => !t.startsWith('.') && !t.startsWith('@fight-the-landlord/protocol'))).toEqual([]);
  });
  it('④ 没有规则标识符', () => {
    const banned = ['HandType', 'parseHand', 'canBeat', 'isBomb', 'toInternalRank'];
    expect(code.flatMap((f) => banned.filter((id) => new RegExp(`\\b${id}\\b`).test(f.content)))).toEqual([]);
  });
  it('⑤ 没有底分字面量', () => {
    expect(
      code.flatMap((f) => [
        ...f.content.matchAll(/\b(?:const|let|var)\s+\w*(?:base|unit)?score\w*\s*=\s*[\d_]+/gi),
        ...f.content.matchAll(/\b(?:BASE_?SCORE|BASE_SCORE|DEFAULT_SCORE)\b\s*[:=]\s*[\d_]+/g),
      ]),
    ).toEqual([]);
  });
  it('⑥ 没有自制点数映射字面量', () => {
    expect(code.flatMap((f) => [...f.content.matchAll(/['"](?:大王|小王)['"]/g)])).toEqual([]);
  });
  it('⑦ 没有应用层心跳', () => {
    expect(code.filter((f) => /emit\(\s*['"](?:ping|pong)['"]/.test(f.content)).map((f) => f.path)).toEqual([]);
  });

  /**
   * ⚠️ **R628（执行期订正）**：上面 7 条负对照**钉不住生产侧的那一步**。
   *
   * 它们自己造视图（`code = commentOnly.map(…stripComments…)`），语料与 `codeSources`（真实 `src/**`）
   * **不相交**，因此两块是**并行**的、不是串联的 —— 把 7 条生产断言里的 `codeSources` 改回 `sources`
   * （即整条改动被撤掉）**本组一条都不会红**（implementer 实测：M3a ⇒ 全绿）。
   * 这与本文件另一处守卫（`扫描器确实读到了文件`，防止「因为读不到文件而永远通过」）是同一类：
   * **守卫必须观察被守卫的那份输入本身**。
   */
  it('生产视图 codeSources 确实剥掉了注释（把 `codeSources = sources` 或把 stripComments 改成恒等 ⇒ 本断言红）', () => {
    const changed = codeSources.filter((f, i) => f.content !== sources[i]!.content).length;
    // `src/**` 的文件普遍带注释 ⇒ 正常态一定 > 0；`codeSources` 被指向原始文本时恒为 0 ⇒ 当场红。
    expect(
      changed,
      'codeSources 与 sources 完全相同 ⇒ 生产侧的 7 条断言读的其实是原始文本（注释盲缺陷回来了）',
    ).toBeGreaterThan(0);
    /**
     * ⚠️ **本守卫的射程（R629 实测，别把标题读成更强的承诺）**：
     *   ✅ **能**抓：`const codeSources = sources`（把常量指向原始文本）· 删掉 `codeSources` 声明（`ReferenceError`）·
     *      `stripComments` 改成恒等（本片 M2 复跑实测 10 failed）。
     *   ❌ **抓不到**：把 7 条循环**逐条**改回 `for (const file of sources)` 而**留下**一个已无人读的 `codeSources` 常量。
     *      要抓那一态只能**自引用静态扫描本文件**（数 `for (const file of codeSources)` 的出现次数），
     *      而那会让本文件在**重命名/重排**时产生**假红** —— 假红是本仓更贵的一类病（P13 教训 2：按形态计数会漏/会误）。
     *      ⇒ **故意不加**那第 9 条；这一态由**人评审**兜（本注释就是那份提示）。
     */
  });
});
```

⚠️ **本组 7 条与 Step 1 的 7 条一一对应**（同一个判据、相反的样本极性）。二者合起来才说明
「真违规仍被抓 ∧ 纯注释不再被误抓」—— 这就是 P19 那条教训（判别力必须自证）的落地。

- [ ] **Step 2: 跑它，确认现在**不是**全绿 —— 但**红灯不在这里**（R626 订正）

⚠️ **本步的原始预期是错的，已按实测订正**（Task 2 执行期发现，implementer 顶回）：
原计划写「①③④⑤⑥⑦ 都会报多出来的 `src/fake-*.ts`」—— **不成立**。原因是这 7 条对照**直接调用**
`stripComments`（Task 1 的产物），而 ①④⑤⑦ 的断言是「**文件路径**列表」，一行注释**不可能**多出一个文件。
实测：`pnpm exec vitest run test/source-boundary.test.ts -t 'R572 正对照'` ⇒ **1 failed | 6 passed**
（只有 ③ 红，而它红的原因是期望值写成了一条 —— 见 Step 1 的 R627）。

**真实缺陷为什么没有现成红灯**（实测）：`source-boundary.test.ts` 的 7 条判据在**当前 `src/**` 语料上**
**没有任何注释命中**（`大王`/`小王` 0 · `@fight-the-landlord/shared` 0 · `HandType` 0 · 底分字面量 0 ·
`emit('ping')` 0）⇒ 这个注释盲缺陷是**潜伏的**（P19 那次真实命中后来被「改用不含引号的写法」绕开了）。
⇒ **潜伏缺陷的 RED 必须**构造**出来**，由 Step 1b 的**负对照**承担（它同时是永久的判据，而不是一次性探针）。

```bash
# 判别力自证（两种模式都要做，做完恢复原状）：
#  M1 把 canonical 改成 `() => ''`      ⇒ 7 条对照**全红**（证明没有一条是恒绿装饰）
#  M2 把 canonical 改成恒等（= 原始文本）⇒ ③ 与 ⑥ **红**（它们直接钉「原始文本 vs 剥注释」）
#  M3a 有三种读法，**只有后两种会被第 8 条守卫抓到**（R628/R5 实测）：
#    M3a-1 只把 7 条循环改回 `sources`、留下 `codeSources` 常量 ⇒ 7 条负对照**与守卫都绿**（已知射程外，见守卫注释）
#    M3a-2 `const codeSources = sources;`                        ⇒ 守卫**红** ✅
#    M3a-3 删掉 `codeSources` 声明（整条改动被撤）              ⇒ 守卫**红**（ReferenceError）✅
#  M3b 把**两处**派生点都退回原始文本（`codeSources = sources` + `code = commentOnly`）⇒ Step 1b 的 7 条负对照必须红。
```
⚠️ 把 M1–M3 的**原文输出**抄进报告。**M3a + M3b 合起来**才是本片最关键的判别力证据：
M3a 证明「生产视图被剥过」这件事被钉住，M3b 证明「匹配前先剥」这件事被钉住。

- [ ] **Step 3: 改 7 条断言读剥注释视图 + 修 ⑥ 的行内判定**

- 顶部 import 改：

```ts
import { collectSourceFiles, readAllSources, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
/**
 * R572/R622：**违规类**断言一律读这个视图（剥注释）；**存在性**断言（「扫描器确实读到了文件」）
 * 仍读 `sources`（原始文本）—— 那个断言问的是「文件读到没有」，不是「有没有违规」。
 */
const codeSources = sources.map((f) => ({ path: f.path, content: stripComments(f.content) }));
```

- ①（`@fight-the-landlord/shared`）、②（`@fight-the-landlord/*` 集合）、③（import/require）、
  ④（规则标识符）、⑤（底分字面量）、⑦（`emit('ping')`）：把循环里的 `sources` 改成 `codeSources`
  （**只改被遍历的那个数组名**，判据与文案一字不动）。
- ⑥（`大王`/`小王`）：把「按行判断这行是不是注释」的补丁**删掉**，改成在 `codeSources` 上直接匹配：

```ts
  it('没有人写点数映射（必须用 protocol 的 toDisplay）', () => {
    const offenders: string[] = [];
    for (const file of codeSources) {
      // R572：不再需要「这行是不是注释」的行内猜测 —— 剥注释已经把注释移出视野
      for (const m of file.content.matchAll(/['"](?:大王|小王)['"]/g)) {
        offenders.push(`${file.path}: ${m[0]}`);
      }
    }
    expect(offenders, `自制牌面映射（应使用 protocol.toDisplay）：\n${offenders.join('\n')}`).toEqual([]);
  });
```

- `readAllSources()` 的那条存在性断言 **保持**原始文本（R622），并在注释里写明理由。

- [ ] **Step 4: 重跑三组，确认全绿**

Run: `cd apps/client && pnpm exec vitest run test/source-boundary.test.ts`
Expected: PASS，`Tests` 数 = 原 **8** + Step 1 的 **7** 条正对照 + Step 1b 的 **8** 条（7 条负对照 + 1 条生产视图守卫）= **23 passed**

- [ ] **Step 5: 逐闸自证（R621：判别力没有丢）**

Run: `cd apps/client && pnpm exec vitest run test/source-boundary.test.ts -t 'R572 正对照'`
Expected: PASS —— 说明「注释放行 + 真违规报出」两侧都成立。

- [ ] **Step 6: 提交**

```bash
cd /home/howe/pokergame
git add apps/client/test/source-boundary.test.ts
git commit -m "test(client): source-boundary 的 7 条注释盲扫描改读剥注释视图 + 7 条正对照（P25/R620-R622）"
```

---

### Task 3: 客户端另外 **4** 份全 3 规则副本收敛到同一个 import（含 `ui-tokens` 的 `stripSfcComments`）

**Files:**
- Modify: `apps/client/test/uni-api-access.test.ts` · `apps/client/test/import-meta-guard.gate.test.ts` · `apps/client/test/http.test.ts` · `apps/client/test/ui-tokens.test.ts`

**Interfaces:**
- Consumes: `stripComments`（Task 1）
- Produces: 无

- [ ] **Step 1: 四份全 3 规则副本换 import（⚠️ 其中一份换了名字）**

**先重新枚举，不要照抄旧清单**（P24 教训 5：`grep` 被清对象的**名字**会漏）：

```bash
# ⚠️ 必须 `--exclude-dir=helpers`：否则 helper 自己的 canonical export 也会被数进来（那是**真源**，不是副本）
grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test --exclude-dir=helpers
# 期望 **5** 行：uni-api-access:25 · import-meta-guard.gate:43 · http.test:252 ·
#              ui-tokens:33(stripSfcComments) · ui-tokens:56(scss 变体)
```

对 `uni-api-access.test.ts` · `import-meta-guard.gate.test.ts` · `http.test.ts` 三份：
删掉本地的 `function stripComments(...)`（连同它上面那段文档注释，把有用的信息**并进** Task 1 的 JSDoc），
并把 `./helpers/source-scan` 的 import 行补上 `stripComments`：

```ts
import { collectSourceFiles, stripComments } from './helpers/source-scan';
```

⚠️ `http.test.ts` 若当前没 import 该 helper，按它实际用的函数补（先 `grep -n "helpers/source-scan" apps/client/test/http.test.ts`）。

**第四份在 `ui-tokens.test.ts:33`、叫 `stripSfcComments`** —— 它与上面三份**逐字相同**，只是**换了名字**，
所以按 `function stripComments` 数会**整个漏掉**（R625 的裁决就是这条）。它被 `styleBlocks()` 用来先剥注释再取
`<style>` 内容。处置：**删掉它**，并把 canonical 实现以**别名**引入，使 `styleBlocks()` 的调用点一行不改：

```ts
import { collectSourceFiles, stripComments as stripSfcComments } from './helpers/source-scan';
```

⚠️ 方向性检查（必须成立）：canonical 比它多一条 `\` 守卫 ⇒ **删得更少** ⇒ 对 px 闸只会**更严**，符合 R618 的不变量①。

- [ ] **Step 2: `ui-tokens.test.ts:56` 的 `(scss: string)` 变体只加指向注释（R619：不并入）**

在它那份 `stripComments` 的 JSDoc 末尾追加：

```ts
 * ⚠️ **故意不并入** `helpers/source-scan#stripComments`（R619）：那份会额外剥 `<!-- -->`，
 * 而本函数只服务 `<style>` 块的 px 闸 —— 加上那条规则等于**删得更多**（更松），
 * 违反本片的不变量（R618）。两份实现的差异是**有意的**，不是遗漏。
```

- [ ] **Step 3: 不变量①②在**改动后**再跑一次（这是本片最重要的一步）**

Run: `cd apps/client && pnpm exec vitest run test/helpers/comment-stripping.test.ts`
Expected: PASS，`6 passed` —— 不变量在真实语料上仍成立。

- [ ] **Step 4: 五个文件逐一重跑，确认判据一条没丢**

```bash
cd apps/client
pnpm exec vitest run test/source-boundary.test.ts test/http.test.ts \
  test/uni-api-access.test.ts test/import-meta-guard.gate.test.ts test/ui-tokens.test.ts
```
Expected: 全绿，且**每个文件的 `Tests N passed` ≥ Task 0 Step 3 记下的那个数**（不许减少）。

- [ ] **Step 5: 「唯一实现」自证（R623，按形态计数）**

```bash
cd /home/howe/pokergame
# ⚠️ 判据必须**名字无关 + 排除 helper**（R625）：单名字模式既会误命中 stripCommentsNaive
#    （C1 的 oracle），又会漏掉换名的副本（stripSfcComments）—— 两个方向都会给出假读数。
grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test --exclude-dir=helpers
# 期望**恰好 1 行**：ui-tokens.test.ts:56（scss 变体，R619 故意保留）
grep -rnE "function strip[A-Za-z]*Comments?\(source: string\)" apps/client/test --exclude-dir=helpers | wc -l
# 期望 **0**（4 份全 3 规则副本已全部换成 import，含换名的 stripSfcComments）
```

- [ ] **Step 6: 提交**

```bash
cd /home/howe/pokergame
git add apps/client/test
git commit -m "test(client): 4 份全 3 规则 strip*Comments 副本收敛到 helpers 唯一实现（P25/R619/R623）"
```

---

### Task 4: 登记跨包收敛为 **N46**（本片只登记、不修）

**Files:**
- Modify: `docs/superpowers/plans/deviation-ledger.md`（§1.5 追加 N46 行）

- [ ] **Step 1: 实测证据（写进 N46 的证据列）**

```bash
cd /home/howe/pokergame
# ⚠️ 名字无关（R625 的教训：单名字会漏掉换名的实现）
grep -rnE "function strip[A-Za-z]*Comments?\(" packages/*/test | wc -l   # 期望 4
grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test packages/*/test | wc -l  # A 判据：期望 6（客户端 2 + 跨包 4）
grep -rnE "const strip[A-Za-z]*Comments?\s*=" apps/client/test packages/*/test | wc -l   # B₂：期望 1（user-service 的箭头函数）
grep -rnF 'replace(/\/\*[\s\S]*?\*\//g' apps/client/test packages/*/test | wc -l        # C：期望 8（7 实现 + 1 oracle）
sed -n "$(grep -nE 'function strip[A-Za-z]*Comments?\(' packages/room-service/test/no-internal-http.gate.test.ts | cut -d: -f1),+8p" \
  packages/room-service/test/no-internal-http.gate.test.ts
# 期望看到：先剥 /* */，再 `line.replace(/\/\/.*$/, '')` —— **没有 `:` 守卫**
# ⇒ `'http://x'` 会被截成 `'http:`（该文件头自己写着「字符串里的 // 理论上会误剥」）
```

- [ ] **Step 2: 追加 N46 行（`§1.5 新增 N 系列` 表末）**

格式照既有行：`| N46 | **仍开放** | 【新登记（切片 P25，R617）】… | **归属**：测试基建 |`

内容必须含（**数字以 Step 1 的实测为准，不许照抄这里的历史数**）：
- **三层取数判据**（R632）：**A 命名族** `grep -rnE "function strip[A-Za-z]*Comments?\("` —— 只容忍这一族，
  **漏掉箭头函数形式与族外改名**；**B₂ 第二种函数形式**（`const … =`；与 A 合起来 = 两种声明形式，**两者都是「按名字」的判据**）；**C 结构性兜底**
  `grep -rnF 'replace(/\/\*[\s\S]*?\*\//g'`（**必须 `-F`**：带正则元字符的写法在本机实测会返回 **0 命中 = 假绿**，这个坑要写进 N46）。
- 实测读数：**A** 本片前 9 → 后 6；**B₂ 补齐后**本片前 **10** → 后 **7**（实现总数 = 客户端 2 + 跨包 **5**）；
  **C 今天 8 处** = 7 个实现 + **1 处刻意保留的 oracle**（`test/helpers/comment-stripping.test.ts` 的 `stripCommentsNaive`，A/B 都不匹配它）。
- 本片把客户端的 **5** 份收敛到 **2** 份（canonical export + `ui-tokens` 的 `(scss: string)` 变体，R619）；
- 跨包剩下 **5** 处、**三种写法 / 两套守卫语义**：api-gateway 的 **3** 份逐字相同
  （`container-assembly.gate.test.ts:86` · `no-raw-console.test.ts:37` · `no-di-metadata-shim.gate.test.ts:46`，
  都是 `src.replace(/\/\*…\*\//g,'').replace(/(^|[^:])…/gm,'$1')` —— **带 `:` 守卫**）· room-service 的**逐行变体**
  （`no-internal-http.gate.test.ts:103`）· **user-service 的箭头函数常量**
  （`migration.test.ts:43-44`，**A 判据抓不到它**（没有 `function` 关键字）、**B₂（`const … =`）抓得到它**；其守卫与 room-service 那份同属**没有 `:` 守卫**的一类：`/\/\/[^\n]*/g`）；
- **残余**：连 C 也依赖那个字面正则 ⇒ 手写状态机式的剥离器三层全逃，只能靠**人评审**（要写进 N46）。

- [ ] **Step 3: 台账收口**

```bash
cd /home/howe/pokergame
node scripts/ledger-counts.mjs     # N46 计入后，条数 98 → 99（仍开放 0 → 1）
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/deviation-ledger.md
git commit -m "docs(ledger): 登记 N46 —— 跨包 5 处注释剥离副本（P25/R617）"
```

---

### Task 5: 收口（协调者）

- [ ] **Step 1: 台账 §3 的 R572 行定终态**

把 §3 里那条 R572 登记（`agent-briefs` 的「下一步」行里点名的那条；若 §3 无独立行则**新增**一行，
照 P13 的先例 R499：**先 `grep` 确认是否真有该登记**，没有就新增而不是「销掉」）改成
`✅ **已处置（P25）**` + 形态计数（见 Step 3）+ 处置分布。

- [ ] **Step 2: `agent-briefs.md` 三处同步**

① 「交接现状」加 P25 行；② 「下一步（按序）」行把 R572 从「可选事项」里**划掉**（剩：N39 App 半边 · §4 部署前提 · roadmap §2.2）；
③ 「已知环境事实」的 P19 第 2 条**改写**（原文说「已有的 §12 扫描器这条待办已登记，但不在修 bug 的片子里顺手改」
⇒ 现在已修，改成「`source-boundary` 已剥注释（P25）；**跨包 5 处仍未**（N46）」）。

- [ ] **Step 3: 形态口径自证（**不写行号**）**

```bash
cd /home/howe/pokergame
# ⚠️ T5 与 T3 用**同一条**名字无关 + 排除 helper 的命令（R625：单名字模式两个方向都会给假读数）
grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test --exclude-dir=helpers | wc -l            # 5 → 1
grep -rnE "function strip[A-Za-z]*Comments?\(source: string\)" apps/client/test --exclude-dir=helpers | wc -l  # 4 → 0
grep -c "^  it(" apps/client/test/source-boundary.test.ts                          # 8 → 23
grep -rnE "function strip[A-Za-z]*Comments?\(" packages/*/test | wc -l            # 4（N46，未动）
```

- [ ] **Step 4: 本文件追加「执行期裁决」与「门禁实测」块 + 提交**

```bash
git add docs/
git commit -m "docs: R572 收口 —— source-boundary 剥注释 + 唯一实现 + N46 登记（P25/R617-R630）"
```

---

## 门禁（R623：本片只改 `test/**` ⇒ 中量门禁）

```bash
cd /home/howe/pokergame
git status --short                        # ⚠️ 只允许 apps/client/test/** 与 docs/**（R602 同精神）
pnpm exec turbo run test lint --force     # ✅ 29/29、0 cached（client 用例数只增不减）
pnpm run ci                               # ✅ 六阶段全绿 —— **第 6 阶段就是本片要护的那六条源码闸**
grep -rn "function stripComments" apps/client/test | wc -l   # ✅ 1
node scripts/ledger-counts.mjs            # ✅ 逐区一致（含 N46）
```

**明确不跑**（R623）：`build --force`（`test/**` 不进任何产物）· `docker compose build/up` ·
13 条 conformance · 真浏览器探针 —— 它们**不读 `apps/client/test/**`**，信息量为零；
本片 `apps/client/src/**` 与 `packages/**` **0 行改动**（Global Constraint 2）。

## Self-Review

**Spec coverage**

| Spec 要求 | 落在哪个 Task |
|---|---|
| §12.4 的源码闸不得被放宽（R435） | Task 1 Step 3（不变量①②）+ Task 3 Step 3 |
| §12.2 FORBIDDEN（F01/F02/F10/M09）**判据不减** | Task 2 Step 3/4（逐条断言 + 7 条正对照） |
| P19 环境事实第 2 条（注释盲）收口 | Task 1 + Task 2 + Task 5 Step 2 |
| 「同源遗漏面」一并处置（P13 教训 3） | Task 2（7 条全覆盖）+ Task 4（跨包 5 处）|
| 计数自证（P7 教训 7） | Task 5 Step 3 |

**Placeholder scan**：无 TBD；Task 1/2 都给了可粘贴的测试代码与实现代码；命令全部带期望读数。

**Type consistency**：`stripComments(source: string): string` 在 Task 1 定义，Task 2/3 消费；
`stripCommentsNaive` **只在** `comment-stripping.test.ts` 内定义（故意不导出，避免成为第二个真源）；
`codeSources` 在 Task 2 内定义并使用（`ScannedFile[]` 同形）。

**⚠️ 本片的三个高风险点**
1. **把「剥注释」当成变绿手段** —— 那会让 §12 的闸静默失效。⇒ R618 的两条不变量 + R621 的 7 条正对照，缺一不可。
2. **顺手把全部实现一次收敛** —— 跨包 **5 处里有 2 份没有 `:` 守卫**（会截断 `'http://x'`），合并进一个函数会同时**改掉两个包的判据**。
3. **把存在性断言也剥注释** —— `readAllSources()` 的 `toDisplay` 断言会被注释形态左右（R622）。

---

## 执行期裁决（回填区，**不要删**）

> ⚠️ 本片执行期共 **10 条**裁决（本片区间 **R625–R634**）。⚠️ **编号统一说明**：台账/派工单里一度用过局部标签
> `P25-R1`…`P25-R10`，已在收口时**全部改名为 R625–R634**（本仓只用一个 R 序列）；下表给出映射。

- **R625（原 P25-R1）「按名字计数」双向失效 —— 本片最贵的一条**。`grep "function stripComments"` 既**误命中**
  oracle（`stripCommentsNaive`，子串），又**漏掉换名副本**（`ui-tokens.test.ts:33` 的 `stripSfcComments`，与另三份逐字相同）。
  ⇒ 判据改**三层**：**A** 命名族 · **B₂** `const … =` 形式 · **C** 结构性兜底（`grep -rnF 'replace(/\/\*[\s\S]*?\*\//g'`，**唯一**与名字无关；
  本片靠它多发现 `packages/user-service/test/migration.test.ts:43-44` 的**箭头函数常量**）。**残余**：手写状态机式剥离器全逃 ⇒ 人评审。
- **R626（原 P25-R2）潜伏缺陷的 RED 必须**构造**且必须**永久化**。7 条正对照在改动前就绿（它们直接调 Task 1 的产物），
  当前语料也没有任何注释命中那 7 条判据 ⇒ 真正的判别力是**负对照**（纯注释样本 ⇒ 零违规），而一次性临时探针会随
  `.superpowers/`（gitignored）消失。⇒ 升级为永久测试（`it(` 8 → 22）。
- **R627（原 P25-R3）③ 的期望值订正**：`synthetic` 里有两处**真**依赖语句 ⇒ 剥注释后命中 **2** 条（`['room-service','room-service']`），
  按**原始**文本算是 3 条 ⇒ 该字面量顺带钉住了「读的是剥注释视图」。计划原值**逐字不可满足**。
- **R628（原 P25-R4）补第 8 条「生产视图守卫」**：负对照自造语料 ⇒ 与生产语料**不相交** ⇒ 两块**并联**，
  把 7 条生产断言改回 `sources` **一条负对照都不会红**（M3a-1）。⇒ 加一条直接比较 `codeSources` 与 `sources` 的守卫
  （`changed > 0`），与既有的「扫描器确实读到了文件」同类。`it(` 8 → **23**。
- **R629（原 P25-R5）接受 M3a-1 残余，但把守卫的**书面承诺**改成真的**：**不加**第 9 条自指静态闸
  （计数 `for (const file of codeSources)` 会在重命名/重排时**假红** —— 本仓更贵的一类病）；
  改为在守卫内逐字写明**射程**（能抓 M3a-2/M3a-3/M2；抓不到 M3a-1；为什么）。
- **R630（原 P25-R6）JSDoc 的**仅注释**范围例外**：Task 3 一收敛，Task 1 写的「**今天** = 5 行 / **今天** = 4 行」立刻变假
  ⇒ 授权 implementer 只改 `helpers/source-scan.ts` 的 JSDoc，把「今天」换成「Task 1 落地时 / Task 3 收敛后」。
- **R631（原 P25-R7）§5 第 3 条的桶清单自己腐坏**（自初始台账 `ab8f465` 起未更新）⇒ 改成**描述性**词汇：
  逐条列出 §1.x **实际在用**的桶 + 「新领域出现时在**首次使用它的那个 commit** 里补进本条」+ 写明**执法事实**
  （脚本只校验**判定**值集 `VERDICTS`，归属措辞不是闸）。
- **R632（原 P25-R8）N46 清单 4 → 5 份 + 三层判据**：补 `packages/user-service/test/migration.test.ts:43-44`
  （箭头常量，守卫 `/\/\/[^\n]*/g` **完全没有 `:` 守卫**，实测把 `"http://evil/api/games"` 截成 `"http:`）；
  读数分开报：**A 9 → 6** · **B₂ 补齐后 10 → 7** · **C 8 = 7 实现 + 1 oracle**。
- **R633（原 P25-R9）「谁抓到谁」订正 + 命令必须可原样复制**：修掉「A/B 都抓不到」的假断言（**B₂ 抓得到**；
  只有 C 抓得到的是 **oracle**）；B 的标签改「**B₂ 第二种函数形式** —— 仍是**按名字**的判据」；
  A/B₂ 拆成两条**不含竖线**的 `-E` grep；`:607` 的 grep 补上多出的两处匹配。
- **R634（原 P25-R10）A/B₂/C 命名统一 + 计划三行订正**（`三套语义` → `三种写法 / 两套守卫语义`；
  `两条名字判据都抓不到它` → `A 抓不到 / B₂ 抓得到`；`最糟的` → `与 room-service 同属没有 : 守卫的一类`）。
- ⚠️ **流程事实（记给下一个协调者）**：本片有一条**无关**的 Important finding 来自「review 范围里包含协调者自己的计划 commit」
  （`80bc347`/`811a30a` 被区间法误判为「越权改计划」）⇒ **派复评时必须在派工单里点名哪些 commit 是协调者的**
  （本仓所有 commit 的 git author 相同，区间法无法区分作者）。

## 门禁实测（P25 收口；**零生产代码** ⇒ 中量门禁，R623）

```bash
cd /home/howe/pokergame
git status --short                       # ✅ 只 docs/ 与 apps/client/test/**
pnpm exec turbo run test lint --force    # ✅ 29 successful / 29 total · 0 cached（client 用例数只增不减）
pnpm run ci                              # ✅ 六阶段全部通过（第 6 阶段 = 本片要护的那六条源码闸）
# 形态口径自证（名字无关 + 排除 helper；R625 的教训）
grep -rnE "function strip[A-Za-z]*Comments?\(" apps/client/test --exclude-dir=helpers | wc -l   # 5 → 1
grep -rnE "const strip[A-Za-z]*Comments?\s*=" apps/client/test packages/*/test | wc -l          # ⇒ 1
grep -rnF 'replace(/\/\*[\s\S]*?\*\//g' apps/client/test packages/*/test | wc -l            # 8 = 7 实现 + 1 oracle
grep -c "^  it(" apps/client/test/source-boundary.test.ts                                       # 8 → 23
node scripts/ledger-counts.mjs                                                                  # ✅ 99：97/1/1
```

**明确不跑**（R623）：`build --force`（`test/**` 不进任何产物）· docker · 13 条 conformance · 真浏览器探针 ——
它们**不读 `apps/client/test/**`**，信息量为零；本片 `apps/client/src/**` 与 `packages/**/src/**` **0 行改动**。

**处置分布**：注释盲断言 **7** 条全部改读剥注释视图（+ **15** 条对照 = 23 − 8 条原有 = 7 正 + 7 负 + 1 守卫）·
客户端全 3 规则副本 **4 → 0**（含换名的 `stripSfcComments`）· 跨包 **5 处只登记不修**（N46）。
**台账**：新增 **N46**（仍开放）⇒ §0 **98：97/1/0 → 99：97/1/1**；§3 新增一行（原无该登记，R499 先例）。
**deferred（交最终全分支评审 triage）**：Task 1 的 6 条 Minor（①的不变量是长度代理 · case 1 只断言 `not.toContain` ·
谓词表 2 条是收窄重写 · `:77` 措辞 · 语料分辨率偏薄）· Task 2 的 8 条 Minor（5/7 正对照无法区分剥注释 vs 原始文本 ·
正对照 ⑤ 只复述一条正则 · 负对照是手抄副本（C2 的代价）· 负对照 ④ 只覆盖 5/21 个标识符 · ⑥ 详情信息变少 ·
守卫放错 describe · 守卫前提依赖语料 · ③ 的说明写成 `//` 而非 JSDoc）· Task 3 的 3 条 Minor
（`source-scan.ts:88` 的现在时位置引用 · `fetch(` 例子未并入 · `ui-tokens` 命名读起来是反的）·
Task 4 的 1 条 Minor（N46 行里「241/31」不可复现，因无路径计数会把 `.superpowers/` 自身数进去）·
Task 2 的 1 条 **parked Important**（M3a-1 盲区，R629 裁决接受并已在文件内披露）。

（执行期发现与计划不符时在此追加并编号：本片**协调者区间 R617–R634**。）

---


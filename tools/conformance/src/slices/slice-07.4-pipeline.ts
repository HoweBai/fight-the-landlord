/**
 * conformance 用例：**流水线清点**（spec B1）+ **发布管道静态闸**（片⑦ C21①，K6）。
 *
 * 只读 `.github/workflows/*.yml` 与 `scripts/deploy/` 下的脚本（按**文本**读）——
 * **不碰 docker**，可跑 `--render`（render-gate job 每次 push 都跑它）。
 *
 * 判别力全在三处：
 *   ① 断言写成**集合相等**（不是「包含」）⇒ 多一个工作流、多一个 job、多一个触发分支都会红；
 *   ② 关键 `if` 用**规范化后的恰好相等**（不是子串包含）⇒ `==` 被写成 `!=`（把「仅 push 才构建 /
 *      才跑 conformance」反过来）必须红；合法的 `${{ … }}` 拼法必须仍然过；
 *      ⚠️ `deploy` 的 `if` 是**词项集合**的恰好相等（复评 Important，第二轮从「成员判断」收紧）：
 *      `&&` 拆项、剥括号、排序后与「守卫 2 项 + 两个上游各一条 `success|skipped` 从句」**逐项**
 *      相等 —— 少 `skipped` 半边 = dispatch 回滚路径被静默掐死；**多**一项（如再叠
 *      `needs.images.result == 'success'`，看着像「收紧」）在 dispatch（`images` 是 `skipped`）上
 *      同样把回滚路径掐死 —— 而成员判断（`includes`）放它过去；
 *   ③ **负对照**：合成的 `on: push`、合成的 `needs`、合成的一对 `if` 喂**同一个谓词** ⇒ 必须红。
 *      少了它，解析器把 `on` 读歪（YAML 1.1 的 `on` → `true`）时**没有任何闸会响**。
 *   ④ **C21①（片⑦ K6，本文件末尾）**：`scripts/deploy/deploy.sh` 的「送机 compose = **目标
 *      tag 自己的**」静态闸 —— 谓词 = `tagComposeFetchViolations`（两条性质：按 tag `git show`
 *      且 `if !` 守卫无静默回退；fail-closed `exit 1` 且送机 scp 的源是 `"$COMPOSE_DEPLOY"`）。
 *      判别力自证 = 合成正/负对照 + **真文件变异**（删该段 / 改回送本检出 / 失败静默回退 ⇒ 红）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
// 注释剥离器 = 仓库唯一真源（台账 N46）。本文件此前自建的 `stripJsComments` 副本已删除，
// 三处调用点改用真源 `stripComments`（修复轮 A 收敛；对真源两点已知边界的无害核证见修复轮报告）。
import { stripComments } from '@fight-the-landlord/test-utils';
import { Checks, fieldSetViolations, info, step } from '../lib/assert';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WF_DIR = join(REPO_ROOT, '.github', 'workflows');

/** 工作流文件名的**恰好**集合（R1304 的触发分级落地形态）。⚠️ `deploy.yml` **不得**存在。 */
const EXPECTED_FILES = ['ci.yml', 'conformance.yml', 'images.yml', 'release.yml'];

/** `release.yml` 的 job 名**恰好**集合：串行 = images → conformance → deploy（Task C1 补上 deploy）。 */
const EXPECTED_RELEASE_JOBS = ['conformance', 'deploy', 'images'];

/**
 * 终审 M9：镜像前缀字面量 —— `deploy.sh` / `conformance-stack.sh` / 两个工作流**各写一份**，
 * **没有任何闸**保证它们一致。不一致的后果是**静默**的：tag 路径（拉取刚推好的镜像）验证的镜像
 * 集合与生产部署用的**不是同一批**（一边 `fight-the-landlord`、另一边别的 owner/仓库名）
 * ⇒ 「CI 上验过了」与「生产上跑的是什么」脱钩。
 * ⚠️ 合法写法有**两种**：前缀本身（`IMAGE_PREFIX` 的值），或 `前缀-<svc>[:tag]` 形态的完整镜像名。
 */
const IMAGE_PREFIX_LITERAL = 'ghcr.io/howebai/fight-the-landlord';
/** `ghcr.io/` 之后的路径段（首字符必须是字母数字 ⇒ `ghcr.io/...` 这类省略号不会命中）。 */
const GHCR_PATH = /ghcr\.io\/[A-Za-z0-9][A-Za-z0-9._/-]*/g;

/**
 * 本仓的自建服务名 —— 从 `docker-compose.yml` **派生**（带 `build:` 的服务）：单一真源，
 * 不在这里再抄一份服务清单。
 */
export function buildServices(): string[] {
  const compose = load(readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8')) as any;
  return Object.entries<any>(compose?.services ?? {})
    .filter(([, svc]) => svc?.build !== undefined)
    .map(([name]) => name)
    .sort();
}

/**
 * 谓词：一条 `ghcr.io/…` 路径是否指向本仓（合法写法两种）：
 *   ① 前缀本身（`IMAGE_PREFIX` 的值）；
 *   ② `前缀-<svc>` / `前缀-<svc>:<tag>`（完整镜像名；`<svc>` 必须是那十四个之一）。
 * ⚠️ 为什么 `<svc>` 必须钉住（终审 M9 的**证伪轮**查出来的）：只判「以 `前缀-` 开头」时，
 *    把前缀整个换成**兄弟仓库名**（`…-fight-the-landlord-prod`）照样判绿 —— 而那正是不一致的
 *    真实形态（一次改名/一次复制粘贴就会产生），也是这条判据存在的全部理由。
 */
export function ghcrPathAgrees(path: string, services: string[] = buildServices()): boolean {
  if (path === IMAGE_PREFIX_LITERAL) return true;
  return services.some(
    (svc) => path === `${IMAGE_PREFIX_LITERAL}-${svc}` || path.startsWith(`${IMAGE_PREFIX_LITERAL}-${svc}:`),
  );
}

/**
 * M9 的扫描面：四个工作流 + `scripts/deploy/` 下的**五个**脚本 + `scripts/ops/` 下的**五个** ops 脚本
 * （脚本按**文本**读）。
 *
 * ⚠️ ops 那五个**逐个列出**、**不是** glob（设计 §5 第三轮 Minor 3）：写字面量
 *    `'scripts/ops/*.sh'` 会让 `readFileSync` 直接 `ENOENT` 抛错（响亮，但红得莫名其妙）。
 *    ⇒ 加扫描面时**必须**与新脚本在**同一个提交**里落地（否则那一个提交上扫描必红）。
 *    **判据只增不减**：这是加扫描面，不是放宽 —— 加进来之后，**一致的**镜像引用照旧合法、
 *    **不一致**的才红（那正是 M9 存在的意义；`restore.sh` 里那份前缀字面量正靠这条看着）。
 */
const PREFIX_FILES = [
  ...EXPECTED_FILES.map((f) => `.github/workflows/${f}`),
  'scripts/deploy/build-images.sh',
  'scripts/deploy/conformance-stack.sh',
  'scripts/deploy/deploy.sh',
  'scripts/deploy/deploy-dev.sh',
  'scripts/deploy/rollback.sh',
  'scripts/ops/backup.sh',
  'scripts/ops/restore.sh',
  'scripts/ops/install-cron.sh',
  'scripts/ops/restore-drill.sh',
  'scripts/ops/check-backup-fresh.sh',
];

function readWorkflow(file: string): any {
  return load(readFileSync(join(WF_DIR, file), 'utf8'));
}

/**
 * 标量 / 数组两种 YAML 写法归一化成「排序后的字符串数组」；键**缺席** ⇒ `null`（= 没写这个过滤）。
 * ⚠️ 与 `needsOf` 收的形态必须**一致**：此前只有 `needsOf` 收标量、`push.branches` 只收数组 ——
 *    两种写法一严一宽是本仓付过代价的陷阱形态（不均等 ⇒ 换个合法拼法判据就静默变空测/假红）。
 */
export function asSortedList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  return (Array.isArray(v) ? v : [v]).map(String).sort();
}

/**
 * 取 `on` 的**规范化**形态。⚠️ 三种写法在 YAML 里等价、在 JS 里不等价：
 *   `on: [push, pull_request]`（数组）· `on: push`（字符串）· `on: {push: {...}}`（对象）。
 * 不归一化就会把「写法不同」误报成「触发不同」。
 */
export function onShape(on: unknown): { events: string[]; pushBranches: string[] | null; pushTags: string[] | null; dispatch: boolean } {
  if (typeof on === 'string') return { events: [on], pushBranches: null, pushTags: null, dispatch: false };
  if (Array.isArray(on)) return { events: [...on].map(String).sort(), pushBranches: null, pushTags: null, dispatch: false };
  const obj = (on ?? {}) as Record<string, any>;
  const push = obj.push ?? {};
  return {
    events: Object.keys(obj).sort(),
    pushBranches: asSortedList(push?.branches),
    pushTags: asSortedList(push?.tags),
    dispatch: 'workflow_dispatch' in obj,
  };
}

/** `jobs.<name>.needs` 归一化成排序后的数组（字符串与数组两种写法都收）。 */
export function needsOf(job: any): string[] {
  const n = job?.needs;
  if (n === undefined || n === null) return [];
  return (Array.isArray(n) ? n : [n]).map(String).sort();
}

/**
 * `if` 的**规范化**：剥掉 `${{ … }}` 外壳、折叠空白 ⇒ `${{ github.event_name == 'push' }}` 与
 * `github.event_name == 'push'` 等价。**只**做「同一写法的两种拼法」，不做算术/逻辑化简。
 *
 * ⚠️ 为什么必须两头都对：裸的**恰好相等**会把合法的 `${{ }}` 拼法误杀（假红 ⇒ 最诱人的「修法」
 *    是删判据）；**子串包含**又会把 `==` 反转成 `!=` 放过去（真红变假绿 —— B4 复评 🔴）。
 */
export function normIf(v: unknown): string {
  return String(v ?? '')
    .replace(/\$\{\{/g, '')
    .replace(/\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 「**仅 push** 才跑」的 `if` 的规范形态（`release.yml` 的 `images` 与 `conformance` 共用一份）。 */
const PUSH_ONLY_IF = "github.event_name == 'push'";

/**
 * `deploy` 的 `if` 里每个上游的**恰好**从句（`success | skipped`，逐字）。
 *
 * ⚠️ 复评 Important：`deploy` 的 `if` 此前用**前缀子串**检查（`includes('needs.images.result')`）
 *    ⇒ 两种静默漏网：① 把 `|| needs.<job>.result == 'skipped'` 删掉（看似「收紧」）⇒ **回滚路径
 *    被静默掐死**（dispatch 上 conformance 是 `skipped`，少了这半边 `deploy` 整条不进）；
 *    ② `==` 反转成 `!=` ⇒ **失败**的上游也被放行。⇒ 收紧成这两个从句的逐字恰好相等。
 */
export function upstreamResultClause(job: string): string {
  return `needs.${job}.result == 'success' || needs.${job}.result == 'skipped'`;
}

/**
 * `deploy` 的 `if` 拆项后应有的**全部**词项：守卫 2 项 + 两个上游各一条从句 = 恰好 4 项。
 * ⚠️ 这是**集合**（不是「至少包含」）：多一项也红 —— 见 `sameTermSet`。
 */
export const DEPLOY_IF_TERMS = [
  'always()',
  '!cancelled()',
  upstreamResultClause('images'),
  upstreamResultClause('conformance'),
];

/**
 * 「词项集合**相等**」谓词：两边**排序后**逐项比较 ⇒ **多一个词项也红**。
 *
 * ⚠️ 复评 Important（第二轮）：成员判断（`includes`）只证明「该在的都在」，放得住**多余**子句。
 *    具体漏网：往 `deploy` 的 `if` 追加 `&& needs.images.result == 'success'`（看着像「收紧」）
 *    ⇒ 实际表达式 `(success || skipped) && success`；dispatch 路径上 `images` 是 **skipped**
 *    ⇒ `deploy` 整条被跳过 ⇒ **回滚路径被静默掐死**，而成员判断照样 28/28 全绿。
 *    ⇒ 与 `jobs.images?.if` 的 `normIf(…) === PUSH_ONLY_IF` 对齐：改成集合相等。
 * ⚠️ **排序后**比较（不是原序）⇒「同集合、不同次序」这种合法改写不假红；
 *    真实断言与负/正对照**共用它**（R115：判据的判别力用合成输入自证）。
 */
export function sameTermSet(as: readonly string[], bs: readonly string[]): boolean {
  return JSON.stringify([...as].sort()) === JSON.stringify([...bs].sort());
}

/**
 * 把 `normIf` 之后的 `if` 拆成顶层 ` && ` 项、剥掉每项的一层外层括号 ⇒ 逐项**恰好**比较。
 * ⚠️ 两个从句的括号里只有 `||`（没有顶层 `&&`）⇒ 这个拆分不会把它们拆散 —— 判据依赖这一点。
 */
export function andTerms(normalizedIf: string): string[] {
  return normalizedIf
    .split(' && ')
    .map((t) => t.trim().replace(/^\((.*)\)$/, '$1').trim());
}

/**
 * Task 6：`release.yml` 的 `deploy` job 里那三步**备份接线**必须满足的**性质**。
 *
 * 返回违例清单（空数组 = 全部满足）。**唯一一份实现**：真断言与合成负/正对照共用它
 * （R115：判据的判别力用合成输入自证，而不是再写一个「差不多的」比较器）。
 * 判的全是**性质**、不是步骤名 —— 名字可以改，性质不行：
 *
 *   ① 调 `check-backup-fresh.sh` 的那一步**恰好一个**、且是 job 的**最后一步**。
 *      手册「备份还活着吗」那一节（`first-deploy.md` 同名节；货币片 T11：原引行号 `:869`
 *      早已随手册生长漂移 —— 照 M1 先例改引**节名**）明写它是「发布流水线**最后一步**」；
 *      而它前面那一步（C4 收尾断言）带 `if: always()` ⇒ 放错位置时手册的预期**不可能发生**
 *      —— 本仓点名的复发缺陷形态就是「手册的预期读数和真实形态不一致」。
 *   ② 那一步的 `if` 必须**仅 push**（与 `images`/`conformance` 同一个谓词）：dispatch 那条
 *      回滚路径要把备份相关的一切**整条跳过**（设计 §3.1：「别让与本次操作无关的备份问题把它弄红」）。
 *   ③ 调 `install-cron.sh` 的那一步同样**恰好一个**、`if` **仅 push**，且排在跑 `deploy.sh` 的
 *      那一步**之前**（设计 §3.1 的 ①②→④ 顺序；手册「每次发布时核对安装」）。
 *      ⛔ 它（和整个投递面）都**不许**落进 `deploy.sh` 的 rc 路径 —— `deploy.sh:243` 在**任何**
 *      非零退出时都打印「❌ 部署失败。回滚命令…」，一条备份问题会把**刚发上去的好版本**撤下来。
 *   ④ 调 `backup.sh` 的那一步（**首跑**）**恰好一个**、`if` **仅 push**、排在跑 `deploy.sh` 的
 *      那一步**之后**，且带**「仅当还没有 `ok:true` 的 manifest」这个限定词**（文本钉子）。
 *      · **次序**（第一轮修复轮 C1）：首跑要 `docker exec` 进 **ftl-mysql** —— 排在部署之前时，
 *        首次发布那一刻栈还没起来 ⇒ 它必红；而 `部署` 那一步没有 `if:`、带**隐式 `success()`**
 *        ⇒ 前一步红它就被**跳过** ⇒ 栈永远起不来、重跑复现同一状态 = **首次发布死锁**。
 *      · **限定词**：无条件每次发布都跑一次，会在新鲜度那一步**之前**刚造出一份新鲜的 manifest
 *        ⇒ **新鲜度判据在 push 路径上永远不可能红** —— 「判据存在 ≠ 判据有效」。
 *        限定词是判据的一部分，不是优化（设计 §3.1 性质 1，第三轮 Critical）。
 */
export function backupWiringViolations(steps: readonly unknown[]): string[] {
  const v: string[] = [];
  const runs = steps.map((st) => {
    const r = (st as { run?: unknown } | null)?.run;
    return typeof r === 'string' ? r : '';
  });
  const ifOf = (i: number): unknown => (steps[i] as { if?: unknown } | null)?.if;
  // ⚠️ 按**调用形态**认那一步，不按文件名认（第一版就是这么写坏的、当场红：`run:` 体的中文注释里
  //    提一句 `check-backup-fresh.sh` 也算命中 ⇒ 命中的是「提到它的那一步」而不是「跑它的那一步」）。
  //    正则要求 `bash <路径>/<名字>` ⇒ 只有**真的执行**它的那一步才算。
  const idxOf = (re: RegExp): number[] =>
    runs.map((r, i) => (re.test(r) ? i : -1)).filter((i) => i >= 0);
  const where = (i: number): string => `第 ${i + 1}/${runs.length} 步`;
  // 「跑 `deploy.sh`」的那一步（部署本身；`--assert-clean` 是收尾断言那一步，不算）。
  const deployIdx = runs.findIndex((r) => r.includes('scripts/deploy/deploy.sh') && !r.includes('--assert-clean'));
  if (deployIdx < 0) {
    v.push('找不到「跑 `scripts/deploy/deploy.sh`」的那一步 —— 投递+装 cron 与首跑的**次序**判据都指着它');
  }
  // ⚠️ 限定词钉子：要**同一行**里既出现 manifest 的 glob、又出现 `ok:true` 的判定 —— 把两者拆到两行
  //    （例如 glob 放进一行、判定写成旁边一句注释）会让这条钉子退化成**空测**（第一版就是这样被
  //    中文注释喂饱的：实测删掉判定、只留注释，照样判齐）。首跑那一步与它共用这一个谓词。
  const lacksQualifier = (i: number): boolean => {
    const guardLine = runs[i].split('\n').find((l) => l.includes('manifest-[0-9]*.json'));
    return guardLine === undefined || !/ok["\\:]*true/.test(guardLine);
  };
  const QUALIFIER_MSG =
    '「立刻跑一次备份」必须带**「仅当还没有 ok:true 的 manifest」的限定词**（同一行里：' +
    'manifest 的 glob + `ok:true` 的判定）—— 无条件每次发布都跑一次 ⇒ 新鲜度判据在 push 路径上' +
    '**永远不可能红** = 用户裁决 5 的整个机制作废（第三轮 Critical）';

  const fresh = idxOf(/bash\s+\S*check-backup-fresh\.sh/);
  if (fresh.length !== 1) {
    v.push(`**跑** \`check-backup-fresh.sh\` 的 step 必须**恰好一个**（实际 ${JSON.stringify(fresh)}；` +
      '「提到」不算 —— 只认 `bash …/check-backup-fresh.sh` 这种调用形态）');
  } else {
    if (fresh[0] !== steps.length - 1) {
      v.push(`新鲜度那一步必须是 \`deploy\` job 的**最后一步**（手册 :869 明写「那次发布会**在最后一步红**」）` +
        ` —— 实际在 ${where(fresh[0])}`);
    }
    if (normIf(ifOf(fresh[0])) !== PUSH_ONLY_IF) {
      v.push(`新鲜度那一步必须 \`if: ${PUSH_ONLY_IF}\`（dispatch 回滚路径要整条跳过它）` +
        ` —— 实际 ${JSON.stringify(ifOf(fresh[0]))}`);
    }
  }

  const cron = idxOf(/bash\s+\S*install-cron\.sh/);
  if (cron.length !== 1) {
    v.push(`**跑** \`install-cron.sh\` 的 step 必须**恰好一个**（实际 ${JSON.stringify(cron)}）` +
      '（投递 + 装 cron 是**一个** step：两步的主语是同一次 ssh 连接，拆开只会多两处失败面）');
  } else {
    const i = cron[0];
    if (normIf(ifOf(i)) !== PUSH_ONLY_IF) {
      v.push(`投递+装 cron 那一步必须 \`if: ${PUSH_ONLY_IF}\`（dispatch 回滚不许跑它）` +
        ` —— 实际 ${JSON.stringify(ifOf(i))}`);
    }
    if (deployIdx >= 0 && i > deployIdx) {
      v.push(`投递+装 cron 必须在跑 \`deploy.sh\` 的那一步**之前**（设计 §3.1 的 ①②→④ 顺序）` +
        ` —— 实际 ${where(i)}，而 deploy 在 ${where(deployIdx)}`);
    }
  }

  // ── 首跑（第三件动作）：次序 + push 闸 + 限定词（C1 之后它**独立成步**、排在部署之后）──────
  const first = idxOf(/bash\s+\S*backup\.sh/);
  if (first.length !== 1) {
    v.push(`**跑** \`backup.sh\` 的那一步（首跑）必须**恰好一个**（实际 ${JSON.stringify(first)}；` +
      '「提到」不算 —— 只认 `bash …/backup.sh` 这种调用形态）');
  } else {
    const i = first[0];
    if (normIf(ifOf(i)) !== PUSH_ONLY_IF) {
      v.push(`首跑那一步必须 \`if: ${PUSH_ONLY_IF}\`（dispatch 回滚不许跑它）` +
        ` —— 实际 ${JSON.stringify(ifOf(i))}`);
    }
    if (deployIdx >= 0 && i < deployIdx) {
      v.push('「首次立刻跑一次备份」必须在跑 `deploy.sh` 的那一步**之后**（**C1**：它要 ' +
        '`docker exec` 进 **ftl-mysql** —— 栈还没起来时它必红（`No such container`），而 `部署` ' +
        '那一步没有 `if:`、带隐式 `success()` ⇒ 前一步红它就被**跳过** ⇒ 栈永远起不来、重跑复现' +
        '同一个状态 = **首次发布死锁**）' +
        ` —— 实际 ${where(i)}，而 deploy 在 ${where(deployIdx)}`);
    }
    if (lacksQualifier(i)) v.push(QUALIFIER_MSG);
  }
  return v;
}

/**
 * 合成输入用的「一条合规的接线」——正/负对照都从它出发，只改一处（R115 的写法）。
 *
 * ⚠️ 与真文件同形（C1 之后）：**投递+装 cron 在部署之前**、**首跑在部署之后**、新鲜度最后。
 *    四段拆成具名常量 ⇒ 负对照只要重排这个数组（顺序本身就是被判的性质之一）。
 */
const SYNTH_DELIVER: unknown = {
  name: '装备份（投递 + 装 cron）', if: PUSH_ONLY_IF,
  run: 'bash /home/ubuntu/ftl-ops/install-cron.sh',
};
const SYNTH_DEPLOY: unknown = {
  name: '部署（或回滚）', run: 'bash scripts/deploy/deploy.sh "$IMAGE_TAG"',
};
const SYNTH_FIRST_BACKUP: unknown = {
  name: '首次备份（仅当还没有 ok:true 的 manifest）', if: PUSH_ONLY_IF,
  run: 'ls /home/ubuntu/ftl-backups/manifest-[0-9]*.json 2>/dev/null | grep -q ok:true || bash /home/ubuntu/ftl-ops/backup.sh',
};
const SYNTH_FRESH: unknown = { name: '新鲜度', if: PUSH_ONLY_IF, run: 'bash scripts/ops/check-backup-fresh.sh' };
const SYNTH_OK_STEPS: readonly unknown[] = [SYNTH_DELIVER, SYNTH_DEPLOY, SYNTH_FIRST_BACKUP, SYNTH_FRESH];

/** 合成投递面①（**正对照**）：与真文件同形的合规投递 —— 带续行、带 `-i`/`-o` 旗标。 */
const SYNTH_DELIVERY_OK =
  'scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \\\n' +
  '  scripts/ops/backup.sh scripts/ops/restore.sh scripts/ops/install-cron.sh \\\n' +
  '  "$TARGET:/home/ubuntu/ftl-ops/"';
/** 合成投递面②（**负对照**）：同一条命令上多塞一个 `restore-drill.sh`（M3 说的真形态）。 */
const SYNTH_DELIVERY_WITH_DRILL =
  'scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \\\n' +
  '  scripts/ops/backup.sh scripts/ops/restore.sh scripts/ops/install-cron.sh scripts/ops/restore-drill.sh \\\n' +
  '  "$TARGET:/home/ubuntu/ftl-ops/"';
/**
 * 合成投递面③（**负对照②**）：**合法**但**不是**投递命令的两行 —— M3 点名的陷阱形态。
 * 它们**真的**出现在 `release.yml` 那几步的 run 体里（`deliveryText` 正是把所有 run 体拼起来的），
 * 拿整段文本当投递面时这两个名字会被判成「多投的文件」= 假红。
 */
const SYNTH_RUNNER_SIDE =
  'bash scripts/ops/check-backup-fresh.sh\n' +
  'ssh "$TARGET" \'chmod 700 /home/ubuntu/ftl-ops/*.sh\'';

/**
 * M3（第一轮修复轮）：投递到 `/home/ubuntu/ftl-ops/` 的**允许名单** —— 恰好三个
 * （手册 `:845` 让读者 `ls /home/ubuntu/ftl-ops/` 看到**恰好**这三个）。
 */
export const FTL_OPS_ALLOWED: readonly string[] = ['backup.sh', 'install-cron.sh', 'restore.sh'];

/** 投递命令的动词：只有这些算「投递」（`ssh … chmod` / `bash …/check-backup-fresh.sh` 不算）。 */
const DELIVERY_VERB = /^(scp|rsync|cp|install)$/;

/** 带 `\` 续行的**逻辑行**（`scp … \` + `  … ftl-ops/` 是**一条**命令；按物理行看会整条漏掉）。 */
export function logicalLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.endsWith('\\')) out[out.length - 1] = `${prev.slice(0, -1)} ${raw}`;
    else out.push(raw);
  }
  return out;
}

/**
 * M3：**投递命令**里落到 `/home/ubuntu/ftl-ops/` 的**文件名**集合（去重、排序）。
 *
 * 为什么要它（第一轮评审 M3）：此前的投递面断言只问「那三个名字**出现**过没有」——
 * `restore-drill.sh` / `check-backup-fresh.sh` 后来被加进一条 `scp … ftl-ops/` 行时**没有任何东西会响**，
 * 而那条断言自己的文案引用的正是手册 `:845`「`ls` 应当**恰好**三个脚本」这句承诺。
 *
 * ⚠️ **扫描面被限定在投递命令上**（动词 ∈ scp/rsync/cp/install，且该行出现 `ftl-ops/`），
 *    ⛔ **不是**整段 run 体：runner 侧真跑的 `bash scripts/ops/check-backup-fresh.sh` 与
 *    `ssh … 'chmod 700 /home/ubuntu/ftl-ops/*.sh'` 都是**合法**形态 —— 拿整段文本当投递面
 *    会把这二者判成「多投的文件」（假红，而假红的修法通常是删判据）。
 * ⚠️ 只收**带扩展名**的词：`-i "$SSH_KEY"` / `-o StrictHostKeyChecking=accept-new` 这类旗标与
 *    它们的值在同一条命令里，不收的话 `$SSH_KEY` 会被当成「多投了一个文件」。
 */
export function ftlOpsDeliveredNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of logicalLines(text)) {
    const toks = line.trim().split(/\s+/).filter((t) => t !== '');
    if (toks.length === 0) continue;
    if (!DELIVERY_VERB.test(toks[0].replace(/^.*\//, ''))) continue;   // 只认投递命令
    if (!toks.some((t) => t.includes('ftl-ops/'))) continue;           // 目标必须落在 ftl-ops/ 下
    for (const t of toks.slice(1)) {
      if (t.startsWith('-') || t.includes('ftl-ops/')) continue;       // 旗标 / 目标本身
      const m = /(?:^|\/)([^/\s]+\.[A-Za-z0-9]+)$/.exec(t.replace(/["']/g, ''));
      if (m !== null) names.add(m[1]);
    }
  }
  return [...names].sort();
}

/** 违例 = 投递面里那三个**之外**的任何文件名（空数组 = 恰好那三个）。 */
export function ftlOpsDeliveryViolations(text: string): string[] {
  return ftlOpsDeliveredNames(text).filter((n) => !FTL_OPS_ALLOWED.includes(n));
}

/**
 * **C21①（片⑦ K6 / spec §3 C21 的静态半边）**：`deploy.sh`「送机 compose = **目标 tag
 * 自己的**」的源扫描闸。返回违例清单（空数组 = 全部满足）；真断言与合成正/负对照**共用
 * 这一个谓词**（R115 的写法）。
 *
 * 两条**性质**（不是步骤名）：
 *   ① **按 tag 取**：必须存在 `git show "refs/tags/${TAG}:docker-compose.yml"` 这一行，由
 *      `if !` 守卫（取不到 ⇒ 进入分支），且该行**不得**带 `|| …` 静默回退 —— `|| true` 吞掉
 *      失败、`|| cp docker-compose.yml …` 回退本检出，两个都会把「取不到」伪装成「取到了」。
 *   ② **fail-closed 且送的就是它**：`if !` 分支体（到 `fi` 为止）里必须 `exit 1`（拒绝继续）；
 *      把 `docker-compose.yml` 送到 `$REMOTE_DIR/` 的那条 `scp` 的**源**必须是
 *      `"$COMPOSE_DEPLOY"`（tag 取出的临时文件）—— ⛔ 不许是仓库本检出的同名文件。
 *
 * 替代错实现（本闸拦的正是它们）：**回滚送 master compose**（拉不存在的 `config-service:旧tag`，
 * r2 实测根因）· 取不到 tag 时**静默回退本检出**。
 *
 * 判别力自证（R115）：除合成对照（正对照 + 三个负对照，均在调用处）外，验收时另做过
 * **真文件变异**——把 deploy.sh 的取 tag 段**改回送本检出** ⇒ 本判据红 ⇒ 复原。
 * ⚠️ 形态**逐字钉住**（`if ! …; then … exit 1; fi` 是本仓现状写法）：合法替代形态
 * （如 `|| { …; exit 1; }`）若出现，改**判据**并在此登记，⛔ 不许弱化回「子串包含」。
 */
export function tagComposeFetchViolations(text: string): string[] {
  const v: string[] = [];
  const lines = text.split('\n');
  const gi = lines.findIndex((l) => l.includes('git show "refs/tags/${TAG}:docker-compose.yml"'));
  if (gi < 0) {
    return [
      '找不到 `git show "refs/tags/${TAG}:docker-compose.yml"` —— 送机 compose 必须取自**目标 tag**' +
        '（「改回送本检出」= 修前形态：回滚送 master compose ⇒ 拉不存在的 config-service:旧tag）',
    ];
  }
  const head = lines[gi].trim();
  if (!head.startsWith('if !')) {
    v.push(`取 tag 的那行必须处在 \`if !\` 守卫里（取不到要进分支 ⇒ fail-closed）—— 实际：${head}`);
  }
  if (head.includes('||')) {
    v.push(`取 tag 的那行**不得**带 \`||\` 兜底（\`|| true\` 吞掉失败 / \`|| cp …\` 静默回退本检出）—— 实际：${head}`);
  }
  // 分支体：从取 tag 行的下一行起、到第一个 `fi` 为止（上界 10 行 —— 防合法注释把窗口撑破）。
  let hasExit1 = false;
  let closed = false;
  for (const l of lines.slice(gi + 1, gi + 11)) {
    if (l.trim() === 'fi') {
      closed = true;
      break;
    }
    if (/^\s*exit\s+1\s*;?\s*$/.test(l)) hasExit1 = true;
  }
  if (!hasExit1) {
    v.push('`if !` 分支体（到 `fi` 为止）里必须 `exit 1`（fail-closed：取不到 tag 的 compose 就拒绝继续）');
  }
  if (!closed) v.push('`if !` 分支没有被 `fi` 收住（判据扫不到明确的分支体）');
  // 「谁被送机」：送到 `$REMOTE_DIR/docker-compose.yml` 的那条 scp 的源必须是 $COMPOSE_DEPLOY。
  const sends = lines.filter((l) => /\bscp\b/.test(l) && l.includes('$REMOTE_DIR/docker-compose.yml'));
  if (sends.length === 0) {
    v.push('找不到把 docker-compose.yml 送到 `$REMOTE_DIR/` 的 scp 行（判据要盯住送的是哪个**源**）');
  } else {
    for (const l of sends) {
      if (!l.includes('"$COMPOSE_DEPLOY"')) {
        v.push(`送 compose 的 scp 源必须是 \`"$COMPOSE_DEPLOY"\`（tag 取出的临时文件）—— 实际：${l.trim()}`);
      }
    }
  }
  return v;
}

/**
 * `scripts/deploy/deploy-dev.sh`（dev 分支 → 开发测试服的**一条命令**封装，2026-10-15 用户拍板）
 * 的静态闸。两条性质：
 *   ① **调用正典脚本**：构建走 `build-images.sh`、部署走 `deploy.sh` —— 两者各自是配方的唯一真源
 *      （`build-images.sh` 头部注释写明 `images.yml`/`release.yml` 都调它）；在 deploy-dev.sh 里
 *      **重实现**任何一步 = 「同一事实两处实现」再犯一次，本仓为这个形态付过多次代价。
 *   ② tag 构造只用 `dev-` 前缀：`v*` 会触发 `release.yml` 发布链（≈41 分钟额度 + 走 CI 部署路径
 *      —— 那是「上线」动作，不是「部署到测试服」）。
 * ⚠️ 匹配前先 `stripHashLines`（提到 ≠ 执行——头部注释里允许自由提及脚本名）。
 * ⚠️ 形态**逐字钉住**（`TAG="dev-$…"` 是本仓现状写法）：合法替代形态出现时改**判据**并在此登记，
 *    ⛔ 不许弱化回「子串包含」—— `deploy.sh` 正是 `deploy-dev.sh` 的名字**前缀**形态，
 *    松匹配会被自己骗过（`replace('deploy.sh','…')` 会把 `deploy-dev.sh` 一起改掉的那种骗法）。
 */
export function deployDevViolations(text: string): string[] {
  const v: string[] = [];
  const code = stripHashLines(text);
  if (!/scripts\/deploy\/build-images\.sh(?![\w.-])/.test(code)) {
    v.push('找不到对 `scripts/deploy/build-images.sh` 的调用 —— 构建必须走正典配方（重实现 = 配方分叉成两处实现）');
  }
  if (!/scripts\/deploy\/deploy\.sh(?![\w.-])/.test(code)) {
    v.push('找不到对 `scripts/deploy/deploy.sh` 的调用 —— 部署必须走正典入口');
  }
  const ctors = code.split('\n').filter((l) => /^\s*TAG=/.test(l));
  if (ctors.length === 0) {
    v.push('找不到 `TAG=…` 的 tag 构造行 —— 判据要盯住**前缀**才能防 `v*` 触发 release 链');
  }
  for (const l of ctors) {
    if (!/^\s*TAG="dev-\$/.test(l)) {
      v.push(`tag 构造行必须是 \`TAG="dev-$\` 形态（\`v*\` 前缀会触发 release.yml 发布链）—— 实际：${l.trim()}`);
    }
  }
  return v;
}

// ── M0.1：安全扫描接线判据（C1–C25；真断言与合成对照共用一族谓词）────────────────
// ⚠️ 合成夹具内的字面量一律**运行时拼接**（C6⑤ 会全仓扫这些字面量；源码不得落连续字面量）。
// C6⑤ 的跳列在调用点（Step 4）给出：node_modules / .git / .superpowers / .worktrees / test-results /
// dist / .pnpm-store / tools/conformance / docs/superpowers（**前缀判定**——不跳整个 docs）。
// ⚠️ 跳列按「相对路径前缀」判定：顶层命中即跳；嵌套 dist（如 packages/protocol/dist）仍会被扫——现语义，登记（R6 观测项）。

// ── 实现取舍与说明（Step 3 先记下的三条，与 `tagComposeFetchViolations` 同法）──────
// （a）若扫描器步骤识别在真文件上因多行 YAML 折行假红/假绿，可把识别放宽为「逻辑行拼接后」——但必须保持
//     C22（正对照）与 C2 的正/负两向；放宽须在注释登记「合法替代形态」，与 tagComposeFetchViolations 同法。
// （b）tokens 提取正则假设脚本文本以单引号写数组与 LEVELS——真文件即以骨架为准（写脚本时保持单引号）。
// （c）C6① 的「作用域行」在真文件里是含 `/tmp/gitleaks` 的那一行（joinContinuations 已把 `curl` 等行排除在外，
//     因为它们不含 `gitleaks detect` 的词元对——若未来把 detect 写进 curl 行 ⇒ 定位会偏，届时按 (a) 登记后修）。

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
  const code = stripComments(scriptText);
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
  if (stripComments(inp.scriptText).includes('--ignore-registry-errors')) v.push('脚本出现禁旗标（C3③）');
  if (!at.hasExceptionsPath) v.push('脚本未引用 audit-exceptions.json 路径（C3④）');
  // C4：豁免文件
  let exemptions: any[] = [];
  try { exemptions = JSON.parse(inp.exceptionsJson); } catch { v.push('豁免文件不是合法 JSON（C4）'); }
  // pin 条目/顺序照实况文件；T18 全序真红修复：+`1241259 @vue/server-renderer`（源 = 支付片 59105ef 遗留——增豁免 #3 时未同轮同步本 pin；.superpowers/sdd/task-18-report.md 异议 1）
  const wantEx = [{ id: 1241259, module: '@vue/server-renderer' }, { id: 1123525, module: 'vite' }, { id: 1240992, module: 'braces' }];
  if (exemptions.length !== wantEx.length || exemptions.some((e) => typeof e.id !== 'number' || !e.module || !e.reason || !e.reviewTrigger)) {
    v.push(`豁免条目必须恰 ${wantEx.length} 条且四字段非空、id 为 number（C4）`);
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
  // T18 全序真红修复：5→7（源 = 本片 T17 79fcfdb 补列 +2 条 path 型允许清单时未同轮同步本 pin；.superpowers/sdd/task-18-report.md 异议 1）
  // T20 广告片：7→8（源 = 本片 T20 按规格 §5.4 登记第 8 条——ad-callback 测试密钥夹具目录；同轮同步）
  if (topAllow !== 8) v.push(`[[allowlists]] 行首计数 = ${topAllow}（须恰好 8；C6③）`);
  if (!tomlCode.includes("'''packages/shared/src/logging/redact\\.test\\.ts$'''")) v.push('path 条目 ≠ 带 $ 锚定的登记字面量（C6③）');
  if (!tomlCode.includes("'''dev-internal-token-change-in-production'''")) v.push('regex 条目 ≠ 登记字面量（C6③）');
  if (!tomlCode.includes("'''packages/alert-relay/test/(sign|sinks|server)\\.test\\.ts$'''")) v.push('第三条 path 条目 ≠ 带 $ 锚定的登记字面量（C6③，v3.3）');
  if (!tomlCode.includes("'''packages/payment-service/test/fixtures/alipay/keys\\.json$'''")) v.push('第四条 path 条目 ≠ 带 $ 锚定的登记字面量（C6③，v3.4 支付片 T6）');
  if (!tomlCode.includes("'''tools/conformance/fixtures/alipay-test/'''")) v.push('第五条 path 条目 ≠ 登记字面量（C6③，v3.5 支付片 T16；**目录锚定**）');
  // T20 审查 M2：#6（notify-channel，T17 补列）补逐字 pin —— 使规格 §2.3「path 条目 = 逐字 pin」对 #6 也成立
  if (!tomlCode.includes("'''packages/config-service/test/notify-channel\\.(controller|metrics|service|crypto)\\.test\\.ts$'''")) v.push('第六条 path 条目 ≠ 带 $ 锚定的登记字面量（C6③，T17 补列；v3.6 补登记）');
  if (!tomlCode.includes("'''packages/config-service/test/(config\\.rpc|(pay|ad)-channel\\.(controller|crypto|service|validators))\\.test\\.ts$'''")) v.push('第七条 path 条目 ≠ 带 $ 锚定的登记字面量（C6③，v3.6 广告片 T20 邻接扩面：pay/ad-channel 测试族同一主钥字面量）');
  if (!tomlCode.includes("'''tools/conformance/fixtures/ad-callback/'''")) v.push('第八条 path 条目 ≠ 登记字面量（C6③，v3.6 广告片 T20；**目录锚定**）');
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
  const pkgCode = stripComments(inp.rootPkgJson);
  for (const k of ['auditConfig', 'ignoreCves', 'ignoreGhsas']) if (pkgCode.includes(k)) v.push(`root package.json 出现禁键 ${k}（C10）`);
  return v;
}

export async function runSlice074Pipeline(): Promise<Checks> {
  const checks = new Checks();

  step('B1 工作流清点：文件集合 · 触发分级 · release 的串行');
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  info(`.github/workflows 下实际文件：${files.join(', ')}`);
  checks.that(
    JSON.stringify(files) === JSON.stringify(EXPECTED_FILES),
    `工作流文件**恰好**这四个（不得有 \`deploy.yml\` —— 部署必须收在 release.yml 里用 needs 串行）` +
      ` —— 实际 ${JSON.stringify(files)}`,
  );

  // ── ci.yml：push→master / pull_request / 手动（2026-10-15 用户口径的触发分级）────────
  //    ⚠️ 修订史（判据与策略同步的那一次）：此前 = `on: [push, pull_request]`（**任意分支**推送
  //    都跑）。用户 2026-10-15 拍板收窄（提交 `20645a4`），但那次只跑了 admin 静态闸、没跑本片，
  //    且 dev 推送零 CI（**正是这条策略的效果**）⇒ 本片带着一条红在 dev 上过了夜，本次实跑才撞上。
  //    ⇒ 断言改写为新口径的三条性质（集合相等不变、只增不减）：
  //      P1 事件集合恰为 {push, pull_request, workflow_dispatch}；
  //      P2 **push 只认 master** —— 「开发分支随推零 CI」这条负载性质全靠它（**新加**；
  //         少了它，把 branches 过滤删掉/放宽不会有任何东西响，而额度会照烧）；
  //      P3 **手动入口在场**（收窄后的补偿入口：`gh workflow run ci.yml --ref dev` —— 工作流注释
  //         里的这句承诺在这里拿到机械语义；同 conformance.yml 那条 `dispatch === false` 的镜像）。
  const ci = readWorkflow('ci.yml');
  const ciOn = onShape(ci.on);
  checks.that(
    JSON.stringify(ciOn.events) === JSON.stringify(['pull_request', 'push', 'workflow_dispatch']),
    `ci.yml 触发恰为 {push, pull_request, workflow_dispatch}（2026-10-15 口径：push 分级到 master、` +
      `PR 快筛、手动入口 \`gh workflow run ci.yml --ref dev\`）—— 实际 ${JSON.stringify(ciOn.events)}`,
  );
  checks.that(
    JSON.stringify(ciOn.pushBranches) === JSON.stringify(['master']),
    `ci.yml 的 push **只**跑 master（「开发分支（\`dev\`）随推零 CI」是开发工作流的负载性质）` +
      ` —— 实际 push.branches = ${JSON.stringify(ciOn.pushBranches)}`,
  );
  checks.that(
    ciOn.dispatch === true,
    `ci.yml 必须保留 workflow_dispatch（收窄后的**补偿入口**：需要时 \`gh workflow run ci.yml --ref dev\` ` +
      `手动跑一次）—— 实际 workflow_dispatch = ${JSON.stringify(ciOn.dispatch)}`,
  );
  checks.that(
    'render-gate' in (ci.jobs ?? {}),
    `ci.yml 必须有第二个 job \`render-gate\`（R1309①：纯渲染判据**每次 push（到 master）**都跑；` +
      `2026-10-15 收窄后 dev 推送不跑——需要时手动 dispatch）` +
      ` —— 实际 jobs = ${JSON.stringify(Object.keys(ci.jobs ?? {}))}`,
  );

  // ── images.yml：**只** push→master（feature 分支不跑）────────────────
  const images = readWorkflow('images.yml');
  const imagesOn = onShape(images.on);
  checks.that(
    JSON.stringify(imagesOn.events) === JSON.stringify(['push']),
    `images.yml 触发恰为 {push} —— 实际 ${JSON.stringify(imagesOn.events)}`,
  );
  checks.that(
    JSON.stringify(imagesOn.pushBranches) === JSON.stringify(['master']),
    `images.yml 只跑 push→master（feature 分支不跑 —— R1304 的触发分级）` +
      ` —— 实际 push.branches = ${JSON.stringify(imagesOn.pushBranches)}`,
  );

  // ── conformance.yml：push→master **且** 可被 release.yml 复用 ────────
  const conf = readWorkflow('conformance.yml');
  const confOn = onShape(conf.on);
  checks.that(
    JSON.stringify(confOn.events) === JSON.stringify(['push', 'workflow_call']),
    `conformance.yml 触发恰为 {push, workflow_call}（后者供 release.yml 复用 —— R1314⑤ 少一次全量构建）` +
      ` —— 实际 ${JSON.stringify(confOn.events)}`,
  );
  // ⚠️ B4 复评补：本文件此前**没有**任何闸看它自己的 `push.branches`（`images.yml` 的同款断言早有）。
  checks.that(
    JSON.stringify(confOn.pushBranches) === JSON.stringify(['master']),
    `conformance.yml 自己那条 push **只**跑 master（feature 分支不跑 —— R1304 的触发分级；` +
      `少了这条，给本文件加 feature 分支触发不会有任何东西响）` +
      ` —— 实际 push.branches = ${JSON.stringify(confOn.pushBranches)}`,
  );
  // ⚠️ B4 复评补：`onShape` 算出来的 `dispatch` 此前**从没被断言**（死字段）。这里给它语义：
  //    conformance 的**唯一**手动入口是 release.yml 的 dispatch（= 回滚），那条路径上本 job 靠
  //    `if` 整条跳过 ⇒ 本文件自己**不得**再开一个手动入口。
  checks.that(
    confOn.dispatch === false,
    `conformance.yml **不得**声明 workflow_dispatch（手动入口只有 release.yml 的 dispatch = 回滚，` +
      `它会用 \`if\` 把 conformance 整条跳过 —— 那正是回滚快的原因）` +
      ` —— 实际 workflow_dispatch = ${JSON.stringify(confOn.dispatch)}`,
  );

  // ── release.yml：**tag `v*`** + `workflow_dispatch`（回滚入口）────────
  const rel = readWorkflow('release.yml');
  const relOn = onShape(rel.on);
  checks.that(
    JSON.stringify(relOn.events) === JSON.stringify(['push', 'workflow_dispatch']),
    `release.yml 触发恰为 {push, workflow_dispatch} —— 实际 ${JSON.stringify(relOn.events)}`,
  );
  checks.that(
    JSON.stringify(relOn.pushTags) === JSON.stringify(['v*']),
    `release.yml **只**由 tag \`v*\` 触发（R1304：打 tag 才部署）—— 实际 push.tags = ${JSON.stringify(relOn.pushTags)}`,
  );
  checks.that(
    relOn.pushBranches === null,
    `release.yml 的 push **不得**带 branches（带了就会「push master 也部署」）—— 实际 ${JSON.stringify(relOn.pushBranches)}`,
  );
  checks.that(
    relOn.dispatch === true,
    `release.yml 必须有 workflow_dispatch —— 它是**回滚入口**（R1308：填一个既有 tag ⇒ 只 pull` +
      ` 不构建、秒级）；少了它就没有「出事了怎么退回去」的手柄` +
      ` —— 实际 workflow_dispatch = ${JSON.stringify(relOn.dispatch)}`,
  );

  // ⚠️ 竞态的正解（§3 的 🔴）：`deploy` 若与 `images` 并行触发，会在镜像推上去**之前**开始
  //    ⇒ 拉不到 tag 镜像。收进同一工作流 + `needs` 串行是唯一解法。
  const jobs = rel.jobs ?? {};
  // ⚠️ **job 集合相等**（不是「包含」）：`deploy` 落地（Task C1）后，B4 复评把原来那句
  //    「images 与 conformance 都在」升级成恰好相等 —— 多一个 job 就是在 tag 路径上多跑一份、
  //    甚至绕过 `needs` 抢跑。⚠️ 它**同时**涵盖「必须有 deploy」（brief Step 5 的成员检查
  //    与它同集：两条并存会让其中一条成为空测，故只留这一条）。
  const jobNames = Object.keys(jobs).sort();
  const jobViolations = fieldSetViolations(jobNames, EXPECTED_RELEASE_JOBS);
  checks.that(
    jobViolations.length === 0,
    `release.yml 的 job 集合**恰好**是 {images, conformance, deploy}（部署必须收在本工作流里用` +
      ` \`needs\` 串行 —— 拆成独立工作流会与 images 并行抢跑、拉到还没推上去的 tag 镜像）` +
      ` —— 实际 ${JSON.stringify(jobNames)}（${jobViolations.join(' | ')}）`,
  );
  // ⚠️ **规范化 + 恰好相等**（B4 复评的 🔴）：`String(…).includes(…)` 会把
  //    `github.event_name != 'push'` 也放过去 —— 而反转后的后果正是这条判据存在的理由：
  //    dispatch 路径上 `images` 不再被跳过 ⇒ 用 **master HEAD** 构建并**覆盖推成** `:v<旧tag>`
  //    （GHCR 的 tag 默认可覆盖）⇒ 静默部署错版本。
  checks.that(
    normIf(jobs.images?.if) === PUSH_ONLY_IF,
    `release.yml 的 \`images\` job 必须带 \`if: github.event_name == 'push'\`` +
      `（否则 dispatch 回滚时会用 **master HEAD** 构建并**覆盖推成** \`:v<旧tag>\` ⇒ 静默部署错版本）` +
      ` —— 实际 if = ${JSON.stringify(jobs.images?.if)}`,
  );
  // ⚠️ spec 有、闸没有（B4 复评补）：dispatch 路径要**整条跳过** conformance ——
  //    那条路径没有待验的新镜像，而 `with.image_tag: github.ref_name` 在 dispatch 上是 `master`
  //    ⇒ 跑起来只会白等（回滚慢）+ 拉一个不存在的 tag（假红）。
  checks.that(
    normIf(jobs.conformance?.if) === PUSH_ONLY_IF,
    `release.yml 的 \`conformance\` job 必须带 \`if: github.event_name == 'push'\`` +
      `（dispatch 回滚路径整条跳过它 —— R1308 的「秒级」一半来自这里）` +
      ` —— 实际 if = ${JSON.stringify(jobs.conformance?.if)}`,
  );
  checks.that(
    JSON.stringify(needsOf(jobs.conformance)) === JSON.stringify(['images']),
    `release.yml 的 \`conformance\` 必须 \`needs: [images]\` —— 实际 ${JSON.stringify(needsOf(jobs.conformance))}`,
  );
  checks.that(
    JSON.stringify(needsOf(jobs.deploy)) === JSON.stringify(['conformance', 'images']),
    `release.yml 的 \`deploy\` 必须 \`needs: [images, conformance]\`（竞态的正解：串行 ⇒ 部署不会先于镜像推送）` +
      ` —— 实际 ${JSON.stringify(needsOf(jobs.deploy))}`,
  );
  // ⚠️ **词项集合的恰好相等**（复评 Important，第二轮）：`normIf` 规范化 → ` && ` 拆项 →
  //    剥括号 → **排序后**与 `DEPLOY_IF_TERMS`（守卫 2 项 + 上游从句 2 项）逐项比较。
  //    此前的**成员判断**（`includes('always()')` + 两个 `includes(upstreamResultClause(…))`）
  //    放得住**多余**子句：追加 `&& needs.images.result == 'success'`（看着像「收紧」）⇒
  //    dispatch 路径上 `images` 是 `skipped` ⇒ `deploy` 整条被跳过 ⇒ **回滚路径被静默掐死**，
  //    而三个成员判断照样全绿。集合相等把「多」也掐掉 ⇒ 一条断言同时覆盖守卫、两个上游从句、
  //    以及「不得有第四种项」（三条并成一条也守 R115：重叠的断言里必有一条是空测）。
  const deployTerms = andTerms(normIf(jobs.deploy?.if));
  checks.that(
    sameTermSet(deployTerms, DEPLOY_IF_TERMS),
    `\`deploy\` 的 \`if\` 拆出的**全部**词项必须**恰好**是 ${JSON.stringify([...DEPLOY_IF_TERMS].sort())}` +
      `（守卫 \`always()\` + \`!cancelled()\`、两个上游各一条 \`success || skipped\` 从句；次序不限）` +
      ` —— **多**一项也不行：追加 \`needs.images.result == 'success'\` 之类的「收紧」会让 dispatch` +
      `（\`images\` 是 skipped）上的 \`deploy\` 整条被跳过 = **回滚路径静默掐死**；` +
      `少 \`skipped\` 半边 = 同上；\`==\` 反转成 \`!=\` = 上游失败也放行` +
      ` —— 实际拆分 ${JSON.stringify(deployTerms)}`,
  );

  // ── 负对照（R115 同族）：同一个谓词喂**合成**输入 ⇒ 必须红 ────────────
  step('B1 判别力自证：合成输入喂同一个谓词 ⇒ 必须红');
  const syntheticPush = onShape({ push: {} });
  checks.eq(
    JSON.stringify(syntheticPush.events) === JSON.stringify(['push', 'workflow_call']),
    false,
    '负对照：`on: push`（无 workflow_call）喂 conformance 的谓词 ⇒ **必须不相等**' +
      '（若这条绿了，说明谓词恒真 —— 上面的断言全是空测）',
  );
  const wrongNeeds = needsOf({ needs: ['images'] });
  checks.eq(
    JSON.stringify(wrongNeeds) === JSON.stringify(['images', 'conformance']),
    false,
    '负对照：`needs: [images]` 喂 deploy 的谓词 ⇒ **必须不相等**',
  );
  // ⚠️ `if` 谓词的**两头**负对照（B4 复评 🔴 的判别力自证）：
  //    ① 合法拼法必须过 —— 裸的恰好相等会把它误杀成假红，而假红最诱人的「修法」是删判据；
  //    ② 反转写法必须红 —— 子串包含会放它过去，那正是「回滚时用 master HEAD 覆盖推成旧 tag」的入口。
  checks.eq(
    normIf("${{ github.event_name == 'push' }}") === PUSH_ONLY_IF,
    true,
    '负对照（上半）：合法拼法 `${{ github.event_name == \'push\' }}` 经规范化后必须**等于**谓词' +
      '（少了这条，规范化写过头（例如连 `${{ }}` 都不剥）也没人知道）',
  );
  checks.eq(
    normIf("github.event_name != 'push'") === PUSH_ONLY_IF,
    false,
    '负对照（下半）：反转写法 `github.event_name != \'push\'` **必须不相等**' +
      '（若这条绿了 ⇒ 子串包含式的判据会把静默部署错版本放过去）',
  );
  // ⚠️ `deploy` 词项谓词的**四向**判别力自证（复评 Important，第二轮：成员判断 ⇒ 集合相等）——
  //    每种**具体改写**各喂一次**同一个** `sameTermSet`（合成 `if` 只改一处、其余与真文件同形）：
  //    ① 删 `skipped` 半边（旧判据也能抓）·② `==`→`!=`（旧判据也能抓）·
  //    ③ **多一个词项**（旧成员判断**放它过去** —— 本轮换判据的动机就是它）·
  //    ④ 合法重排（**必须判齐**：证明排序真的在起作用 ⇒ 谓词对次序不敏感、合法重排不假红）。
  const skippedDropped = andTerms(
    normIf(
      "always() && !cancelled() && (needs.images.result == 'success') && " +
        "(needs.conformance.result == 'success' || needs.conformance.result == 'skipped')",
    ),
  );
  checks.eq(
    sameTermSet(skippedDropped, DEPLOY_IF_TERMS),
    false,
    '负对照：**删掉 `skipped` 半边**的 `if`（`needs.images.result == \'success\'`）喂同一谓词 ⇒ **必须判不齐**' +
      '（若这条绿了 ⇒ 回滚路径可以被静默掐死）',
  );
  const inverted = andTerms(
    normIf(
      "always() && !cancelled() && (needs.images.result != 'success' || needs.images.result == 'skipped') && " +
        "(needs.conformance.result == 'success' || needs.conformance.result == 'skipped')",
    ),
  );
  checks.eq(
    sameTermSet(inverted, DEPLOY_IF_TERMS),
    false,
    '负对照：**`==` 反转成 `!=`** 的 `if` 喂同一谓词 ⇒ **必须判不齐**' +
      '（若这条绿了 ⇒ 失败的上游也会被放行）',
  );
  // ⚠️ 本轮新增的判别力：**多**一个词项（旧成员判断的根本盲区）。
  const extraTerm = andTerms(
    normIf(
      "always() && !cancelled() && (needs.images.result == 'success' || needs.images.result == 'skipped') && " +
        "(needs.conformance.result == 'success' || needs.conformance.result == 'skipped') && " +
        "needs.images.result == 'success'",
    ),
  );
  checks.eq(
    sameTermSet(extraTerm, DEPLOY_IF_TERMS),
    false,
    '负对照：**叠一个多余词项**（`&& needs.images.result == \'success\'`，看着像「收紧」）的 `if`' +
      ' 喂同一谓词 ⇒ **必须判不齐**' +
      '（dispatch 路径上 `images` 是 `skipped` ⇒ 叠上这条后 `deploy` 整条被跳过 = 回滚路径被静默掐死；' +
      '若这条绿了 ⇒ 集合相等退化成了「包含」）',
  );
  const reordered = andTerms(
    normIf(
      "(needs.conformance.result == 'success' || needs.conformance.result == 'skipped') && always() && " +
        "(needs.images.result == 'success' || needs.images.result == 'skipped') && !cancelled()",
    ),
  );
  checks.eq(
    sameTermSet(reordered, DEPLOY_IF_TERMS),
    true,
    '正对照：**同四词项、不同次序**（合法重排，语义不变）喂同一谓词 ⇒ **必须判齐**' +
      '（若这条红 ⇒ 排序没起作用、判据对次序敏感 ⇒ 合法重排假红，最诱人的「修法」就是删判据）',
  );
  // ⚠️ 拼法自证（B4 复评的「uneven」项）：标量与数组两种 YAML 写法必须在**各自**读取器里同形。
  const scalarBranches = onShape({ push: { branches: 'master' } }).pushBranches;
  const scalarNeeds = needsOf({ needs: 'images' });
  checks.that(
    JSON.stringify(scalarBranches) === JSON.stringify(['master']) && JSON.stringify(scalarNeeds) === JSON.stringify(['images']),
    `拼法自证：标量写法（\`branches: master\` / \`needs: images\`）与数组写法必须同形` +
      `（此前只有 \`needsOf\` 收标量 ⇒ 换个合法拼法，上面对 branches 的判据会静默失真）` +
      ` —— 实际 pushBranches=${JSON.stringify(scalarBranches)} needs=${JSON.stringify(scalarNeeds)}`,
  );
  // ⚠️ 解析器自证（B1 的警告半句）：`on` 必须被解析成**字符串键**。若某个 YAML 1.1 语义的
  //    解析器把它读成布尔 `true`，`onShape` 会走进对象分支、`events` 为空 ⇒ **下面这条必红**。
  checks.that(
    Object.keys(load('on: push\n') as object).includes('on'),
    '解析器自证：`js-yaml` 必须把 `on` 解析成**字符串键**（YAML 1.1 语义会读成布尔 `true` ⇒ 全部触发断言失真）',
  );

  // ── 终审 M9：镜像前缀字面量在各处必须一致 ────────────────────────────
  step('M9 镜像前缀字面量：脚本与工作流里的 `ghcr.io/…` 必须都指向同一个仓库');
  const prefixOffenders: string[] = [];
  const prefixFilesHit: string[] = [];
  for (const rel of PREFIX_FILES) {
    const matches = readFileSync(join(REPO_ROOT, rel), 'utf8').match(GHCR_PATH) ?? [];
    if (matches.length > 0) prefixFilesHit.push(rel);
    for (const m of new Set(matches)) {
      if (!ghcrPathAgrees(m)) prefixOffenders.push(`${rel}: ${m}`);
    }
  }
  checks.that(
    prefixOffenders.length === 0,
    `脚本与工作流里出现的每个 \`ghcr.io/…\` 路径都必须指向 \`${IMAGE_PREFIX_LITERAL}\`` +
      `（合法写法两种：前缀本身，或 \`前缀-<svc>[:tag]\` 形态的完整镜像名）——` +
      ` 两处不一致 = 拉取路径验证的镜像集合与生产部署的**不是同一批**（静默）` +
      ` —— 违例 ${JSON.stringify(prefixOffenders)}`,
  );
  checks.that(
    prefixFilesHit.length >= 4,
    `上一条必须**真的扫到东西**：至少 4 个文件里出现该字面量` +
      `（实际 ${prefixFilesHit.length} 个：${JSON.stringify(prefixFilesHit)}）` +
      `（少了这条，把它们一并改成别的写法 ⇒ 上一条会静默变成空测）`,
  );
  checks.eq(
    ghcrPathAgrees('ghcr.io/howebai/fight-the-landlord2-api-gateway:v1'),
    false,
    '负对照：近邻写法 `…/fight-the-landlord2-…`（多一个字符）喂同一谓词 ⇒ **必须不一致**' +
      '（若这条绿了 ⇒ 谓词退化成「包含」，别家的仓库名也能混进来）',
  );
  checks.eq(
    ghcrPathAgrees('ghcr.io/howebai/fight-the-landlord-prod-robot-service:v9'),
    false,
    '负对照（**证伪轮实测抓到的漏网形态**）：兄弟仓库名 `…-fight-the-landlord-prod-…` 喂同一谓词' +
      ' ⇒ **必须不一致**（只判「以 `前缀-` 开头」的版本会把它放过去；那正是「一处改名、其余没跟」的样子）',
  );
  checks.eq(
    ghcrPathAgrees('ghcr.io/howebai/fight-the-landlord-api-gateway:v1'),
    true,
    '正对照：完整镜像名（`…-api-gateway:v1`）喂同一谓词 ⇒ 必须一致' +
      '（`rollback.sh` 用的就是这种合法写法，不许假红）',
  );
  const svcNames = buildServices();
  checks.eq(
    svcNames.length,
    14,
    `谓词里那份服务名清单**派生**自 \`docker-compose.yml\` 的带 \`build:\` 服务（实际 ${svcNames.length} 个：${JSON.stringify(svcNames)}）` +
      '（空了 ⇒ 判据只剩「等于前缀本身」那半边，完整镜像名的合法写法会假红）' +
      '（货币片 T1：#24 —— 加 currency-service 块即 12→13，不改此处即红）' +
      '（支付片 T2：加 payment-service 块即 13→14，不改此处即红）',
  );

  // ── 终审 I1：`run:` 体里不得出现 `${{ … }}` ────────────────────────────
  step('I1 终审：`run:` 体里不得插 `${{ … }}`（自由文本 → 代码的入口）');
  const interpolated: string[] = [];
  let runBodies = 0;
  for (const file of EXPECTED_FILES) {
    const wf = readWorkflow(file);
    for (const [jobName, job] of Object.entries<any>(wf.jobs ?? {})) {
      for (const st of (job?.steps ?? []) as any[]) {
        if (typeof st?.run !== 'string') continue;
        runBodies += 1;
        if (st.run.includes('${{')) {
          interpolated.push(`${file} · ${jobName} · ${String(st.name ?? '(无名字的步骤)')}`);
        }
      }
    }
  }
  checks.that(
    interpolated.length === 0,
    `四个工作流里**任何** \`run:\` 体都不得出现 \`\${{ … }}\`（终审 I1：\`github.ref_name\` 这类值` +
      `可以是**自由文本** —— git 的 ref 名合法地能含 \`"\` 与 \`;\`）⇒ 一律经 \`env:\` 传入、` +
      `在 shell 里以引号引用。插进 \`run:\` 体 = 把自由文本当**代码**交给 runner 的 shell` +
      `（该 job 可能持有 \`packages: write\` ⇒ 恶意 tag 名可推任意镜像，而服务器随后会拉它们）` +
      ` —— 违例 ${JSON.stringify(interpolated)}`,
  );
  checks.that(
    runBodies >= 12,
    `上一条必须**真的扫过 run 体**（实际扫到 ${runBodies} 个；下限 12 大致是当前数量的一半 ——` +
      `留出**合法**增删的余量，同时保证「扫了个空」会红）` +
      `（少了这条，\`run:\` 被改名/搬家 ⇒ 上一条静默变成空测）`,
  );

  // ── Task 6：备份两步的落点（手册 `:845` / `:866` / `:869` / `:903` 的机械对应）─────────
  //    手册那几句写的是**本片交付后的形态**（「脚本由发布流水线在每次发布时投递」「定时任务由
  //    发布流水线在每次发布时核对安装」「那次发布会在**最后一步**红」）。没有这条判据时，
  //    它们只是散文 —— 而本仓点名的复发缺陷正是「手册的预期读数与真实形态不一致」。
  step('Task 6：备份三步的落点（投递+装 cron 在 deploy 之前 · 首跑在 deploy 之后 · 新鲜度是**最后一步**）');
  const deploySteps = (jobs.deploy?.steps ?? []) as unknown[];
  const wiring = backupWiringViolations(deploySteps);
  checks.that(
    wiring.length === 0,
    '`deploy` job 里的备份接线必须满足四条性质：① 新鲜度那一步**恰好一个**且是 job 的**最后一步**；' +
      '② 它 `if` 仅 push；③ 投递+装 cron 那一步（恰好一个）`if` 仅 push 且排在跑 `deploy.sh` 的那一步' +
      '**之前**；④ 首跑那一步（恰好一个）`if` 仅 push、排在跑 `deploy.sh` 的那一步**之后**（C1：排在' +
      '前面会让首次发布死锁），且带「**仅当还没有 ok:true 的 manifest**」这个限定词（无条件跑会让' +
      '新鲜度判据在 push 路径上永远不可能红） —— ' +
      `实际 ${deploySteps.length} 步；违例：${JSON.stringify(wiring)}`,
  );
  // 投递面自证（手册 `:845`「脚本由**发布流水线**在每次发布时投递」）：三个脚本名必须**真的**
  // 出现在流水线的**投递命令**里（`release.yml` 的 run 体 ∪ `deploy.sh` 的文本）—— 否则「投递」只是
  // 手册里的一句话，而「ls /home/ubuntu/ftl-ops/ 应当恰好三个脚本」永远不会有东西可看。
  const deliveryText = [
    ...deploySteps.map((st) => String((st as { run?: unknown } | null)?.run ?? '')),
    readFileSync(join(REPO_ROOT, 'scripts', 'deploy', 'deploy.sh'), 'utf8'),
  ].join('\n');
  const delivered = ftlOpsDeliveredNames(deliveryText);
  const notShipped = FTL_OPS_ALLOWED.filter((n) => !delivered.includes(n));
  checks.that(
    notShipped.length === 0,
    '那三个 ops 脚本必须**真的**出现在**投递命令**里（`release.yml` 的 `deploy` job 的 run 体 ∪ ' +
      `\`scripts/deploy/deploy.sh\` 的文本）—— 没出现的是 ${JSON.stringify(notShipped)}` +
      '（`restore-drill.sh` 是开发/CI 工具、`check-backup-fresh.sh` 是 runner 侧的闸 —— 两个都**不许**进生产，' +
      '所以这里只钉这三个；手册 :845 让读者 `ls /home/ubuntu/ftl-ops/` 看到**恰好**这三个）',
  );
  // 🔴 M3（第一轮修复轮）：上面那条只问「出现过没有」⇒ 后来往投递命令里**多塞**一个名字
  //    （`restore-drill.sh` / `check-backup-fresh.sh` 加进一条 `scp … ftl-ops/` 行）时**不会有任何
  //    东西响** —— 而那条断言自己的文案引用的正是手册 :845「`ls` 应当**恰好**三个脚本」这句承诺
  //    （一条自己引用却没有东西守着的承诺 = 假信息）。⇒ 投递面里**只许**出现那三个文件名。
  const overShipped = ftlOpsDeliveryViolations(deliveryText);
  checks.that(
    overShipped.length === 0,
    '投递命令里**只许**出现那三个文件名（手册 :845 的「**恰好**三个脚本」—— 多投一个，凌晨三点' +
      `按手册 \`ls\` 的人就会看到手册没说的东西）—— 多投的是 ${JSON.stringify(overShipped)}` +
      `（投递面实际抽到：${JSON.stringify(delivered)}）`,
  );
  // 判别力自证（R115）：**一个正对照 + 两个负对照**，都喂同一个谓词（`ftlOpsDeliveredNames`）。
  // 正对照②连它可能写歪的两处一起钉住：**续行**（`\` 折行是**一条**命令 —— 按物理行看会整条漏掉）
  // 与**旗标**（`-i "$SSH_KEY"` 之类不许被当成「多投了一个文件」）。
  checks.that(
    ftlOpsDeliveredNames(SYNTH_DELIVERY_OK).length === 3 && ftlOpsDeliveryViolations(SYNTH_DELIVERY_OK).length === 0,
    '正对照：一条合规的 `scp … ftl-ops/`（带续行、带 `-i`/`-o` 旗标）喂同一谓词 ⇒ 必须抽出**恰好三个**' +
      `且判齐（若这条红 ⇒ 谓词会误杀合规投递：续行没拼、或把 \`$SSH_KEY\` 当成投递的文件）—— ` +
      `实际抽到 ${JSON.stringify(ftlOpsDeliveredNames(SYNTH_DELIVERY_OK))}`,
  );
  checks.that(
    ftlOpsDeliveryViolations(SYNTH_DELIVERY_WITH_DRILL).some((x) => x.includes('restore-drill.sh')),
    '负对照：把 `restore-drill.sh` 塞进那条 `scp … "$TARGET:/home/ubuntu/ftl-ops/"` 喂同一谓词 ⇒ ' +
      '必须报它多投（若这条绿 ⇒ M3 没修：手册 `:845` 那句「恰好三个」与真实形态脱钩）' +
      ` —— 实际 ${JSON.stringify(ftlOpsDeliveryViolations(SYNTH_DELIVERY_WITH_DRILL))}`,
  );
  checks.that(
    ftlOpsDeliveryViolations(SYNTH_RUNNER_SIDE).length === 0,
    '负对照②（扫描面必须**只**是投递命令）：runner 侧真跑的 `bash scripts/ops/check-backup-fresh.sh` 与 ' +
      '`ssh … \'chmod 700 /home/ubuntu/ftl-ops/*.sh\'` 喂同一谓词 ⇒ **必须判齐**（拿整段 run 体当投递面' +
      `会把这二者判成「多投的文件」）—— 实际 ${JSON.stringify(ftlOpsDeliveryViolations(SYNTH_RUNNER_SIDE))}`,
  );
  // 判别力自证（R115）：同一个谓词喂**合成** step 列表 —— 五向负对照（每种具体改写各一次）
  // 加一个**正对照**（合规布局必须判齐：谓词写歪成「恒有违例」时它当场红）。
  checks.eq(
    backupWiringViolations(SYNTH_OK_STEPS).length,
    0,
    '正对照：合规布局（投递+装 cron 在 deploy 之前 · 首跑在 deploy 之后 · 新鲜度带 push 闸且是最后一步）' +
      '喂同一谓词 ⇒ 必须判齐（若这条红 ⇒ 谓词会误杀合规布局，最诱人的「修法」就是把判据删掉）',
  );
  const freshNotLast = [...SYNTH_OK_STEPS, { name: '收尾', if: 'always()', run: 'bash scripts/deploy/deploy.sh --assert-clean' }];
  checks.that(
    backupWiringViolations(freshNotLast).some((x) => x.includes('最后一步')),
    '负对照①：在新鲜度那一步**之后**再塞一步（`if: always()` 的收尾断言）喂同一谓词 ⇒ 必须报「不是最后一步」' +
      '（手册 :869 写的是「**最后一步**红」—— 放错位置时那句话不可能发生）',
  );
  const freshNoGate: readonly unknown[] =
    SYNTH_OK_STEPS.map((st) => ({ ...(st as Record<string, unknown>), if: undefined }));
  checks.that(
    backupWiringViolations(freshNoGate).some((x) => x.includes('仅 push') || x.includes(PUSH_ONLY_IF)),
    '负对照②：把三步的 `if` 都拿掉（默认语义 = push 与 dispatch 都跑）喂同一谓词 ⇒ 必须报缺 push 闸' +
      '（dispatch 回滚路径不许被与本次操作无关的备份问题弄红）',
  );
  const cronAfterDeploy: readonly unknown[] = [SYNTH_DEPLOY, SYNTH_DELIVER, SYNTH_FIRST_BACKUP, SYNTH_FRESH];
  checks.that(
    backupWiringViolations(cronAfterDeploy).some((x) => x.includes('之前')),
    '负对照③：把「投递+装 cron」挪到 `deploy.sh` 那一步**之后**喂同一谓词 ⇒ 必须报次序反了' +
      '（设计 §3.1 的 ①②→④；放后面的实现在「首次发布」那次会让新鲜度那一步读到**空**备份目录）',
  );
  // 负对照⑥（**C1 的判别力自证**）：把**首跑**挪回 `deploy.sh` 那一步**之前** —— 那正是修前的形态
  // （首次发布死锁）。少了它，「首跑必须在部署之后」这条新性质没有任何东西看着。
  const firstBackupBeforeDeploy: readonly unknown[] = [SYNTH_DELIVER, SYNTH_FIRST_BACKUP, SYNTH_DEPLOY, SYNTH_FRESH];
  checks.that(
    backupWiringViolations(firstBackupBeforeDeploy).some((x) => x.includes('之后')),
    '负对照⑥：把**首跑**挪到 `deploy.sh` 那一步**之前**（= 第一轮 C1 的修前形态：栈还没起来 ⇒ ' +
      '`docker exec ftl-mysql` 必红 ⇒ 隐式 `success()` 把 `部署` 跳过 ⇒ 栈永远起不来、重跑复现' +
      '同一状态）喂同一谓词 ⇒ 必须报次序反了（若这条绿 ⇒ 首发死锁可以原样回归而无人知）',
  );
  // 负对照⑦：只拿掉**首跑那一步**的 `if`（其余两步照旧）⇒ 必须单独报它缺 push 闸。少了它，
  // 「首跑带 push 闸」这条性质只能靠负对照②里**别的步骤**的消息满足（重叠的断言里必有一条是空测）。
  const firstNoGate: readonly unknown[] = SYNTH_OK_STEPS.map((st) =>
    String((st as { run?: unknown }).run ?? '').includes('backup.sh')
      ? { ...(st as Record<string, unknown>), if: undefined }
      : st,
  );
  checks.that(
    backupWiringViolations(firstNoGate).some((x) => x.includes('首跑那一步必须')),
    '负对照⑦：**只**拿掉首跑那一步的 `if`（新鲜度/投递那两步照旧）喂同一谓词 ⇒ 必须报首跑缺 push 闸' +
      '（若这条绿 ⇒ 那条性质被负对照②里别的步骤的消息喂饱了 = 空测）',
  );
  // 负对照⑧：首跑出现**两次** ⇒ 必须报「恰好一个」（多一处 ssh + 备份 = 多一处失败面，且两处都可能
  // 在新鲜度那一步之前造出 fresh manifest）。
  const firstTwice: readonly unknown[] = [SYNTH_DELIVER, SYNTH_DEPLOY, SYNTH_FIRST_BACKUP, SYNTH_FIRST_BACKUP, SYNTH_FRESH];
  checks.that(
    backupWiringViolations(firstTwice).some((x) => x.includes('（首跑）必须**恰好一个**')),
    '负对照⑧：让首跑出现**两次**喂同一谓词 ⇒ 必须报「恰好一个」（若这条绿 ⇒ 判据只认「至少一个」，' +
      '重复的首跑不会被发现）',
  );
  const noQualifier: readonly unknown[] = SYNTH_OK_STEPS.map((st) => ({
    ...(st as Record<string, unknown>),
    run: String((st as { run?: unknown }).run ?? '').replace('manifest-[0-9]*.json', 'xx'),
  }));
  checks.that(
    backupWiringViolations(noQualifier).some((x) => x.includes('限定词')),
    '负对照④：把「仅当还没有 ok:true 的 manifest」那半边拿掉（每次发布都无条件跑一次备份）喂同一谓词 ⇒ ' +
      '必须报缺限定词 —— 那正是「新鲜度判据在 push 路径上永远不可能红」的形态（第三轮 Critical：' +
      '判据存在 ≠ 判据有效）',
  );
  // 负对照⑤（**这条钉子的第一版就在这里假绿过**）：把判定挪到**另一行**（glob 那行只剩 glob、
  // 判定写成旁边一句注释）⇒ 仍必须红。少了它，「同一行」这个要求本身没有东西看着。
  const guardSplit: readonly unknown[] = SYNTH_OK_STEPS.map((st) => ({
    ...(st as Record<string, unknown>),
    run: String((st as { run?: unknown }).run ?? '').replace('| grep -q ok:true', '\n# 仅当没有 ok:true 时才跑'),
  }));
  checks.that(
    backupWiringViolations(guardSplit).some((x) => x.includes('限定词')),
    '负对照⑤：把 `ok:true` 的判定从**那一行**挪走（glob 还在、判定变成旁边一句注释）喂同一谓词 ⇒ ' +
      '必须**仍**报缺限定词（若这条绿了 ⇒ 钉子被注释喂饱，删掉判定也不会有东西响）',
  );

  // ── 片⑦ K6：C21① —— 送机 compose = **目标 tag 自己的**（静态闸）──────────────────
  //    规格 §3 的 C21①（C21② 的发布后演练是**验收项**，不在本切片）。替代错实现两条：
  //    「回滚送 master compose」（拉不存在的 config-service:旧tag —— r2 实测根因）与
  //    「取不到 tag 时静默回退本检出」。判据 = 源扫描 deploy.sh（见谓词注释）。
  step('C21①：deploy.sh 按 tag 取 compose（`refs/tags/${TAG}:docker-compose.yml`）且取不到 ⇒ fail-closed；送机的就是它');
  const deployShText = readFileSync(join(REPO_ROOT, 'scripts', 'deploy', 'deploy.sh'), 'utf8');
  const c21 = tagComposeFetchViolations(deployShText);
  checks.that(
    c21.length === 0,
    '`scripts/deploy/deploy.sh` 必须满足 C21① 的两条性质：① `git show "refs/tags/${TAG}:docker-compose.yml"` ' +
      '由 `if !` 守卫、且不得带 `|| …` 静默回退；② 分支体里 `exit 1`（fail-closed）且送机 scp 的源是 ' +
      `\`"$COMPOSE_DEPLOY"\` —— 违例：${JSON.stringify(c21)}`,
  );
  // 判别力自证（R115）：**合成输入喂同一个谓词** —— 一个正对照 + 三个负对照，各对应一种**具体**改写。
  // ⚠️ 负对照① 就是 brief 指定的那次**真文件变异**的文本形态（验收时对真文件也做过一次、留档在报告）。
  const C21_SYNTH_OK =
    'COMPOSE_DEPLOY="$(mktemp)"\n' +
    'if ! git show "refs/tags/${TAG}:docker-compose.yml" > "$COMPOSE_DEPLOY" 2>/dev/null; then\n' +
    '  printf \'取不到 tag compose: %s\\n\' "$TAG" >&2\n' +
    '  exit 1\n' +
    'fi\n' +
    'scp -i "$SSH_KEY" "$COMPOSE_DEPLOY" "$TARGET:$REMOTE_DIR/docker-compose.yml"\n';
  checks.eq(
    tagComposeFetchViolations(C21_SYNTH_OK).length,
    0,
    'C21① 正对照：合成的合规形态（`if !` 取 tag + 分支 `exit 1` + scp 送 `"$COMPOSE_DEPLOY"`）喂同一谓词' +
      ' ⇒ 必须判齐（若这条红 ⇒ 谓词会误杀合规实现，最诱人的「修法」就是把判据删掉）',
  );
  const C21_SYNTH_LOCAL_SEND =
    'printf \'=== 送 compose 基文件 ===\'\n' +
    'scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new docker-compose.yml "$TARGET:$REMOTE_DIR/docker-compose.yml"\n';
  checks.that(
    tagComposeFetchViolations(C21_SYNTH_LOCAL_SEND).some((x) => x.includes('找不到')),
    'C21① 负对照①：删掉「按 tag 取 compose」的整段、scp 直接送**本检出**（= 修前形态：回滚送 master ' +
      'compose ⇒ 拉不存在的 config-service:旧tag）喂同一谓词 ⇒ 必须报「找不到」',
  );
  const C21_SYNTH_SILENT_FALLBACK = C21_SYNTH_OK.replace(
    'if ! git show "refs/tags/${TAG}:docker-compose.yml" > "$COMPOSE_DEPLOY" 2>/dev/null; then',
    'if ! git show "refs/tags/${TAG}:docker-compose.yml" > "$COMPOSE_DEPLOY" 2>/dev/null || cp docker-compose.yml "$COMPOSE_DEPLOY"; then',
  );
  checks.that(
    tagComposeFetchViolations(C21_SYNTH_SILENT_FALLBACK).some((x) => x.includes('||')),
    'C21① 负对照②：取 tag 失败时**静默回退本检出**（行尾 `|| cp docker-compose.yml "$COMPOSE_DEPLOY"`）' +
      '喂同一谓词 ⇒ 必须报 `||` 违例（若这条绿 ⇒「取不到 ⇒ 用本检出」可以原样回归而无人知）',
  );
  const C21_SYNTH_NO_EXIT = C21_SYNTH_OK.replace('  exit 1\n', '');
  checks.that(
    tagComposeFetchViolations(C21_SYNTH_NO_EXIT).some((x) => x.includes('exit 1')),
    'C21① 负对照③：`if !` 分支体里**拿掉 `exit 1`**（取不到 tag 也继续 ⇒ 送一个空 compose 上机）' +
      '喂同一谓词 ⇒ 必须报缺 fail-closed 分支',
  );

  // ── deploy-dev.sh（2026-10-15 用户拍板）：dev → 测试服的**一条命令**封装 ──────────────
  //    两条性质见 `deployDevViolations` 的注释。判别力自证 = 两个负对照（各对应一种**具体**改写）。
  step('deploy-dev.sh：一条命令封装必须调用正典脚本（build-images.sh / deploy.sh），且 tag 构造只用 `dev-` 前缀');
  const deployDevText = readFileSync(join(REPO_ROOT, 'scripts', 'deploy', 'deploy-dev.sh'), 'utf8');
  const ddSelf = deployDevViolations(deployDevText);
  checks.that(
    ddSelf.length === 0,
    '`scripts/deploy/deploy-dev.sh` 必须满足两条性质（谓词注释见 `deployDevViolations`）：① 三步调用' +
      '正典脚本（构建 = build-images.sh / 部署 = deploy.sh）；② tag 构造只用 `dev-` 前缀（`v*` 会触发' +
      `release.yml 发布链）—— 违例：${JSON.stringify(ddSelf)}`,
  );
  // 负对照①：删掉「构建」的正典调用、改成在脚本里**重实现**（bake 直调等价物）喂同一谓词 ⇒ 必须红。
  // ⚠️ replace 的字面量 = 真文件的调用行形态；若改了真文件的写法而**没同步这里** ⇒ 替换空转 ⇒ 下面
  //    这条**红**（响亮地要你同步对照，而不是静默变空测）。
  const ddReimplemented = deployDevText.replace(
    'bash scripts/deploy/build-images.sh "$TAG"',
    'docker buildx bake -f docker-compose.yml --push',
  );
  checks.that(
    deployDevViolations(ddReimplemented).some((x) => x.includes('build-images.sh')),
    '负对照①：删掉 `build-images.sh` 的正典调用、改为在 deploy-dev.sh 里**重实现**构建喂同一谓词 ⇒ ' +
      '必须报缺正典调用（若这条绿 ⇒ 配方可以分叉成两处实现而无人知——本仓为该形态付过多次代价）',
  );
  // 负对照②：tag 前缀换成 `v`（一次手滑就会触发 release.yml）⇒ 必须红。
  const ddVTag = deployDevText.replace('TAG="dev-$SHA"', 'TAG="v$SHA"');
  checks.that(
    deployDevViolations(ddVTag).some((x) => x.includes('dev-')),
    '负对照②：把 tag 构造改成 `v` 前缀喂同一谓词 ⇒ 必须报前缀违例（若这条绿 ⇒ 一次手滑就会把' +
      '「部署到测试服」变成「触发发布链」）',
  );

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

  return checks;
}

/**
 * **J18 机械闸（片② 立；片⑦ 翻转第 ② 条）**：`docs/design.md` 的修订必须真落地 —— 三条文档级判据：
 *  ① §9.3 整节（切片边界 = 到下一个 `### ` 或 `## `，**取先到者**）内 `errorRate` **零命中**；
 *  ② §2.3 环境变量表：**不得**再出现退役 env（片⑦ 收编进配置中心九键，§7.5；支付配置
 *     管理化片 T11 追加 `PAY_PUBLIC_BASE_URL` / `ALIPAY_SELLER_ID`；通知通道管理化片
 *     T10 追加九项通知 env，见 `RETIRED_ENVS`），
 *     且**必须**出现片⑦ 的新行（`ADMIN_PASSWORD` / `ADMIN_JWT_SECRET` / `CONFIG_SERVICE_RPC_*` / `CONFIG_SERVICE_URL`）。
 *     货币片 T7 追加 `CURRENCY_SERVICE_URL`（接口文档 §2.13）、支付片 T2 追加 `PAYMENT_SERVICE_URL`
 *     （规格 §2.7.2）、支付配置管理化片 T11 追加 `PAY_CONFIG_ENC_KEY` / `PAY_CHANNEL_PULL_TOKEN`
 *     （规格 ⚙️5/⚙️13）、通知通道管理化片 T10 追加 `NOTIFY_CHANNEL_PULL_TOKEN`（规格 §2.6）、
 *     广告片 T10 追加 `AD_CHANNEL_PULL_TOKEN`（规格 §2.3）
 *     ——列表只增不减。
 *     ⚠️ **极性翻转（片②→片⑦）**：旧断言「三个 env 必须在表里」在片⑦ 删行后必红 ⇒ 翻成「不得在表里」
 *     —— 退役的守卫也机械化（r1 计划审查 I-2）。**只翻极性、不弱化机械性**：切片语义不变、
 *     标题找不到照旧抛错（空串才会让「不得包含」类断言恒绿，见下）、并同时保留一列正向断言。
 *  ③ §9.3 必须出现 `sl` / `douzero_WP` / `douzero_ADP` 三个**模型字面量**。
 *
 * ─── 边界为什么钉死为「取先到者」（v9-5/v8-13 的教训）────────────────────
 * §9.3 的下一节是 `### 9.4`；但若将来有人在中间插一个 `## ` 大节，旧口径（只认 `### `）会把
 * 大节内容也当成「§9.3 切片」⇒ 判据范围漂移。因此终点 = 下一个 `### ` **或** `## `，
 * 谁先到算谁。找不到起始标题**抛错**（不返回空串 —— 空串会让「不得包含」类断言恒绿）。
 *
 * ─── ⚠️ 时点纪律（T10 与 T11 是环）──────────────────────────────────────
 * 本片执行顺序是「**写闸（T10）→ 改文档（T11）→ 复核转绿**」。T11 完成前 `docs/design.md`
 * 还没改（§9.3 里有 `errorRate` 注记与表列、§2.3 缺三个 env、表格还没有三个模型名）
 * ⇒ 本文件的三个断言**必然红**，那是**预期**：红 = 文档还没改，不是本闸有缺陷。
 * **不得**为了让闸变绿而修改断言、也**不得**在 T10 里越权改 `docs/design.md`。
 * （**片⑦/T17 更新**：② 的极性已按「退役的守卫也机械化」翻转 —— 片⑦ 把三个 env 从 §2.3
 * 删掉、换了新行；①③ 两半不受影响。）
 *
 * ─── 判别力自证 ────────────────────────────────────────────────────────
 *  - 切片边界：节前/节后（尤其是 `## ` 之后的更远 `### `）的文本不得混入；
 *  - `\bsl\b`（而不是裸 `/sl/`）：裸子串几乎恒真（任何含 `sl` 的英文词都命中），
 *    带词界后它只认「单独出现的 `sl`」这一件事（`sl` / `` `sl` `` / `sl、` 都命中）——
 *    这正是设计层「表里必须出现 `sl` 字面量」要的判别力；
 *  - §2.3 的同名文本出现在**标题行之前**不得算数（喂合成串验证）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 从本文件所在目录向上找仓库根（锚 = `packages/shared` + `packages/protocol`；找不到抛错）。 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    const second = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      existsSync(second) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/shared"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（锚 = packages/shared/package.json 且 name 校验通过 + packages/protocol）');
}

const REPO = findRepoRoot();
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8');

/**
 * 取 `heading`（行首前缀）开头的那一节：从标题行起，到下一个匹配 `terminator` 的行为止
 * （不含结束行）。找不到标题**抛错**。
 */
function sectionOf(text: string, heading: string, terminator: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) throw new Error(`找不到以「${heading}」开头的节标题 —— 文档结构变了？`);
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => terminator.test(line));
  return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
}

/** 切片终点：`### ` 或 `## ` 的行首标题，**取先到者**（见文件头）。 */
const SECTION_END = /^(### |## )/;

/** T11 第 12/13 行落地后，§9.3 必须出现这三个模型字面量（三档一一对应）。 */
const MODEL_LITERALS = [/\bsl\b/, /douzero_WP/, /douzero_ADP/] as const;

/**
 * 片⑦（T17）后，§2.3 **不得**再出现这些退役 env（收编进配置中心九键，§7.5）。
 * **支付配置管理化片（T11 / 评审 Y5）追加两条**：`PAY_PUBLIC_BASE_URL` 与
 * `ALIPAY_SELLER_ID` —— 与其余六项渠道 env 一并退役（搬进管理面第二键空间，
 * 规格 §2.6/§2.7）⇒ 旧**正向**断言**翻极性**搬来这里（退役的守卫也机械化；
 * 不得直接删旧正向断言）。
 * **通知通道管理化片（T10）追加九条**：通知九键 env（SMTP 五 + IM 四）整体退役，
 * 搬进管理面第三键空间（规格 §2.6）—— 防回流保护；§2.3 现对它们零命中，加列即绿。
 * **节奏/清理旋钮管理化片（T11）追加六条**：六个节奏/清理 env 整体退役（搬进业务
 * 配置面第 35–40 键，规格 ⚙️8.3）—— 防回流保护；§2.3 现对它们零命中，加列即绿。
 */
const RETIRED_ENVS = [
  'ROBOT_RULE_FALLBACK',
  'ROBOT_SKILL_DISTRIBUTION',
  'ROBOT_RECLAIM_INTERVAL_MS',
  'PAY_PUBLIC_BASE_URL',
  'ALIPAY_SELLER_ID',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'ALERT_EMAIL_TO',
  'FEISHU_WEBHOOK_URL',
  'DINGTALK_WEBHOOK_URL',
  'DINGTALK_SECRET',
  'WECOM_WEBHOOK_URL',
  'PAY_SCAN_INTERVAL_MS',
  'PAY_RECONCILE_INTERVAL_MS',
  'CURRENCY_RECONCILE_INTERVAL_MS',
  'RISK_SCAN_INTERVAL_MS',
  'RECORDS_CLEANUP_INTERVAL_MS',
  'RISK_DEVICES_CLEANUP_INTERVAL_MS',
] as const;

/**
 * 片⑦（T17）后 + 货币片（T7）后 + 支付片（T2）后 + 支付配置管理化片（T11）后
 * + 通知通道管理化片（T10）后 + 广告片（T10）后，
 * §2.3 **必须**出现的新行（管理凭据 + 网关/消费侧接线；`CURRENCY_SERVICE_URL` = 货币片 T7，
 * 接口文档 §2.13；`PAYMENT_SERVICE_URL` = 支付片 T2 登记面，规格 §2.7.2；
 * `PAY_CONFIG_ENC_KEY` / `PAY_CHANNEL_PULL_TOKEN` = 支付配置管理化片 ⚙️5/⚙️13 ——
 * 渠道原六项 env 退役后的**根信任锚两键**（空默认透传；生产服务器 `.env` 必填）；
 * `NOTIFY_CHANNEL_PULL_TOKEN` = 通知通道管理化片 §2.6 —— 通知九键 env 退役后的
 * **根信任锚**（空默认透传；生产服务器 `.env` 必填、config/relay/renderer 三端同值）；
 * `AD_CHANNEL_PULL_TOKEN` = 广告片 §2.3 —— 第四键空间（广告回调密钥）的**拉取令牌**
 * （两持有 = config-service + currency-service、空默认透传；生产服务器 `.env` 两端必填、
 * 同值；主钥复用 `PAY_CONFIG_ENC_KEY`，无新主钥键）。
 * ⚠️ 支付片旧的 `PAY_PUBLIC_BASE_URL` / `ALIPAY_SELLER_ID` 两条已随本片移入
 * `RETIRED_ENVS`（Y5 两侧极化，列表只增不减）。
 * ⚠️ **时点（广告片）**：`AD_CHANNEL_PULL_TOKEN` 行**已随 T10-补（§2.3 前移）落地**
 * ——原计划 T24 文档波；控制者按「闸与文档面同提交」先例（通知 G2）裁定提前、
 * 同提交消红窗 ⇒ ② 断言对该条**已转绿**；T24 只余 design.md 其余散点。
 */
const NEW_ENVS = [
  'ADMIN_PASSWORD',
  'ADMIN_JWT_SECRET',
  'CONFIG_SERVICE_RPC_HOST',
  'CONFIG_SERVICE_RPC_PORT',
  'CONFIG_SERVICE_URL',
  'CURRENCY_SERVICE_URL',
  'PAYMENT_SERVICE_URL',
  'PAY_CONFIG_ENC_KEY',
  'PAY_CHANNEL_PULL_TOKEN',
  'NOTIFY_CHANNEL_PULL_TOKEN',
  'AD_CHANNEL_PULL_TOKEN',
  // 代理分润（2026-10-26）：会话签名钥、自玩 HMAC 钥、currency→user 两条边的地址。
  'AGENT_JWT_SECRET',
  'AGENT_PHONE_HMAC_KEY',
  'USER_SERVICE_RPC_HOST',
  'USER_SERVICE_RPC_PORT',
] as const;

describe('J18：docs/design.md 的片②修订机械闸（片⑦/T17 起第 ② 条极性已翻转；时点纪律见文件头）', () => {
  it('锚点自证：仓库根里找得到 docs/design.md（防静默扫到别处）', () => {
    expect(existsSync(join(REPO, 'docs', 'design.md'))).toBe(true);
    expect(sectionOf(read('docs/design.md'), '### 9.3', SECTION_END)).toContain('9.3');
  });

  it('J18①：§9.3 整节零 errorRate（注记行与表列都算）', () => {
    const slice = sectionOf(read('docs/design.md'), '### 9.3', SECTION_END);
    expect(slice).not.toMatch(/errorRate/);
  });

  it('J18③：§9.3 出现三个模型字面量 sl / douzero_WP / douzero_ADP', () => {
    const slice = sectionOf(read('docs/design.md'), '### 9.3', SECTION_END);
    for (const re of MODEL_LITERALS) {
      expect(slice, `§9.3 缺 ${String(re)} 对应的模型字面量`).toMatch(re);
    }
  });

  it('J18②：退役 env 不得再进 §2.3（片⑦ 收编 + 支付配置管理化片 T11 追加两退役 + 通知通道管理化片 T10 追加九退役 + 节奏/清理旋钮管理化片 T11 追加六退役）；各片新行必须进 §2.3 表', () => {
    const env = sectionOf(read('docs/design.md'), '### 2.3', SECTION_END);
    for (const name of RETIRED_ENVS) {
      expect(env, `${name} 已退役（片⑦ 收编进配置中心 / 支付配置管理化片 / 通知通道管理化片搬管理面，见 RETIRED_ENVS 注释），不得再出现在 §2.3 环境变量表里`).not.toContain(name);
    }
    for (const name of NEW_ENVS) {
      expect(env, `${name} 不在 §2.3 环境变量表里`).toContain(name);
    }
  });

  it('判别力自证：切片边界 —— 节前 / `## ` 之后（即便还有 `### `）的文本都不得混入', () => {
    const doc = ['HEAD 节前', '### 9.3 甲', '体内 errorRate', '## 夹击大节', '### 9.9 远节 TAIL'].join('\n');
    const slice = sectionOf(doc, '### 9.3', SECTION_END);
    expect(slice).toContain('体内 errorRate');
    expect(slice).not.toContain('HEAD 节前');
    expect(slice).not.toContain('夹击大节'); // `## ` 先到 ⇒ 到此为止
    expect(slice).not.toContain('TAIL'); // 更远的 `### ` 不再进（取先到者）
    // 找不到标题必须抛错（返回空串会让「不得包含」类断言恒绿）
    expect(() => sectionOf(doc, '### 8.8', SECTION_END)).toThrow();
  });

  it('判别力自证：§2.3 标题**行之前**的同名文本不得算进表内', () => {
    const doc = ['ADMIN_PASSWORD 在表前', '### 2.3 表', '| ADMIN_PASSWORD | 说明 |', '### 2.4 x'].join('\n');
    const env = sectionOf(doc, '### 2.3', SECTION_END);
    expect(env).toContain('ADMIN_PASSWORD');
    expect(env).not.toContain('表前');
  });

  it('判别力自证：`\\bsl\\b` 认独立模型名、不认含 sl 的普通词', () => {
    expect(/\bsl\b/.test('| beginner | `sl` |')).toBe(true);
    expect(/\bsl\b/.test('sl、douzero_WP、douzero_ADP')).toBe(true);
    expect(/\bsl\b/.test('models/sl/landlord.onnx')).toBe(true);
    expect(/\bsl\b/.test('rule/slow path')).toBe(false);
  });
});

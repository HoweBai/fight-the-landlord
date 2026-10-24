/**
 * R659「本地算分 / 凭空造数」痕迹的**唯一定义**（R617/R623 同族：本仓忌第二真源）。
 *
 * ## 两种形态（按**文件维度**选用）
 *
 * 协议⑥ 起牌桌**必须**显示服务端下发的底分（片规格 §3.2），而那个数字只能来自
 * `view.baseScore` ⇒ 在 `src/pages/table/table.vue` 里「底分」与 `baseScore` **本身合法** ——
 * 违规的是**凭空造数字**与**本地运算**。那是 `LOCAL_SCORING_TRACES`（**新形态**）。
 *
 * **豁免文件（新形态使用者）**：
 *   - `src/pages/table/table.vue`（中央场次名 + 底分，片规格 §3.2）
 *   - `src/components/Seat.vue`（2026-10 C 方案：免费场底分占位，牌桌左下角）
 *
 * **旧形态使用者**（= 新形态 ∪ 两条裸禁令）：
 *   `TABLE_AREA` 其余 9 个组件 —— 它们没有任何理由出现「底分」或 `baseScore`。
 * ⚠️ 旧形态是**超集**、不是回退：两条裸禁令**原样加回**，新形态补的那条（`/\b\w*[Bb]ase\w*\s*[*+/%-]\s*\d/`）也**保留**。
 *
 * ## 合流史（B1 评审裁决：消掉分叉）
 *
 * 这两张表此前分居两处：`table-bid-ui.test.ts`（新形态 7 条）与 `table-hud.test.ts`
 * 的**第二份副本**（旧形态 5 条、只扫 `TableHud.vue` —— 那条扫描面当时零命中，所以分叉
 * 不可观测）⇒ 同一道闸悄悄有了两种形态。B1 修复轮把定义合流到本文件，两个测试文件都从这里
 * import（`table-bid-ui.test.ts` 逐文件扫 `TABLE_AREA`；`table-hud.test.ts` 自扫 `TableHud.vue`）。
 *
 * ## 新形态的逐条来历（三条一个字不动 · 两条改形态 · 一条新增）
 *
 * 🔴 **三条一个字不动**（它们才是判别力所在）：
 *   `/×\s*\d/` · `/\b(?:bidMultiplier|multiplier)\s*[*+/%-]/` · `/Math\.pow\s*\(\s*2/`
 * 🔴 **两条改形态**（原形态在协议⑥ 之后会**误报**）：
 *   `/底分/` → 只禁**紧邻的数字字面量**（`底分 15` 这种硬编码；裸写「底分」字样合法）
 *   `/\bbaseScore\b/` → 只禁**赋值与运算**，允许 `store.view?.baseScore` 这样的**读取**
 * ➕ **一条新增（Task B1 自查发现的洞）**：`/\b\w*[Bb]ase\w*\s*[*+/%-]\s*\d/` ——
 *   「拿服务端底分**算一遍**再显示」（`底分 {{ sceneBase * 2 }}`）在改形态之后**没有任何
 *   一条旧条目会报**：变量名不叫 `baseScore` ⇒ 「对底分做本地运算」那条够不着；
 *   `底分` 后面紧跟的是 `{{` ⇒ 数值字面量那条也够不着。⇒ 按「**不得变松**」补上。
 *   ⚠️ **误报面（B1 评审 Minor 订正）**：要求运算符后**紧跟数字** ⇒ BEM 双连字符
 *   （`scene-base--muted`）不会被误报；但**单连字符 + 数字**的形态（`scene-base-2`）
 *   **会**误报（`-` 在运算符集合里、后面紧跟 `2`）。落地时对全 `src/**` 实测**零命中**
 *   （含这类形态）。这是「变量名不可枚举」那一层余量的最小补丁 —— 它的射程 =
 *   **直接写在标识符上的运算**，**不覆盖** `(sceneBase ?? 0) * 2` 这一形态；
 *   那一形态由 `table-center.test.ts` 的**精确文本**断言（`.toBe('底分 15')`）兜住。
 *
 * ⚠️ 违规类断言一律读**剥注释**视图（`helpers/source-scan.ts` 的 `stripComments`，R572/R622）：
 *    解释一个禁词的注释不该把闸打红。
 */

export interface ScoringTraceRule {
  re: RegExp;
  what: string;
}

/** **新形态**：只给 `src/pages/table/table.vue`（它**必须**显示服务端底分）。 */
export const LOCAL_SCORING_TRACES: ScoringTraceRule[] = [
  { re: /×\s*\d/, what: '本地拼出的「×N」倍数' },
  { re: /底分\s*[=:：]?\s*\d/, what: '底分的**数值字面量**（服务端字段以外的数字）' },
  { re: /\b(?:const|let|var)\s+\w*baseScore\b/, what: '本地声明底分变量' },
  { re: /\bbaseScore\s*[*+/%-]/, what: '对底分做本地运算' },
  { re: /\b\w*[Bb]ase\w*\s*[*+/%-]\s*\d/, what: '对底分**变量**做本地运算（如 `sceneBase * 2`）' },
  { re: /\b(?:bidMultiplier|multiplier)\s*[*+/%-]/, what: '对倍数做本地运算' },
  { re: /Math\.pow\s*\(\s*2/, what: '本地按 2 的幂算倍数' },
];

/**
 * **旧形态**：给 `TABLE_AREA` 里**除 `table.vue` 外**的 9 个组件（含 `TableHud.vue` 的自扫）。
 * = 新形态 ∪ 两条裸禁令（**原样加回**，见文件头「合流史」与「超集」说明）。
 */
export const LOCAL_SCORING_TRACES_LEGACY: ScoringTraceRule[] = [
  ...LOCAL_SCORING_TRACES,
  { re: /底分/, what: '出现「底分」字样（底分只显示在中央的 table.vue，其余牌桌区组件不得提及）' },
  { re: /\bbaseScore\b/, what: '引用 `baseScore` 字段（同上：只有中央需要它）' },
];

/** 找出 `source` 命中的痕迹（默认按**新形态**；旧形态显式传 `LOCAL_SCORING_TRACES_LEGACY`）。 */
export function localScoringTraces(
  source: string,
  rules: ScoringTraceRule[] = LOCAL_SCORING_TRACES,
): string[] {
  return rules.filter(({ re }) => re.test(source)).map(({ what }) => what);
}

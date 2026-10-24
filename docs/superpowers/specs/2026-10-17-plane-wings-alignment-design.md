# 斗地主规则对齐 DouZero 生成器 · 设计 v1.0

> **定位**：把本项目玩家规则中「飞机带单」的翅膀判定放宽到 DouZero 生成器实际会产出、且其检测器认可的形态。目标不是逐字复刻 DouZero，而是让**机器人能打出的合法牌，玩家也能打**，减少服务端 `action-rejected` 回退。
> **状态**：设计定稿，供实施计划消费。用户裁决见 §0。
> **接触面**：`packages/protocol/src/rule.ts` · `packages/shared/src/rule/autoplay.ts` · `apps/client/src/game/hint.ts` · 测试与文档。

---

## §0 用户裁决（本设计不得与之冲突）

| # | 裁决 | 影响 |
|---|---|---|
| K1 | 对齐 **DouZero 生成器会产出、且检测器认可**的牌型 | 不接受检测器单独宽松识别的组合（两个炸弹的四带两对、`3333+4` 当三带二、特判携带多余单牌） |
| K2 | 支持两条扩展：飞机带单的**对子/混合翅膀**；**4 三张特判** | 见 §2 |
| K3 | 4 三张特判的比较点数 = **主体起点** | 与 DouZero `get_move_type` 返回的 `rank` 一致；不复制其过滤器的「最大三张」bug |
| K4 | 客户端只更新 `hasBeatablePlay` | `suggestPlays` 本来就不枚举复杂牌型，本次不动 |

---

## §1 范围

### 1.1 本片做

1. **飞机带单翅膀放宽**：`n` 张翅膀中，每个非主体点数可出 1 或 2 张（对子可以当两张单牌用），不得出 3 张及以上、不得 4 张。
2. **4 三张特判**：恰有 4 个三张点数、其中 3 个连续时，把连续的 3 组当主体、剩下那组三张当 3 张翅膀。
3. **规则引擎同步**：`findSmallestBeatingCards` 能生成上述形态（机器人兜底、托管）。
4. **客户端提示同步**：`hasBeatablePlay` 不再对这些形态误判「要不起」。
5. **测试与文档**：协议/规则引擎/提示三处单测，玩法文档与偏差台账。

### 1.2 明确不做

- 两个炸弹作四带两对（`3333+4444`）。
- `3333+4` 当三带二、特判携带多余单牌等检测器怪癖。
- 四张同点当翅膀。
- `suggestPlays` 扩到飞机/三带等复杂牌型（独立的提示增强项）。
- 数据库、REST/WS 协议形状、gateway、room-service、robot-service、结算/战绩。

---

## §2 规则语义

### 2.1 飞机带单（放宽）

`parseHand` 在主体连续且 `planeLen >= 2` 时：

```ts
if (
  planeLen * 4 === cards.length &&
  a.fours.length === 0 &&
  a.ones.length + 2 * a.pairs.length === planeLen
) {
  return { type: HandType.PlaneWithSingles, keyRank: a.trios[0], length: planeLen, cards };
}
```

含义：翅膀总**张数**必须等于主体三张组数；每个翅膀点数只能贡献 1 张（单）或 2 张（对）；出现四张即非法。

### 2.2 4 三张特判

在标准飞机分支全部不匹配之后：

```ts
if (a.trios.length === 4 && cards.length === 12) {
  if (isContinuous(a.trios.slice(1))) {
    return { type: HandType.PlaneWithSingles, keyRank: a.trios[1], length: 3, cards };
  }
  if (isContinuous(a.trios.slice(0, 3))) {
    return { type: HandType.PlaneWithSingles, keyRank: a.trios[0], length: 3, cards };
  }
}
```

- 只适用于**恰好 4 个三张、12 张牌**（`cards.length === 12` + 4 个三张已经蕴含没有其他点数）。
- 4 组都连续时，前面的裸飞机分支先命中（`Plane`, `length = 4`），不会走到特判——与 DouZero 的判定顺序一致。
- 比较点数 = 主体起点（K3）。

### 2.3 判定顺序

保持现有顺序：王炸 → 炸弹 → 四带二/四带两对 → 三带一/三带二 → **裸飞机 → 飞机带单 → 飞机带对 → 特判** → 顺子 → 连对 → 单/对/三 → Invalid。

特判必须放在飞机分支之外（`isContinuous(a.trios)` 为假时才会到达）。

### 2.4 正反例

| 牌组 | 结果 | 说明 |
|---|---|---|
| `333444 + 55` | PlaneWithSingles, len 2, key 3 | 对子当两张翅膀 |
| `333444 + 5 + 6` | PlaneWithSingles, len 2, key 3 | 两个异点单张（回归） |
| `333444 + 55 + 66` | PlaneWithPairs, len 2 | 走既有带对分支 |
| `333444 + 555` | Plane, len 3 | 三组连续，裸飞机 |
| `333444555 + 777` | PlaneWithSingles, len 3, key 3 | 4 三张特判 |
| `555666777 + 333` | PlaneWithSingles, len 3, key 5 | 特判，翅膀点数更低 |
| `333444555 + 222` | PlaneWithSingles, len 3, key 3 | 翅膀三张可以是 2 |
| `333444555666` | Plane, len 4 | 4 组全连续，裸飞机 |
| `333444666 + 777` | Invalid | 没有 3 组连续主体 |
| `333444 + 5555` | Invalid | 四张不能当翅膀 |
| `333444 + 55 + 6` | Invalid | 翅膀张数 3 ≠ 主体组数 2 |
| `3333 + 4444` | Invalid | 不采纳两个炸弹 |

---

## §3 组件改动

### 3.1 `packages/protocol/src/rule.ts`

- 放宽 `PlaneWithSingles` 条件（§2.1）。
- 新增 4 三张特判分支（§2.2）。
- `canBeat` 不变（按 type + length + keyRank 比较）。

### 3.2 `packages/shared/src/rule/autoplay.ts`

`takePlaneWithWings(hand, keyRank, planeLen, 1)`：

- 对每个严格大于目标点数的连续主体窗口，构造翅膀候选：
  1. **优先全单张**：取最小的 `planeLen` 个异点单张；
  2. 不足时，允许把某个点数取 2 张（对子）；
  3. 若 `planeLen === 3` 且手中存在一个不在主体内的三张点数，允许用该三张当翅膀（特判形态）。
- 每个候选最终仍交给 `parseHand` 自检（与 hint 同纪律），非法则继续。
- **确定性顺序**：主体起点升序优先；同一主体内，翅膀选择固定为「全单张 → 单张+对子混合（点数升序）→ 全对子 → 特判三张翅膀」。保证「最小可压」在多次运行与不同实现间一致，测试可断言。
- `PlaneWithPairs`、`FourWithTwo*` 逻辑不变。

### 3.3 `apps/client/src/game/hint.ts`

`hasBeatablePlay` 的 `PlaneWithSingles` 分支：

- 把 `pickWingRanks(w, 1, len)` 的单一逻辑扩展为「同 §3.2 的翅膀组合枚举」。
- 候选仍经 `parseHand` + `canBeat` 自检（source-boundary ⑤）。
- `suggestPlays` 不动（K4）。
- `cannotBeat` 的语义保持：只有确凿无解才隐藏按钮。

---

## §4 残余与兼容

| 项 | 处理 |
|---|---|
| DouZero 生成器可能产出四张翅膀（n=4 时），被自身检测器拒绝 | 我们不接受；服务端拒绝后走现有回退链 |
| DouZero 特判的过滤器按「最大三张」比较（与检测器 rank 矛盾） | 我们按主体起点（K3）；极少数特判跟牌会被服务端拒绝并回退 |
| 旧客户端 | 不本地拦截出牌 ⇒ 服务端先上线即生效；旧客户端只是提示不推荐。客户端提示可后发 |
| 历史记录/回放 | 只存牌面，不存牌型 ⇒ 无需迁移 |

---

## §5 测试

### 5.1 protocol / shared

- `rule.test.ts`：§2.4 全部正反例；`3333+4444` 仍 Invalid（回归）。
- `autoplay.test.ts`：新增对子翅膀、混合翅膀、特判的「最小可压」用例；现有「主体四张不得当翅膀」用例保留。
- `hint.test.ts`：现有「同点两张不能当两个互异单翼」由 false **翻为 true**；新增特判用例。
- `hint-crosscheck.test.ts`：保持零误杀；必要时新增对子翅膀目标样本。

### 5.2 全量回归

`protocol` / `shared` / `client` / `game-service` / `robot-service` 的测试与 lint。

---

## §6 文档

- `docs/games/doudizhu.md` §4.2：翅膀约束表、示例、变更记录。
- `docs/design.md:2230`：偏差说明改为「已对齐生成器；两个炸弹与检测器怪癖有意不支持」。
- `docs/superpowers/plans/deviation-ledger.md`：如登记过本差异，同步更新。

---

## §7 估时

| 项 | 估时 |
|---|---|
| `rule.ts` + 单测 | 0.5 天 |
| `autoplay.ts` + 单测 | 0.5–1 天 |
| `hint.ts` + 单测 | 0.5 天 |
| 文档 + 全量回归 | 0.5–1 天 |
| **合计** | **2–3 人天** |

# 匹配等待提示：底部悬浮卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把缺人等待提示从文档流内的小盒子改为底部居中悬浮卡片，文案改为友好中性且不暴露机器人；
不改任何协议消息、匹配状态机或服务端逻辑。

**Architecture:** 服务端只改 `MATCH_WAIT_PROMPT_MESSAGE` 常量；客户端把提示块从 `.game__stage`
移到 `.game` 根下的绝对定位浮层（`pointer-events` 分层），重做玻璃态样式；匹配中给好友房入口
加 `visibility: hidden` 保留布局盒；新增轻量上浮动画。测试按「文案 / DOM 结构 / 源码样式 /
动画降级 / 文档文案」五个面钉住。

**Tech Stack:** Vue 3 + uni-app（`view`/`text`/`button`）、SCSS 令牌（`$ftl-*`）、
vitest + @vue/test-utils、NestJS（room-service，仅常量）。

**规格：** `docs/superpowers/specs/2026-10-21-match-wait-prompt-floating-design.md`（第一真源；
判据 C1–C18 与本文逐一对应）。

**分支：** `dev`（日常开发分支；本次不推送、不发版）。

**执行期回填 v1.1（2026-10-21，代码审查 r1）：** 真实 `uni-button` 盒模型
（`box-sizing:border-box; line-height:2.5555`）使 56px 按钮实高 70.4px ⇒ 卡片压住
「取消匹配」10px（I1）；死态横条在文档流里把中央区下移 30px、页面级 error 被卡片盖住
（I2）。已修：按钮显式 `line-height:1.2`、`bottom` 改 72、死态横条改顶部悬浮、
`ConnectionDeadBar` 上报 `dead-change`、错误/死态时卡片卸载。M1–M9 已处置/登记；
详见 spec §10。

## Global Constraints

- **不动协议**：`match.wait_prompt` / `room.match.extend` / `room.unmatch` / `room.match`
  的消息名、载荷、ack 语义一字不改。
- **唯一 `room.match` 发送点**：`game.vue` 的 `send('room.match'` 仍恰好 1 处
  （`settlement-rematch.test.ts` ⑤ 的源码计数闸）。
- **`.game__match button` 唯一**：浮层必须放在 `.game__match` 外面；测试用
  `findAll` 数量断言，不用 `find`。
- **样式只用令牌**：单位 `px`，描边用 `$ftl-hairline`，不写裸 `1px`；不新增原色 hex。
- **动画纪律**：起始态必须可见（不用 `opacity: 0`）、只动 `transform`、零 JS 定时器；
  新动画必须进 `prefers-reduced-motion` 降级清单。
- **BOM**：`apps/client/src/pages/game/game.vue` 带 UTF-8 BOM；编辑后核对前 3 字节仍是
  `EF BB BF`（用 `python -c` 或 `xxd`）。
- **文案真源**：玩家可见文案只改服务端常量；客户端不新增第二份生产文案。
- **每任务一个 commit**，提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 测试命令统一在**仓库根**执行；Windows + Git Bash。

---

## Task 0: 计划入库

- [ ] 0.1 回填本文末尾「计划审查记录」，提交计划文件（`dev-process.md:132` 要求计划入库；
  否则收口「工作区干净」必然失败）。

```bash
git add docs/superpowers/plans/2026-10-21-match-wait-prompt-floating.md
git commit -m "docs(game): 等待提示悬浮卡片实现计划（含计划对抗审查记录）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 之后每个任务把本计划文件一起 `git add`，用勾选状态记录进度。

---

## Task 1: 服务端友好文案 + 文案红线判据

**覆盖判据：C10 / C11**（C12 是「fixture 不写第二份字面量」的实现纪律，无独立判据；
信封形状由既有 `toEqual` 钉住）

**Files:**
- Modify: `packages/room-service/src/match/match.service.ts:73-78`
- Modify: `packages/room-service/test/match.service.test.ts`（`机器人补位开关片` describe 开头）
- Modify: `packages/room-service/test/ws.gateway.test.ts`（import + 两处字面量）

**Interfaces:**
- `export const MATCH_WAIT_PROMPT_MESSAGE: string`（值变，签名不变）
- 网关推送形状不变：`match.wait_prompt` → `{ version: 0, payload: { message } }`

### Steps

- [x] **1.1 先写失败测试（C10/C11）**

在 `packages/room-service/test/match.service.test.ts` 的
`describe('机器人补位开关片：关闭时缺人只提示不补机器人、到上限 12007', ...)` 内、
第一个 `it` 之前加入：

```ts
/**
 * 面向玩家的文案红线：
 *  - 友好、中性，不提「真人 / 机器人 / 玩家不足」（不能暴露机器人补位）；
 *  - 长度 ≤ 16 字：悬浮卡片按单行排版，2 行会压住「取消匹配」（设计 spec §4.3）。
 * 旧文案同时作为负样本，证明判据真的能抓住回归。
 */
it('C10/C11：等待提示文案友好、不暴露机器人且长度受控', () => {
  expect(MATCH_WAIT_PROMPT_MESSAGE).toBe('正在为你安排牌桌，请稍等片刻。');
  expect(MATCH_WAIT_PROMPT_MESSAGE.length).toBeLessThanOrEqual(16);

  const banned = ['真人', '机器人', '玩家不足'];
  for (const word of banned) {
    expect(MATCH_WAIT_PROMPT_MESSAGE).not.toContain(word);
  }

  // 判别力自证：旧文案必须被同一组谓词命中。
  const oldCopy = '当前在线真人玩家不足，可延长匹配时间继续等待，或重新匹配';
  expect(banned.some((word) => oldCopy.includes(word))).toBe(true);
  expect(oldCopy.length).toBeGreaterThan(16);
});
```

- [x] **1.2 跑红**

```bash
pnpm --filter @fight-the-landlord/room-service exec vitest run test/match.service.test.ts
```

预期：C10 失败（当前常量是旧文案），其他用例不受影响。

- [x] **1.3 改常量与注释**

`packages/room-service/src/match/match.service.ts`：

```ts
/**
 * 机器人补位开关片：补机器人**关闭**时，越过等待窗口发给在等玩家的友好提示文案
 * （`match.wait_prompt`）。票不终止 —— 玩家可「继续等待」或取消后「重新匹配」。
 *
 * ⚠️ 面向玩家：不出现「真人 / 机器人 / 玩家不足」等表述（不暴露补位机制）；
 * 长度 ≤ 16 字（客户端底部悬浮卡片按单行排版，见设计 spec §4.3）。
 */
export const MATCH_WAIT_PROMPT_MESSAGE = '正在为你安排牌桌，请稍等片刻。';
```

- [x] **1.4 跑绿（含网关）**

先把 `packages/room-service/test/ws.gateway.test.ts` 的两处字面量改成常量引用：
在文件顶部从 `../src/match/match.service` 的 import 中加 `MATCH_WAIT_PROMPT_MESSAGE`
（若已有 `import type { MatchService }`，另起一行值导入），然后把
`:1665` / `:1674` 的旧字符串替换为 `MATCH_WAIT_PROMPT_MESSAGE`。

```bash
pnpm --filter @fight-the-landlord/room-service exec vitest run test/match.service.test.ts test/ws.gateway.test.ts
```

预期：两个文件全绿。

- [x] **1.5 类型检查**

```bash
pnpm --filter @fight-the-landlord/room-service run lint
```

预期：通过。

- [x] **1.6 Commit**

```bash
git add packages/room-service/src/match/match.service.ts packages/room-service/test/match.service.test.ts packages/room-service/test/ws.gateway.test.ts docs/superpowers/plans/2026-10-21-match-wait-prompt-floating.md
git commit -m "feat(match): 等待提示文案改为友好中性、不暴露机器人

- MATCH_WAIT_PROMPT_MESSAGE: 当前在线真人玩家不足… → 正在为你安排牌桌，请稍等片刻。
- 新增 C10/C11：逐字文案 + 长度 ≤16 + 禁词红线（旧文案作负样本）
- ws.gateway 测试改为 import 常量，消除第二份字面量

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 客户端底部悬浮卡片 + 好友房入口匹配态隐藏 + 动画

**覆盖判据：C1–C9 / C14**

**Files:**
- Modify: `apps/client/src/pages/game/game.vue`
- Modify: `apps/client/src/styles/animations.scss`
- Modify: `apps/client/test/auth-ui-wiring.test.ts`
- Modify: `apps/client/test/match-state.test.ts`
- Modify: `apps/client/test/notice-presentation.test.ts`
- Modify: `apps/client/test/animations.test.ts`

### Steps

- [x] **2.1 先写失败测试（C1–C6 / C14）**

`apps/client/test/auth-ui-wiring.test.ts`：

1. 把 `const PROMPT_TEXT = '当前在线真人玩家不足…'` 改为
   `const PROMPT_TEXT = '正在为你安排牌桌，请稍等片刻。';`
2. 第一个用例的断言改为：

```ts
expect(wrapper.find('.game__waitprompt-layer').exists()).toBe(true);
expect(wrapper.find('.game__waitprompt').exists()).toBe(true);
expect(wrapper.find('.game__waitprompt-text').text()).toBe(PROMPT_TEXT);
// 浮层必须在中央舞台之外，且是 .game 的直接子元素（不参与布局的结构证据）。
expect(wrapper.find('.game__stage .game__waitprompt').exists()).toBe(false);
expect(
  wrapper.find('.game__waitprompt-layer').element.parentElement?.classList.contains('game'),
).toBe(true);
const labels = wrapper.findAll('.game__waitprompt-btn').map((b) => flat(b.text()));
expect(labels).toEqual(['重新匹配', '继续等待']);
// 数量断言：匹配区容器内仍恰好一个按钮（取消匹配）。
const matchButtons = wrapper.findAll('.game__match button');
expect(matchButtons).toHaveLength(1);
expect(matchButtons[0]!.text()).toBe('取消匹配');
```

3. 「继续等待」用例：按钮查找文案由 `'延长匹配时间'` 改为 `'继续等待'`。
4. 新增 C14 用例。**插入位置**：`describe('机器人补位开关关：match.wait_prompt 友好弹窗')`
   内、`PROMPT_TEXT` 定义之后。`stubRoomsFetch` / `mountGameWithSocket` 从外层 describe
   闭包可见，`enterMatching` 同层可见；**不要**追加到文件末尾（作用域外 ⇒ TS2304 /
   ReferenceError）。同时把该 describe 的标题与类注释里的「延长匹配时间 / 弹窗」改为
   「继续等待 / 悬浮卡片」。

```ts
it('C14：匹配中好友房入口视觉隐藏但保留布局盒；匹配结束恢复', async () => {
  stubRoomsFetch();
  const { wrapper, socket } = mountGameWithSocket();
  await flushPromises();
  const friends = wrapper.find('.game__friends-open');
  expect(friends.exists()).toBe(true);
  expect(friends.classes()).not.toContain('game__friends-open--matching');

  await enterMatching(wrapper, socket);
  expect(wrapper.find('.game__friends-open').classes()).toContain(
    'game__friends-open--matching',
  );
  expect(wrapper.find('.game__friends-open').attributes('disabled')).toBeDefined();

  socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
  await flushPromises();
  expect(wrapper.find('.game__friends-open').classes()).not.toContain(
    'game__friends-open--matching',
  );
});
```

5. `apps/client/test/match-state.test.ts`：两处旧文案样例改为新文案（只是 store 样例，
   不引入业务断言）。

- [x] **2.2 先写失败测试（C7/C8/C14b 源码级）**

`apps/client/test/notice-presentation.test.ts` 末尾新增：

```ts
describe('缺人等待提示：底部悬浮卡片（不挤页面）', () => {
  it('C7/C8：层绝对定位、z-index 5、不拦截点击；卡片恢复可点击', () => {
    const source = sourceOf('src/pages/game/game.vue');
    const layer = ruleBody(source, '.game__waitprompt-layer');
    expect(layer, '.game__waitprompt-layer 规则必须存在').not.toBeNull();
    expect(layer, '浮层必须不参与文档流').toContain('position: absolute');
    expect(layer, '浮层层级低于全屏弹层').toContain('z-index: 5');
    expect(layer, '全宽层不得拦截下层点击').toContain('pointer-events: none');

    const card = ruleBody(source, '.game__waitprompt');
    expect(card, '.game__waitprompt 规则必须存在').not.toBeNull();
    expect(card, '卡片自身必须恢复点击').toContain('pointer-events: auto');
    expect(card, '长文案必须有宽度上限').toContain('max-width');

    // 判别力自证：文档流内 / 缺 pointer-events 的旧形态样本必须判负。
    expect(ruleBody('.game__waitprompt-layer { display: flex; }', '.game__waitprompt-layer'))
      .not.toContain('position: absolute');
    expect(ruleBody('.game__waitprompt { width: 320px; }', '.game__waitprompt'))
      .not.toContain('pointer-events: auto');
  });

  it('C14b：匹配中好友房入口隐藏类只改 visibility（保留布局盒）', () => {
    const hidden = ruleBody(sourceOf('src/pages/game/game.vue'), '.game__friends-open--matching');
    expect(hidden, '.game__friends-open--matching 规则必须存在').not.toBeNull();
    expect(hidden).toContain('visibility: hidden');
    expect(hidden).not.toContain('display: none');
  });
});
```

- [x] **2.3 先写失败测试（C9 动画）**

`apps/client/test/animations.test.ts` 末尾新增（复用文件顶部的 `sources` / `anim`）：

```ts
/**
 * C9：新动画必须真的被降级覆盖、关键帧存在且起始态可见、模板真的使用它。
 * ⚠️ 不能对整份文件做 `toContain('.anim-float-up')` —— 类规则本身就会命中，
 * 即使媒体查询清单没加也绿（审查发现的高-2）。
 */
describe('C9：ftl-float-up 入场动画', () => {
  /** 从 `at` 起找第一个 `{`，按花括号配对返回块内文本（不含最外层花括号）。 */
  function braceBlock(src: string, at: number): string | null {
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return null;
  }

  function reducedMotionBlock(src: string): string | null {
    const at = src.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    return at < 0 ? null : braceBlock(src, at);
  }

  it('降级清单的媒体查询块内含 .anim-float-up（含正反对照）', () => {
    const code = stripComments(anim!.content);
    const block = reducedMotionBlock(code);
    expect(block, 'prefers-reduced-motion 媒体查询必须存在').not.toBeNull();
    expect(block).toContain('.anim-float-up');

    const inside =
      '@media (prefers-reduced-motion: reduce) { .anim-float-up { animation: none !important; } }';
    const outside =
      '.anim-float-up { animation: x 1s; } @media (prefers-reduced-motion: reduce) { .anim-deal-in { animation: none !important; } }';
    expect(reducedMotionBlock(inside)).toContain('.anim-float-up');
    expect(reducedMotionBlock(outside)).not.toContain('.anim-float-up');
  });

  it('关键帧存在、只动 transform、起始态可见', () => {
    const code = stripComments(anim!.content);
    const at = code.search(/@keyframes\s+ftl-float-up/);
    expect(at, '@keyframes ftl-float-up 必须存在').toBeGreaterThanOrEqual(0);
    const body = braceBlock(code, at);
    expect(body).not.toBeNull();
    expect(body).toContain('transform');
    expect(body, '起始态不得用 opacity: 0（降级时必须可见）').not.toContain('opacity');
  });

  it('game.vue 实际使用了 .anim-float-up（防死动画）', () => {
    const game = sources.find((f) => f.path === 'src/pages/game/game.vue');
    expect(game, 'game.vue 必须在源码扫描集合里').toBeDefined();
    expect(stripComments(game!.content)).toContain('anim-float-up');
  });
});
```

- [x] **2.4 跑红**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/auth-ui-wiring.test.ts test/notice-presentation.test.ts test/animations.test.ts test/match-state.test.ts
```

预期：C1–C9/C14 全部失败（旧模板/旧样式/缺动画）；其余用例仍绿。

- [x] **2.5 改模板：浮层移出 `.game__stage`**

`apps/client/src/pages/game/game.vue`：

1. 删除 `.game__stage` 内 834–854 行的旧 `<view v-if="waitPrompt" class="game__waitprompt">…</view>`。
2. 在 `<PlayerChip class="game__player" … />` 之后、好友房弹层之前插入：

```html
<!-- 缺人等待提示：底部悬浮卡片，不参与文档流（设计 spec D2/D3）。 -->
<view v-if="waitPrompt" class="game__waitprompt-layer">
  <view class="game__waitprompt anim-float-up" role="status">
    <view class="game__waitprompt-main">
      <text class="game__waitprompt-icon" aria-hidden="true">⏳</text>
      <text class="game__waitprompt-text">{{ waitPrompt }}</text>
    </view>
    <view class="game__waitprompt-actions">
      <button
        type="button"
        class="btn btn--small game__waitprompt-btn"
        :disabled="busy"
        @click="rematchAfterPrompt"
      >
        重新匹配
      </button>
      <button
        type="button"
        class="btn btn--primary btn--small game__waitprompt-btn"
        :disabled="busy"
        @click="extendMatching"
      >
        继续等待
      </button>
    </view>
  </view>
</view>
```

3. 好友房入口加 `:class`（保留 `v-if` / `:disabled`）：

```html
:class="{ 'game__friends-open--matching': matching }"
```

4. 更新注释（注释不算行为改动）：
   - `waitPrompt` 上方（`game.vue:545`）：`弹窗态` → `底部悬浮卡片态`；
   - `extendMatching` 上方（`game.vue:551`）：`「延长匹配时间」` → `「继续等待」`，
     `关掉弹窗` → `关掉浮层`；
   - `rematchAfterPrompt` 上方（`game.vue:569-577`）无「延长」字样，只把「弹窗」按需改为
     「浮层」（该段本身没有「弹窗」则不动）。

- [x] **2.6 改样式：玻璃态悬浮卡片**

替换 `game.vue` 的 `.game__waitprompt*` 规则（**1256–1299 行**，止于 `.game__waitprompt-btn[disabled]`；**不要**包含 1300 行起的 `.game__player`）为：

```scss
/**
 * 缺人等待提示：底部悬浮卡片（不参与文档流；与 `.game__notice` 同族的悬浮手法）。
 * ⚠️ 定位上下文是 `.canvas`（`.game` 是 static）；不得给 `.game` 加 position/transform。
 * ⚠️ 全宽层 pointer-events:none，卡片自身 auto —— 空白区不拦截下层点击。
 */
.game__waitprompt-layer {
  position: absolute;
  right: 0;
  bottom: calc($ftl-control-h-sm + $ftl-space-7);
  left: 0;
  z-index: 5;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.game__waitprompt {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 640px;
  max-width: calc(100% - 2 * $ftl-space-9);
  padding: $ftl-space-5 $ftl-space-7;
  border: $ftl-hairline solid rgba($ftl-color-gold-light, 0.55);
  border-radius: $ftl-radius-lg;
  background: linear-gradient(
    160deg,
    rgba($ftl-color-night-soft, 0.94),
    rgba($ftl-color-night-deep, 0.96)
  );
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.5),
    inset 0 2px 0 rgba(255, 215, 0, 0.18);
  backdrop-filter: blur(20px);
  pointer-events: auto;
}
.game__waitprompt-main {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-4;
}
.game__waitprompt-icon {
  flex: 0 0 auto;
  font-size: $ftl-font-xl;
  line-height: 1;
}
.game__waitprompt-text {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  line-height: 1.5;
  text-align: center;
}
.game__waitprompt-actions {
  display: flex;
  gap: $ftl-space-5;
}
.game__waitprompt-btn {
  flex: 1;
  margin: 0;
}
/** 匹配中：好友房入口禁用且被悬浮卡片压住 ⇒ 视觉隐藏但保留 88px 布局盒。 */
.game__friends-open--matching {
  visibility: hidden;
}
```

> ⚠️ 旧的 `.game__waitprompt-btn` 自定义描边/底色/行高全部删除：按钮改用页面
> `.btn` / `.btn--small` / `.btn--primary` 语言（D5）。

- [x] **2.7 新增动画**

`apps/client/src/styles/animations.scss`：在 `ftl-toast-in` 之后加关键帧，在
`.anim-toast-in` 之后加类，并把 `.anim-float-up` 加进 reduced-motion 清单：

```scss
/** 底部浮层入场：轻微上浮（只动 transform，起始态可见）。 */
@keyframes ftl-float-up {
  from {
    transform: translateY(12px);
  }
  to {
    transform: none;
  }
}
```

```scss
.anim-float-up {
  animation: ftl-float-up .24s $ftl-ease both;
}
```

```scss
@media (prefers-reduced-motion: reduce) {
  .anim-deal-in,
  .anim-played-in,
  .anim-reveal-in,
  .anim-settlement-in,
  .anim-toast-in,
  .anim-float-up,
  .anim-urgent-pulse,
  .anim-wait-dot {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
```

- [x] **2.8 跑绿**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/auth-ui-wiring.test.ts test/notice-presentation.test.ts test/animations.test.ts test/match-state.test.ts
```

预期：全绿。

- [x] **2.9 类型检查 + BOM 核对**

```bash
pnpm --filter @fight-the-landlord/client run lint
python -c "print(open('apps/client/src/pages/game/game.vue','rb').read(3).hex())"
```

预期：lint 通过；前 3 字节为 `efbbbf`。

- [x] **2.10 Commit**

```bash
git add apps/client/src/pages/game/game.vue apps/client/src/styles/animations.scss apps/client/test/auth-ui-wiring.test.ts apps/client/test/match-state.test.ts apps/client/test/notice-presentation.test.ts apps/client/test/animations.test.ts docs/superpowers/plans/2026-10-21-match-wait-prompt-floating.md
git commit -m "feat(client): 等待提示改底部悬浮卡片 + 友好按钮文案

- 浮层移出 .game__stage，absolute 底部居中、pointer-events 分层，不挤原 UI
- 深蓝玻璃态卡片 + 金色描边 + 56px 按钮；主按钮改为「继续等待」
- 匹配中好友房入口 visibility:hidden 保留布局盒，避免卡片压控件
- 新增 ftl-float-up 入场动画（reduced-motion 降级）
- 测试 C1–C9/C14：DOM 结构、数量断言、源码样式、动画判据

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 协议/设计文档同步 + 文档文案判据

**覆盖判据：C13**

**Files:**
- Modify: `docs/client-protocol.md`（§4.3 第 10 条、§5 第 11 条）
- Modify: `docs/design.md:980,991`
- Modify: `docs/ops/first-deploy.md:1030,1032`（运维文档动作名）
- Modify: `apps/client/test/protocol-doc-sync.test.ts`

### Steps

- [x] **3.1 先写失败测试（C13）**

在 `apps/client/test/protocol-doc-sync.test.ts` 末尾新增：

```ts
/**
 * C13：等待提示的动作名与展示形态在文档里同步。
 *
 * ⚠️ 只抓**表格行**，与既有对账闸同一口径；散文里的历史语义不参与。
 * ⚠️ 每条谓词都配旧行负样本，证明判据能抓住回归（R115/R150）。
 */
describe('等待提示：文档动作名与展示形态', () => {
  /**
   * 按**消息名列**选行（第二列 / 方向列之后的第一个反引号单元格）。
   * ⚠️ 不能按「行内包含消息名」选：`room.match.extend` 行会在散文里提到
   * `match.wait_prompt`（「收到 `match.wait_prompt` 后…」），先命中 extend 行，
   * 导致 prompt 谓词永远红（计划审查 F1）。
   */
  function docRow(text: string, name: string): string {
    const token = `\`${name}\``;
    const rows = text.split('\n').filter((line) => {
      if (!line.trim().startsWith('|')) return false;
      const cells = line.trim().split('|');
      return cells[2]?.trim() === token;
    });
    expect(rows, `文档里的消息名列必须恰好有一行是 ${name}`).toHaveLength(1);
    return rows[0]!;
  }

  /** `match.wait_prompt` 行：动作名 + 悬浮卡片形态。 */
  function isUpdatedPromptRow(row: string): boolean {
    return (
      row.includes('继续等待') &&
      row.includes('悬浮卡片') &&
      !row.includes('延长匹配时间') &&
      !row.includes('弹窗')
    );
  }

  /** `room.match.extend` 行：只要求动作名同步（该行本来就不描述展示形态）。 */
  function isUpdatedExtendRow(row: string): boolean {
    return row.includes('继续等待') && !row.includes('延长匹配时间');
  }

  it('docs/client-protocol.md 两行已同步', () => {
    expect(isUpdatedPromptRow(docRow(doc, 'match.wait_prompt'))).toBe(true);
    expect(isUpdatedExtendRow(docRow(doc, 'room.match.extend'))).toBe(true);
  });

  it('docs/design.md 两行已同步', () => {
    const design = readFileSync(join(SRC_ROOT, '..', '..', '..', 'docs', 'design.md'), 'utf8');
    expect(isUpdatedPromptRow(docRow(design, 'match.wait_prompt'))).toBe(true);
    expect(isUpdatedExtendRow(docRow(design, 'room.match.extend'))).toBe(true);
  });

  it('判别力自证：旧行样本必须判负，且选行不串行', () => {
    const oldPrompt =
      '| 11 | `match.wait_prompt` | `{ message: string }` | 弹窗给「重新匹配」与「延长匹配时间」两操作 |';
    const oldExtend =
      '| 10 | `room.match.extend` | `{}` | 玩家点「延长匹配时间」时发 |';
    expect(isUpdatedPromptRow(oldPrompt)).toBe(false);
    expect(isUpdatedExtendRow(oldExtend)).toBe(false);

    // 选行自证：extend 行的散文里提到 wait_prompt，docRow 仍必须选中 wait_prompt 自己的行。
    const twoRows = [
      '| 10 | `room.match.extend` | `{}` | 收到 `match.wait_prompt` 后点「继续等待」 |',
      '| 11 | `match.wait_prompt` | `{ message: string }` | 底部悬浮卡片…继续等待… |',
    ].join('\n');
    expect(docRow(twoRows, 'match.wait_prompt')).toContain('| 11 |');
  });
});
```

> `docRow` 按表格**第二列**（消息名列）选行：`| 10 | \`room.match.extend\` | … |`
> 的散文里即使提到 `match.wait_prompt`，也不会被选中；两份文档都恰好各有一行。

- [x] **3.2 跑红**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/protocol-doc-sync.test.ts
```

预期：**两个正例红**（文档仍是旧文案）；「判别力自证」用例只测谓词与选行，不依赖
真实文档，保持绿。

- [x] **3.3 改文档**

`docs/client-protocol.md`：
- §4.3 第 10 条：`玩家点「**延长匹配时间**」时发` → `玩家点「**继续等待**」时发`；
- §5 第 11 条：`弹窗原样展示 \`message\`` → `底部悬浮卡片原样展示 \`message\``；
  `「**延长匹配时间**」= 发 \`room.match.extend\`` → `「**继续等待**」= 发 \`room.match.extend\``。

`docs/design.md`：
- `:980`：`**延长匹配提示窗口**` → `**继续等待匹配提示窗口**`；
  `玩家点「延长匹配时间」发出` → `玩家点「继续等待」发出`；
- `:991`：`弹窗给「重新匹配」…与「延长匹配时间」…两操作` →
  `底部悬浮卡片给「重新匹配」…与「继续等待」…两操作`。

- [x] **3.4 跑绿**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/protocol-doc-sync.test.ts
```

预期：全绿。

- [x] **3.5 Commit**

```bash
git add docs/client-protocol.md docs/design.md docs/ops/first-deploy.md apps/client/test/protocol-doc-sync.test.ts docs/superpowers/plans/2026-10-21-match-wait-prompt-floating.md
git commit -m "docs(protocol): 等待提示动作名改「继续等待」+ 悬浮卡片形态

- client-protocol §4.3/§5 与 design.md 两处表格行同步
- 新增 C13 文档文案判据（含旧行负样本，防止第二真源过期）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收口验证（全量）

- [x] 客户端全量测试

```bash
pnpm --filter @fight-the-landlord/client test
```

预期：全绿，无 skipped 增加。

- [x] room-service 全量测试

```bash
pnpm --filter @fight-the-landlord/room-service test
```

预期：全绿。

- [x] 两端类型检查

```bash
pnpm --filter @fight-the-landlord/client run lint
pnpm --filter @fight-the-landlord/room-service run lint
```

- [x] 玩家可见旧文案零残留

```bash
git grep -n "当前在线真人玩家不足" -- apps packages | grep -v '/test/' || true
```

预期：空。测试里的旧文案只作为**负样本**（`match.service.test.ts`、`protocol-doc-sync.test.ts`）。

- [x] `延长匹配时间` 仅剩已登记位置（不做全仓零命中）

```bash
git grep -n "延长匹配时间" -- apps packages docs || true
```

预期：只剩以下**已登记**位置（均为内部注释/历史引用，不影响玩家可见文案或行为）：

- `packages/protocol/src/messages.ts:44` —— 协议注释；改它触发 protocol 重编译纪律，本片不动
- `packages/room-service/src/gateway/ws.gateway.ts:139,578` —— 内部注释
- `packages/room-service/test/client-message-wiring.gate.test.ts:9` —— 测试注释
- `packages/room-service/test/match.service.test.ts:1343`、`apps/client/test/protocol-doc-sync.test.ts`
  —— **负样本**（故意保留旧文案）
- 设计/计划/spec 文档对旧文案的引用

（`game.vue`、`match.service.ts`、`auth-ui-wiring.test.ts`、`stores/game.ts`、
`useGameSession.ts`、`net/session.ts`、`tools/mock-server`、`admin/app.js`、
`docs/design.md`、`docs/client-protocol.md`、`docs/ops/first-deploy.md` 已在任务中改掉。）

- [x] 观感验证（真 Chromium + 真实 `uni-button` 盒模型静态复现截图）

按 spec §7 风险 1 与仓库走查清单第 4 条，按最终 CSS/令牌复现，并显式模拟
`uni-button { box-sizing:border-box; line-height:2.5555 }` 与等待按钮的 `line-height:1.2`：

1. 卡片底部居中、不参与文档流；出现时中央「正在匹配 / 取消匹配」不位移 —— ✅
2. 15 字文案单行、按钮文字不折行 —— ✅
3. 卡片与「取消匹配」、玩家信息条均不重叠 —— ✅（默认配置净空约 8.4px / 12px；
   好友房开启时更大）
4. 匹配中「好友房」入口不可见（配置开启） —— ✅
5. 卡片之外的空白区仍可点到下层（`pointer-events` 生效） —— 源码级 C8 钉住；
   真机走查待部署后补（H5/微信均支持）

截图：`.superpowers/sdd/2026-10-21-match-wait-prompt-floating/preview-final.png`
（好友房开启）/ `preview-final-nofriends.png`（默认配置），gitignored。

- [x] 工作区干净

```bash
git status --porcelain
```

预期：无未提交改动（`.tmp-gen/`、`design-proposal.html` 是会话前既有的未跟踪文件，
不纳入本次提交）。

## 计划审查记录

### 第一轮（独立 reviewer，2026-10-21）

结论：**阻断**（两处局部问题；修订后即可执行）。处置：

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 | F1：`docRow` 按「行内包含消息名」选行，会先命中 `room.match.extend` 行（其散文提到 `match.wait_prompt`）⇒ `match.wait_prompt` 正例永远红 | **已修**：改为按表格第二列（消息名列）精确选行；新增「选行不串行」自证样本 |
| 高 | F2：收口 grep 预期不可达（9 处生产注释 + 测试注释/标题 + 运维文档仍含「延长匹配时间」） | **已修**：拆成「玩家可见旧文案零残留」+「`延长匹配时间` 仅剩已登记内部注释」；2.5-4 改为指向 `game.vue:551`；`docs/ops/first-deploy.md` 纳入 Task 3 |
| 低 | F3：C12 声称覆盖但无判据 | **已修**：C12 降级为「实现纪律，无独立判据」；形状由既有 `toEqual` 钉住 |
| 低 | F4：C14 未写插入位置，可能落到 describe 外 | **已修**：明确插到 waiting-prompt describe 内、`PROMPT_TEXT` 之后 |
| 低 | F5：计划文件未入库，收口「工作区干净」必然失败 | **已修**：新增 Task 0 提交计划；后续任务一并 `git add` 计划文件 |
| 低 | F6：样式替换行号 1256–1302 会误删 `.game__player` 开头 | **已修**：改为 1256–1299（spec 同步） |
| 低 | F10：缺观感验证步骤 | **已修**：收口新增真浏览器/静态截图五点核对 |
| 低 | F7/F8/F9/F11/F12 | F8/F9 已并入修订；F7 登记为「匹配结束（取消/12007）」；F11 不拆任务；F12 并入 F3 |

已验证 OK：作用域/导入、`ruleBody` 精确性、C9 花括号解析、夹具兼容性、SCSS 级联与令牌、
回归面（唯一发送点/源码闸）、任务独立性与 BOM 检查。

## 代码审查记录（实现后，独立 reviewer）

结论：**需修订**（无 Critical；2 项 Important 已修，9 项 Minor 已处置/登记）。

| 编号 | 级别 | 发现 | 处置 |
|---|---|---|---|
| I1 | Important | `uni-button` 基样式 `line-height:2.5555` 使 56px 按钮实高 70.4px，卡片 top 521.6，压住默认配置取消按钮 10px；观感截图未复现该盒模型（假绿） | 按钮加 `line-height:1.2`；`bottom` 72；按真实盒模型重算并重截图；C15 |
| I2 | Important | 死态横条把中央区下移 30.2px，卡片压取消按钮 40.2px；页面级 error 被卡片盖住 | 死态横条改顶部悬浮；`ConnectionDeadBar` 上报 `dead-change`；错误/死态时卡片卸载；C16–C18 |
| M1 | Minor | `role="status"` 在含按钮的整卡上 | 移到 `.game__waitprompt-text` |
| M2 | Minor | `.anim-float-up` 用 `both`，forwards 填充压住未来 transform | 改 `backwards`；C9 钉住 |
| M3 | Minor | C9 未验 `to { transform:none }`/`scale(0)`/`visibility` | 补断言与负样本 |
| M4 | Minor | C14 只测 12007，没测取消 | 新增 C14b |
| M5 | Minor | admin 文案仍写「延长匹配时间」 | 三处改「继续等待」 |
| M6 | Minor | 内部注释/收口清单仍含旧动作名 | 同步注释、mock-server、计划预期 |
| M7 | Minor | design.md「继续等待匹配提示窗口」有歧义 | 改为「『继续等待』动作：平移提示窗口」 |
| M8 | Minor | `d3530130` 提交信息与 diff 不符 | amend 为「spec 的 calc 写法与实现同步」 |
| M9 | Minor | 收口未勾选/观感项假绿 | 已回填并按真实盒模型重截图 |

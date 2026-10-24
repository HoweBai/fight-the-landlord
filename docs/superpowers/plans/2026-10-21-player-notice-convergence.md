# 玩家提示收敛与浮层化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把六页所有事件提示收敛为统一的浮动 `NoticeStack`，服务端错误码只呈现一次，文案按上下文分层，并给静默/生命周期/锚点迁移补上机械闸。

**Architecture:** `LandscapeStage` 提供 overlay 槽；每页用 `usePageNotices()` 持有本地提示，`NoticeStack` 合并本地项、session notice 与内置连接死态项。服务端错误码只走 session notice；REST/本地条件走页面 `notices`。文案由 `net/copy.ts` 的 `playerMessage()` 统一产出，未知码中性化并上报。**NoticeStack 只在各页自己的迁移任务里挂载，并在同一任务删除该页旧的 `SessionNotice`/`ConnectionDeadBar`，避免 `.notice` 双份。**

**Tech Stack:** uni-app + Vue 3 `<script setup>` + Pinia + Vitest + TypeScript。客户端目录 `apps/client`。

## Global Constraints

- 分支 `dev`；每个任务独立提交，提交信息末尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 不改协议代码、错误码、服务端 message 语义；不改 `docs/client-protocol.md` 的 10004 行。
- 不引入原生 `uni.showToast` / `uni.showLoading` / 第三方 toast 库。
- 计时器只允许出现在 `src/composables/**` 与 `src/stores/**`；`src/components/**` 零 `setTimeout` / `setInterval`（R675 / `animations.test.ts`）。
- `NoticeStack` 必须绝对定位、不参与文档流；容器 `pointer-events: none`，项 `auto`。
- `src/net/copy.ts` 只允许 import `@fight-the-landlord/protocol`；`action-copy.ts` 只允许 import protocol + `./copy`。
- 读 `currentSession` 必须经 `currentSession.value?.…` 的响应式路径，禁止在 computed 里直接 `getGameSession()`。
- 保留既有负对照：登录尝试 10005 静默（`auth.error === ''`）；11002 的 message-first；10006/10007 固定客户端文案（服务端 message 可能是英文）；11003 始终封禁 K1；成功码 0 不产生文案。
- 文案 / 锚点迁移必须成对：旧类名在 `src/**` 与 `test/**` 命中数为 0（`.lobby__relief-note` 弹层内例外）。
- **所有已登录页面**的 `dispatchRestFailure.signOutLocally` 必须改为 `stopGameSession(); auth.sessionEnded(playerMessage(report.code, { context: 'auth' }))`；登录/注册尝试保持 `handleAuthFailure` 的静默负对照。
- **REST 房间业务码** 12001/12002/12004/12008 只做本地提示，绝不 `sessionEnded`（房间满/不存在不是会话失效）。
- 页面 catch 里的 `reportError` 从 `'../../observability/reporter'` 相对导入（source-boundary 允许包内相对导入）；只把异常/上下文送 reporter，不拼进玩家文案。
- **提示文本断言一律用 `[data-notice-id="X"] .notice__text`**，不要对 `.notice` 整项 `.text()`（关闭按钮 `×` 会污染精确断言）。
- 每个任务结束运行 `pnpm -C apps/client test` 与 `pnpm -C apps/client run lint`；相关文件绿后再提交。最终全量跑 `pnpm -C apps/client test`、`pnpm -C apps/client run lint`、`node scripts/browser-e2e.mjs`。

---

## Task 1: 文案基座（copy.ts 三表 + playerMessage + reporter）

**Files:**
- Modify: `apps/client/src/net/copy.ts`
- Modify: `apps/client/src/net/action-copy.ts`
- Modify: `apps/client/src/net/errors.ts`
- Modify: `apps/client/src/env.d.ts`
- Test: `apps/client/test/copy-coverage.test.ts`（新增）
- Test: `apps/client/test/player-copy.test.ts`（新增）
- Test: `apps/client/test/auth-error-copy.test.ts`
- Test: `apps/client/test/action-feedback.test.ts`

**Interfaces:**
- Produces: `playerMessage(code: number, opts: { context: 'auth'|'action'|'rest'|'warning'; label?: string; serverMessage?: string }): string`
- Produces: `actionErrorMessage(code: number): string`、`actionCopyFor(code: number): string | null`、`authErrorMessage(code: number, label: string): string`
- Produces: `COPY_SETS: { IGNORED: Set<number>; FIXED: Set<number>; MESSAGE_FIRST: Set<number>; IGNORE_WITH_COPY: Set<number>; RESERVED: Set<number> }`
- Produces: `reportUnknownCode(code: number, context: 'action'|'rest'): void`、`resetUnknownCodeReports(): void`
- Produces: `isPlayerDiag(): boolean`

- [ ] **Step 1: 写失败的分区测试**

创建 `apps/client/test/copy-coverage.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CLIENT_ACTION, ClientAction, ErrCode, RESERVED_CODES } from '@fight-the-landlord/protocol';
import { COPY_SETS } from '../src/net/copy';

const ALL = Object.values(ErrCode).filter((v): v is ErrCode => typeof v === 'number');

describe('G1 文案分区', () => {
  it('IGNORED 由 CLIENT_ACTION 派生', () => {
    const derived = ALL.filter((c) => CLIENT_ACTION[c] === ClientAction.IGNORE);
    expect([...COPY_SETS.IGNORED].sort()).toEqual(derived.sort());
  });

  it('FIXED 与 MESSAGE_FIRST 精确分区全部非 IGNORED 码', () => {
    const classified = new Set([...COPY_SETS.FIXED, ...COPY_SETS.MESSAGE_FIRST]);
    const ignored = COPY_SETS.IGNORED;
    for (const code of ALL) {
      if (ignored.has(code)) {
        expect(classified.has(code), `${code} 不得同时在 IGNORED 与文案分区`).toBe(false);
      } else {
        expect(classified.has(code), `${code} 必须落在 FIXED 或 MESSAGE_FIRST`).toBe(true);
      }
    }
    expect([...COPY_SETS.FIXED].filter((c) => COPY_SETS.MESSAGE_FIRST.has(c))).toEqual([]);
  });

  it('IGNORE_WITH_COPY 是 IGNORED 的子集', () => {
    for (const code of COPY_SETS.IGNORE_WITH_COPY) {
      expect(COPY_SETS.IGNORED.has(code), `${code} 必须属于 IGNORED`).toBe(true);
    }
  });

  it('RESERVED 码有明确归属', () => {
    for (const code of RESERVED_CODES) {
      const ok = COPY_SETS.FIXED.has(code) || COPY_SETS.IGNORED.has(code);
      expect(ok, `reserved ${code} 必须在 FIXED 或 IGNORED`).toBe(true);
    }
  });

  it('关键码归属硬编码（防实现表与测试互为镜像）', () => {
    for (const code of [ErrCode.ROOM_ALREADY_STARTED, ErrCode.VERSION_CONFLICT, ErrCode.RATE_LIMITED, ErrCode.UPSTREAM_UNAVAILABLE]) {
      expect(COPY_SETS.FIXED.has(code), `${code} 必须在 FIXED`).toBe(true);
      expect(COPY_SETS.MESSAGE_FIRST.has(code), `${code} 不得在 MESSAGE_FIRST`).toBe(false);
    }
  });

  it('判别力：漏 12008 / 13004 / 两表重叠必须红', () => {
    const sample = {
      fixed: new Set([ErrCode.ILLEGAL_ACTION]),
      messageFirst: new Set([ErrCode.BAD_PARAM]),
      ignored: new Set<number>(),
    };
    const classified = new Set([...sample.fixed, ...sample.messageFirst]);
    expect(classified.has(ErrCode.ROOM_ALREADY_STARTED)).toBe(false);
    expect(classified.has(ErrCode.VERSION_CONFLICT)).toBe(false);
    expect([...sample.fixed].filter((c) => sample.messageFirst.has(c))).toEqual([]);
    sample.messageFirst.add(ErrCode.ILLEGAL_ACTION);
    expect([...sample.fixed].filter((c) => sample.messageFirst.has(c))).toEqual([ErrCode.ILLEGAL_ACTION]);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- copy-coverage`
Expected: FAIL，`COPY_SETS` 未导出。

- [ ] **Step 3: 重写 `copy.ts`**

用下面内容替换 `apps/client/src/net/copy.ts`（保留文件头注释可简化，但必须只 import protocol）：

```ts
import { CLIENT_ACTION, ClientAction, ErrCode, RESERVED_CODES } from '@fight-the-landlord/protocol';

export type CopyContext = 'auth' | 'action' | 'rest' | 'warning';

export interface PlayerMessageOptions {
  context: CopyContext;
  label?: string;
  serverMessage?: string;
}

const FIXED_COPY: Partial<Record<number, string>> = {
  [ErrCode.UNAUTHENTICATED]: '登录状态已失效，请重新登录',
  [ErrCode.TOKEN_EXPIRED]: '登录状态已失效，请重新登录',
  [ErrCode.TOKEN_INVALID]: '登录状态已失效，请重新登录',
  [ErrCode.RATE_LIMITED]: '操作太频繁，请稍后再试',
  [ErrCode.UPSTREAM_UNAVAILABLE]: '服务暂时不可用，请稍后重试',
  [ErrCode.CLIENT_DISABLED]: '当前客户端已暂停服务，请稍后再试或更换客户端',
  [ErrCode.USER_BANNED]: '该账号已被封禁，如有异议请联系客服',
  [ErrCode.ROOM_NOT_FOUND]: '房间不存在',
  [ErrCode.ROOM_FULL]: '房间已满',
  [ErrCode.NOT_IN_ROOM]: '你不在这个房间里',
  [ErrCode.KICK_FORBIDDEN]: '没有权限进行该操作',
  [ErrCode.FRIEND_ROOM_FAILED]: '好友房创建/加入失败，请稍后重试',
  [ErrCode.MATCH_TIMEOUT]: '当前无匹配的玩家',
  [ErrCode.ROOM_ALREADY_STARTED]: '房间已经开始，无法加入',
  [ErrCode.ALREADY_IN_GAME]: '你还有未结束的对局或房间',
  [ErrCode.ILLEGAL_ACTION]: '服务端判定这手牌不合法，换一手再试',
  [ErrCode.VERSION_CONFLICT]: '牌局状态有更新，正在同步…',
  [ErrCode.GAME_OVER]: '本局已经结束',
  [ErrCode.INVALID_CARDS]: '选中的牌无法组成合法牌型（服务端判定）',
  [ErrCode.ACTION_TIMEOUT]: '这一步超时了，已由服务端处理',
  [ErrCode.GAME_NOT_STARTED]: '本局还没开始',
  [ErrCode.RECONNECT_RECORD_MISSING]: '没有可恢复的对局',
};

const FALLBACK_COPY: Partial<Record<number, string>> = {
  [ErrCode.BAD_PARAM]: '请检查填写的内容',
  [ErrCode.FORBIDDEN]: '没有权限进行该操作',
  [ErrCode.PHONE_TAKEN]: '这个手机号已经注册过了，直接登录吧',
  [ErrCode.BAD_CREDENTIALS]: '手机号或密码不正确',
  [ErrCode.USER_NOT_FOUND]: '该账号不存在，请先注册',
  [ErrCode.DEVICE_MISMATCH]: '账号已绑定其他设备，如需在本机使用请联系管理员解绑',
  [ErrCode.ROOM_MODE_DISABLED]: '该场次暂未开放',
  [ErrCode.E_INSUFFICIENT_FUNDS]: '操作未成功，请稍后重试',
  [ErrCode.E_ACTION_CONFLICT]: '操作未成功，请稍后重试',
  [ErrCode.E_ENTRY_THRESHOLD]: '金币不足，无法进入该场次',
  [ErrCode.E_RELIEF_UNAVAILABLE]: '救助暂不可用，请稍后重试',
  [ErrCode.E_CARD_COUNTER_UNAVAILABLE]: '记牌器暂未开放',
  [ErrCode.E_CARD_COUNTER_PRICE_CHANGED]: '价格已更新，请重新确认后购买',
  [ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT]: '请求号冲突，请重新购买',
  [ErrCode.PAY_CHANNEL_ERROR]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_ORDER_NOT_FOUND]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_WITHDRAW_UNAVAILABLE]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_WITHDRAW_LIMIT]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_REFUND_UNAVAILABLE]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_DISABLED]: '支付暂时不可用，请稍后重试',
  [ErrCode.PAY_STATE_CONFLICT]: '支付暂时不可用，请稍后重试',
};

const IGNORE_WITH_COPY: Partial<Record<number, string>> = {
  [ErrCode.NOT_YOUR_TURN]: '现在还没轮到你',
};

const ALL_CODES = Object.values(ErrCode).filter((v): v is ErrCode => typeof v === 'number');

export const IGNORED_CODES = new Set<number>(
  ALL_CODES.filter((code) => CLIENT_ACTION[code] === ClientAction.IGNORE),
);
export const FIXED_CODES = new Set<number>(Object.keys(FIXED_COPY).map(Number));
export const MESSAGE_FIRST_CODES = new Set<number>(Object.keys(FALLBACK_COPY).map(Number));
export const IGNORE_WITH_COPY_CODES = new Set<number>(Object.keys(IGNORE_WITH_COPY).map(Number));

export const COPY_SETS = {
  IGNORED: IGNORED_CODES,
  FIXED: FIXED_CODES,
  MESSAGE_FIRST: MESSAGE_FIRST_CODES,
  IGNORE_WITH_COPY: IGNORE_WITH_COPY_CODES,
  RESERVED: new Set<number>([...RESERVED_CODES]),
};

export function isPlayerDiag(): boolean {
  return import.meta.env.VITE_PLAYER_DIAG === '1';
}

function neutral(code: number): string {
  const base = '操作未成功，请稍后重试';
  return isPlayerDiag() ? `${base}（code=${code}）` : base;
}

function fallbackFor(code: number, context: CopyContext): string {
  if (code === ErrCode.BAD_PARAM) {
    return context === 'action' ? '请检查操作内容' : '请检查填写的内容';
  }
  return FALLBACK_COPY[code] ?? neutral(code);
}

export function playerMessage(code: number, opts: PlayerMessageOptions): string {
  if (code === ErrCode.OK) return '';
  if (opts.context === 'warning') {
    return opts.serverMessage || '请注意，牌局状态有变化';
  }
  if (MESSAGE_FIRST_CODES.has(code)) {
    return opts.serverMessage || fallbackFor(code, opts.context);
  }
  const fixed = FIXED_COPY[code];
  if (fixed) return fixed;
  if (IGNORED_CODES.has(code)) return '';
  return neutral(code);
}

export function authErrorMessage(code: number, _label: string): string {
  return playerMessage(code, { context: 'auth' });
}

export function actionErrorMessage(code: number): string {
  if (code === ErrCode.OK) return '';
  return playerMessage(code, { context: 'action' });
}

export function actionCopyFor(code: number): string | null {
  return FIXED_COPY[code] ?? IGNORE_WITH_COPY[code] ?? null;
}
```

- [ ] **Step 4: `action-copy.ts` 改为薄再导出**

用下面内容替换 `apps/client/src/net/action-copy.ts`：

```ts
/**
 * 对局动作文案：保留既有导出名，实际由 `copy.ts` 的统一表派生。
 * 只允许 import protocol + `./copy`（不得 import store/页面/规则面）。
 */
export { actionCopyFor, actionErrorMessage } from './copy';
```

- [ ] **Step 5: 写 `player-copy.test.ts`**

创建 `apps/client/test/player-copy.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { actionErrorMessage, authErrorMessage, isPlayerDiag, playerMessage } from '../src/net/copy';

const BANNED = [/code=/, /\[\d+\]/, /refresh_snapshot/, /back_to_lobby/, /§/, /version/, /socket\.io/, /lastVersion/];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('玩家文案：上下文优先级', () => {
  it('auth 保留 message-first（11002）', () => {
    expect(playerMessage(ErrCode.BAD_CREDENTIALS, { context: 'auth', serverMessage: '密码错误' })).toBe('密码错误');
    expect(authErrorMessage(ErrCode.BAD_CREDENTIALS, '登录')).toBe('手机号或密码不正确');
  });

  it('rest 保留 10001 的 message-first', () => {
    expect(playerMessage(ErrCode.BAD_PARAM, { context: 'rest', serverMessage: '参数错误' })).toBe('参数错误');
  });

  it('action 固定文案优先（12008/13004/10006/10007，即使 serverMessage 非空）', () => {
    expect(playerMessage(ErrCode.ROOM_ALREADY_STARTED, { context: 'action', serverMessage: 'room started' })).toBe('房间已经开始，无法加入');
    expect(playerMessage(ErrCode.VERSION_CONFLICT, { context: 'action', serverMessage: 'version conflict' })).toBe('牌局状态有更新，正在同步…');
    expect(playerMessage(ErrCode.RATE_LIMITED, { context: 'rest', serverMessage: 'Too many requests' })).toBe('操作太频繁，请稍后再试');
    expect(playerMessage(ErrCode.UPSTREAM_UNAVAILABLE, { context: 'rest', serverMessage: 'downstream down' })).toBe('服务暂时不可用，请稍后重试');
  });

  it('warning 原样展示服务端 message', () => {
    expect(playerMessage(ErrCode.UPSTREAM_UNAVAILABLE, { context: 'warning', serverMessage: '本局将在 30 秒后由系统代打' })).toBe(
      '本局将在 30 秒后由系统代打',
    );
  });

  it('成功的 0 不产生文案', () => {
    expect(actionErrorMessage(ErrCode.OK)).toBe('');
    expect(playerMessage(ErrCode.OK, { context: 'action' })).toBe('');
  });

  it('未知码中性化；diag 开启才带码', () => {
    expect(actionErrorMessage(424242)).toBe('操作未成功，请稍后重试');
    vi.stubEnv('VITE_PLAYER_DIAG', '1');
    expect(isPlayerDiag()).toBe(true);
    expect(actionErrorMessage(424242)).toBe('操作未成功，请稍后重试（code=424242）');
  });

  it('全部码 × 上下文不出现内部串（serverMessage 为空）', () => {
    for (const code of Object.values(ErrCode).filter((v): v is ErrCode => typeof v === 'number')) {
      for (const context of ['auth', 'action', 'rest', 'warning'] as const) {
        const text = playerMessage(code, { context });
        for (const re of BANNED) expect(text, `${code}/${context}: ${text}`).not.toMatch(re);
      }
    }
  });
});
```

- [ ] **Step 6: `errors.ts` 加未知码上报**

在 `apps/client/src/net/errors.ts` 顶部加：

```ts
import { reportError } from '../observability/reporter';

const reportedUnknownCodes = new Set<number>();

export function reportUnknownCode(code: number, context: 'action' | 'rest'): void {
  if (reportedUnknownCodes.has(code)) return;
  reportedUnknownCodes.add(code);
  reportError('notice.unknown_code', new Error(`unknown error code ${code}`), { code, context });
}

export function resetUnknownCodeReports(): void {
  reportedUnknownCodes.clear();
}
```

在 `dispatchErrorCode` 的 `return (code, message) => {` 内、构造 `report` 之前加：

```ts
if (!known) reportUnknownCode(code, 'action');
```

在 `dispatchRestFailure` 的 `const classified = classifyAck(ack);` 之后加：

```ts
if (!isKnownCode(classified.code)) reportUnknownCode(classified.code, 'rest');
```

- [ ] **Step 7: `env.d.ts` 声明**

在 `apps/client/src/env.d.ts` 的 `ImportMetaEnv` 中加：

```ts
readonly VITE_PLAYER_DIAG?: string;
```

- [ ] **Step 7b: 未知码 reporter 测试**

创建 `apps/client/test/unknown-code-report.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('../src/observability/reporter', () => ({ reportError }));

import { dispatchErrorCode, resetUnknownCodeReports } from '../src/net/errors';

const noop = () => {};
const handlers = { ignore: noop, refreshSnapshot: noop, reconnect: noop, toast: noop, backToLobby: noop };

beforeEach(() => {
  reportError.mockClear();
  resetUnknownCodeReports();
});

describe('未知码上报', () => {
  it('同一未知码每会话只报一次', () => {
    const dispatch = dispatchErrorCode(handlers);
    dispatch(424242);
    dispatch(424242);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBe('notice.unknown_code');
    expect(reportError.mock.calls[0]![2]).toMatchObject({ code: 424242 });
  });
});
```

Run: `pnpm -C apps/client test -- unknown-code-report`
Expected: PASS。

- [ ] **Step 8: 更新既有文案测试**

- `apps/client/test/auth-error-copy.test.ts`：把「未知码兜底必须带码」改为：

```ts
it('未知码兜底中性化（不再带 code）', () => {
  expect(authErrorMessage(99999, '登录')).toBe('操作未成功，请稍后重试');
  expect(authErrorMessage(99999, '注册')).toBe('操作未成功，请稍后重试');
});
```

并把纯度断言改为允许 `copy.ts` 只 import protocol（当前不变）；`action-copy` 的纯度在 `action-feedback` 改。

- `apps/client/test/auth-flow.test.ts:257-266` 的未知码断言 `登录失败（code=99999）` 改为 `操作未成功，请稍后重试`（未知码不再带码）。
- `apps/client/test/action-feedback.test.ts`：
  - 未知码断言改为 `expect(actionErrorMessage(424242)).toBe('操作未成功，请稍后重试')`。
  - 12003：`actionErrorMessage(ErrCode.NOT_YOUR_TURN)` 现在返回 `''`（IGNORED）；新增 `expect(actionCopyFor(ErrCode.NOT_YOUR_TURN)).toBe('现在还没轮到你')`。
  - 13004：断言改为 `'牌局状态有更新，正在同步…'`。
  - 纯度断言改为：

```ts
it('纯查表：action-copy 只再导出 copy.ts，不引入规则面', () => {
  const file = collectSourceFiles().find((f) => f.path === 'src/net/action-copy.ts');
  expect(file).toBeDefined();
  const targets = [...file!.content.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  expect(targets.sort()).toEqual(['./copy']);
  const copy = collectSourceFiles().find((f) => f.path === 'src/net/copy.ts')!;
  const code = stripComments(copy.content);
  expect(code).toMatch(/export function actionErrorMessage\(\s*code:\s*number\s*\)\s*:\s*string/);
  expect(code).not.toMatch(/cards|hand|lastPlayed|isValid|canBeat|牌型\s*=/);
});
```

- [ ] **Step 9: 跑测试**

Run: `pnpm -C apps/client test -- copy-coverage player-copy auth-error-copy action-feedback`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add apps/client/src/net/copy.ts apps/client/src/net/action-copy.ts apps/client/src/net/errors.ts apps/client/src/env.d.ts apps/client/test/copy-coverage.test.ts apps/client/test/player-copy.test.ts apps/client/test/unknown-code-report.test.ts apps/client/test/auth-error-copy.test.ts apps/client/test/auth-flow.test.ts apps/client/test/action-feedback.test.ts
git commit -m "feat(client): 统一玩家文案表与未知码上报

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Session notice 模型（source / sticky / TTL / system.warning）

**Files:**
- Create: `apps/client/src/composables/sessionNotice.ts`
- Modify: `apps/client/src/net/errors.ts`
- Modify: `apps/client/src/net/session.ts`
- Modify: `apps/client/src/net/socket.ts`
- Modify: `apps/client/src/composables/useGameSession.ts`
- Modify: `apps/client/src/stores/game.ts`
- Test: `apps/client/test/session-notice-lifecycle.test.ts`（新增）
- Test: `apps/client/test/reconnect-flow.test.ts`
- Test: `apps/client/test/match-state.test.ts`
- Test: `apps/client/test/connection-rejected.test.ts`
- Test: `apps/client/test/error-disposition.test.ts`

**Interfaces:**
- Produces: `SessionNotice { level; text; code?; source?: 'action'|'transport'|'system'; sticky?: boolean }`
- Produces: `createSessionNoticeController(): { notice: Ref<SessionNotice|null>; set; clearAction; dispose }`
- Produces: `GameSessionHandle.notice`、`GameSessionHandle.clearNotice()`、`GameSessionHandle.disposeNotice()`
- Produces: `GameClient.reportErrorCode(code, message?, source?: 'action'|'system')`

- [ ] **Step 1: 写 session notice controller 失败测试**

创建 `apps/client/test/session-notice-lifecycle.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionNoticeController } from '../src/composables/sessionNotice';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('session notice 生命周期', () => {
  it('info 3s / warn 6s / error 8s 自动消失', () => {
    const ctl = createSessionNoticeController();
    ctl.set({ level: 'error', text: 'x', source: 'action' });
    vi.advanceTimersByTime(7999);
    expect(ctl.notice.value?.text).toBe('x');
    vi.advanceTimersByTime(1);
    expect(ctl.notice.value).toBeNull();
  });

  it('sticky 不自动消失', () => {
    const ctl = createSessionNoticeController();
    ctl.set({ level: 'error', text: '断链', source: 'transport', sticky: true });
    vi.advanceTimersByTime(60_000);
    expect(ctl.notice.value?.text).toBe('断链');
  });

  it('新值使旧 timer 失效（旧 timer 到期不杀 sticky 新值）', () => {
    const ctl = createSessionNoticeController();
    ctl.set({ level: 'error', text: 'old', source: 'action' }); // 8s timer
    vi.advanceTimersByTime(4000);
    ctl.set({ level: 'info', text: 'new', source: 'transport', sticky: true });
    vi.advanceTimersByTime(4000); // 旧 timer 原本在 t=8s 到期
    expect(ctl.notice.value?.text).toBe('new');
  });

  it('clearAction 只清 action；dispose 清一切', () => {
    const ctl = createSessionNoticeController();
    ctl.set({ level: 'warn', text: 'action', source: 'action' });
    ctl.clearAction();
    expect(ctl.notice.value).toBeNull();
    ctl.set({ level: 'warn', text: 'transport', source: 'transport' });
    ctl.clearAction();
    expect(ctl.notice.value?.text).toBe('transport');
    ctl.dispose();
    expect(ctl.notice.value).toBeNull();
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- session-notice-lifecycle`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `sessionNotice.ts`**

创建 `apps/client/src/composables/sessionNotice.ts`：

```ts
import { ref, type Ref } from 'vue';
import type { SessionNotice } from '../net/session';

export interface SessionNoticeController {
  notice: Ref<SessionNotice | null>;
  set(next: SessionNotice | null): void;
  clearAction(): void;
  dispose(): void;
}

export function createSessionNoticeController(): SessionNoticeController {
  const notice = ref<SessionNotice | null>(null) as Ref<SessionNotice | null>;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function set(next: SessionNotice | null): void {
    generation += 1;
    cancelTimer();
    notice.value = next;
    if (next === null || next.sticky === true) return;
    const ttl = next.level === 'info' ? 3000 : next.level === 'warn' ? 6000 : 8000;
    const current = generation;
    timer = setTimeout(() => {
      if (current !== generation) return;
      notice.value = null;
      timer = null;
    }, ttl);
  }

  function clearAction(): void {
    if (notice.value?.source === 'action') set(null);
  }

  function dispose(): void {
    generation += 1;
    cancelTimer();
    notice.value = null;
  }

  return { notice, set, clearAction, dispose };
}
```

在 `apps/client/src/net/session.ts` 把 `SessionNotice` 接口改为：

```ts
export interface SessionNotice {
  level: 'info' | 'warn' | 'error';
  text: string;
  code?: number;
  source?: 'action' | 'transport' | 'system';
  sticky?: boolean;
}
```

在 `apps/client/src/composables/useGameSession.ts` 的 `createSessionOptions` 内，把 `const notice = ref<SessionNotice | null>(null);` 改为：

```ts
const noticeCtl = createSessionNoticeController();
const notice = noticeCtl.notice;
const setSessionNotice = noticeCtl.set;
const clearActionNotice = noticeCtl.clearAction;
const disposeNotice = noticeCtl.dispose;
```

顶部加 `import { createSessionNoticeController } from './sessionNotice';`（同目录）。

把 `createSessionOptions` 的返回值改为：

```ts
return { options, notice, setSessionNotice, clearActionNotice, disposeNotice };
```

并在同文件的 `GameSessionOptions` 接口加：

```ts
setSessionNotice: (n: SessionNotice | null) => void;
clearActionNotice: () => void;
disposeNotice: () => void;
```

把 `useGameSession.ts` 里所有 `notice.value = { ... }` 写入替换为 `setSessionNotice({ ... })`，并补 `source`：

```ts
// joinMatchedRoom
setSessionNotice({ level: 'warn', text: '进房失败，请重试', source: 'action' });

// applySnapshot rollback
setSessionNotice({ level: 'warn', text: '牌局状态有更新，正在同步…', source: 'transport' });

// onRefreshSnapshot success
setSessionNotice({ level: 'info', text: '已同步到最新状态，请重新操作。', source: 'action' });
// onRefreshSnapshot failure
setSessionNotice({ level: 'error', text: '同步失败，请重试', source: 'action' });

// onActionDisposition
setSessionNotice({ level: 'warn', text: reason.message, code: reason.code, source: 'action' });

// onReconnect (server_rejected)
setSessionNotice({ level: 'error', text: reason.message, source: 'transport' });
// onReconnect (其余)
setSessionNotice({ level: 'warn', text: reason.message, source: 'transport' });

// onNotice
setSessionNotice(n);
```

- [ ] **Step 4: 失败快照/回退文案中性化**

在 `apps/client/src/net/session.ts` 的 `refreshSnapshot` 分支（`createGameSession` 里只能调 `options.onNotice`）：

```ts
refreshSnapshot: (report) => {
  options.onNotice?.({ level: 'warn', text: '牌局状态有更新，正在同步…', source: 'action' });
  void Promise.resolve(options.onRefreshSnapshot()).catch(() => {
    options.onNotice?.({ level: 'error', text: '同步失败，请重试', source: 'action' });
  });
},
```

在 `toast` 分支：

```ts
toast: (report) => {
  options.onNotice?.({
    level: 'error',
    text: playerMessage(report.code, { context: 'action', serverMessage: report.message }),
    code: report.code,
    source: report.source ?? 'action',
  });
},
```

在 `backToLobby` 分支：

```ts
const text = playerMessage(report.code, { context: 'action', serverMessage: report.message });
options.onNotice?.({ level: 'warn', text, code: report.code, source: 'action' });
dispose({ kind: 'back_to_lobby', version: options.currentVersion(), message: text, code: report.code });
```

在 `createGameSession` 的 `client.onReconnect` 中，`server_rejected` 分支改为：

```ts
if (reason.kind === 'server_rejected') notice('error', reason.message, { source: 'transport' });
```

`reconnect` 处置分支不再把 `describeAction(report)` 当 UI 文案：

```ts
reconnect: () => {
  dispose({
    kind: 'action_reconnect',
    version: options.currentVersion(),
    message: '正在重新连接…',
  });
},
```

引入 `playerMessage`（`import { playerMessage } from './copy';`），移除 UI 路径的 `describeAction` 使用。改动完成后删除 `net/session.ts` 不再使用的 `actionCopyFor` / `authErrorMessage` import；`socket.ts` 的 `notifyAction` 使用 `isKnownCode` 时补 import。若 `describeAction` 已无任何日志/reporter 调用，连同定义一起删除。

- [ ] **Step 5: `system.warning` 独立订阅**

在 `createGameSession` 中、`system.error` 订阅旁加：

```ts
client.on('system.warning', (msg) => {
  const payload = (msg as Extract<ServerMessage, { type: 'system.warning' }>).payload;
  options.onNotice?.({
    level: 'warn',
    text: payload.message || '请注意，牌局状态有变化',
    code: payload.code,
    source: 'system',
  });
});
```

在 `for (const type of [...])` 列表里删除 `'system.warning'`，保留 `'system.error'`。

把 `system.error` 推送改为：

```ts
client.reportErrorCode(payload.code, payload.message, 'system');
```

- [ ] **Step 6: `socket.ts` 的 source 参数与中性文案**

在 `apps/client/src/net/socket.ts` 修改：

```ts
reportErrorCode(code: number, message?: string, source: 'action' | 'system' = 'action'): ClientActionReport[] {
  return this.notifyAction(code, message, source);
}
```

`notifyAction` / `dispatchAck` 透传 `source`；ack 路径传 `'action'`。

把 `handleSocketDisconnect` 的 `emitReconnect` 文案换掉：

```ts
message: connectionKickMessage(code),
```

并在 `applySnapshotAck` 的 rollback 文案改为：

```ts
message: '牌局状态有更新，正在同步…',
```

在 `apps/client/src/stores/game.ts` 的 `applySnapshot` 回退信号改为：

```ts
message: '牌局状态有更新，正在同步…',
```

在 `socket.ts` 的 `notifyAction` 开头加未知码上报（`reportUnknownCode` 来自 `./errors`）：

```ts
private notifyAction(code: number, message?: string, source: 'action' | 'system' = 'action'): ClientActionReport[] {
  if (!isKnownCode(code)) reportUnknownCode(code, 'action');
  const reports: ClientActionReport[] = [];
  for (const executor of this.actionHandlers) reports.push(executor(code, message, source));
  return reports;
}
```

（`ClientActionExecutor` 与 `dispatchErrorCode` 的执行器签名增加可选 `source`；`ClientActionReport` 增加 `source?: 'action'|'system'`，session 的 `toast` 处理器写 `source: report.source ?? 'action'`。`dispatchRestFailure` 仍走 `'rest'` 上报。）

`net/errors.ts` 的精确改动：

```ts
export interface ClientActionReport {
  code: number;
  action: ClientAction;
  known: boolean;
  message?: string;
  requestType?: string;
  source?: 'action' | 'system';
}

export type ClientActionExecutor = (
  code: number,
  message?: string,
  source?: 'action' | 'system',
) => ClientActionReport;

export function dispatchErrorCode(handlers: ClientActionHandlers): ClientActionExecutor {
  return (code, message, source = 'action') => {
    const known = isKnownCode(code);
    const action = known ? CLIENT_ACTION[code as ErrCode] : ClientAction.TOAST;
    if (!known) reportUnknownCode(code, 'action');
    const report: ClientActionReport = { code, action, known, message, source };
    // 既有 switch（ignore / refreshSnapshot / reconnect / backToLobby / toast）保持不变
    return report;
  };
}
```

`createActionExecutor` 直接返回 `dispatchErrorCode(...)`，第三参自动透传。`session.ts` 的 `toast` 用 `source: report.source ?? 'action'`。

`RestFailureHandlers.signOutLocally` 与唯一调用点：

```ts
export interface RestFailureHandlers {
  toast: (report: ClientActionReport) => void;
  signOutLocally: (report: ClientActionReport) => void;
  replay: () => Promise<unknown>;
}
// dispatchRestFailure 内：
case ClientAction.BACK_TO_LOBBY:
  handlers.signOutLocally(report);
  break;
```

在 `net/socket.ts` 顶部从 `./connection-copy` 导入 `connectionKickMessage`（Task 4 创建该文件前，先在 Task 2 临时定义在本文件；Task 4 再迁走）：

```ts
function connectionKickMessage(code: number | null): string {
  if (code === ErrCode.USER_BANNED) return authErrorMessage(ErrCode.USER_BANNED, '操作');
  if (code === ErrCode.CLIENT_DISABLED) return authErrorMessage(ErrCode.CLIENT_DISABLED, '连接');
  if (code === ErrCode.RATE_LIMITED) {
    return '同一网络的连接数已达上限。请关闭其它窗口或设备后点「重新连接」再试。';
  }
  return code === null ? '服务端主动断开了连接。' : '连接已被服务端断开，请重新连接。';
}
```

- [ ] **Step 7: `useGameSession` 接入 controller**

把 `createSessionOptions` 的返回值解构改为：

```ts
const { options, notice, clearActionNotice, disposeNotice } = createSessionOptions(socketFactory, sessionRef);
```

`clearNotice` 改为调用 `clearActionNotice`；`GameSessionHandle` 加 `disposeNotice`：

```ts
disposeNotice: () => disposeNotice(),
```

`stopGameSession` 在 `handle?.disconnect()` 前调用 `handle?.disposeNotice()`。

在 `apps/client/src/net/session.ts` 的 `createGameSession` 中，`onConnectUnavailable` / `onConnectAvailable` 回调改为（这里只能用 `options.onNotice`，`setSessionNotice` 是 `useGameSession.ts` 里 `createSessionOptions` 的局部函数）：

```ts
onConnectUnavailable: () =>
  options.onNotice?.({
    level: 'error',
    text: CONNECT_UNAVAILABLE_TEXT,
    source: 'transport',
    sticky: true,
  }),
onConnectAvailable: () =>
  options.onNotice?.({
    level: 'info',
    text: CONNECT_RECOVERED_TEXT,
    source: 'transport',
  }),
```

- [ ] **Step 8: 删除 `store.notices` 与 warning 消费**

在 `apps/client/src/stores/game.ts`：
- 删除 `notices: [] as GameNotice[]` 字段、`GameNotice` 类型（全仓仅此处使用，grep 确认）、`this.notices.push(...)`、`reset()` 里的 `this.notices = []`。
- 保留 `system.error` 的 12007 `setMatching(false)`。

在 `match-state.test.ts` 删除/迁移 `store.notices` 断言。

- [ ] **Step 9: 更新既有负对照**

- `apps/client/test/reconnect-flow.test.ts` 的 10002 诊断串用例改为：

```ts
it('未登记文案的码（10002）显示中性文案，不再输出诊断串', async () => {
  const { socket, session } = productionSession();
  void session.client.send('room.match', { mode: 'random', baseScore: 15 });
  socket.lastRequest()!.ack(null, { code: ErrCode.UNAUTHENTICATED, message: 'missing auth.token' });
  await vi.waitFor(() => expect(session.notice.value?.text ?? '').not.toBe(''));
  expect(session.notice.value?.text).toBe('登录状态已失效，请重新登录');
  expect(session.notice.value?.text).not.toContain('[10002]');
});
```

- `reconnect-flow.test.ts:699-701` 的快照回退文案从 `检测到状态回退，正在重新同步快照…` 改为 `牌局状态有更新，正在同步…`。
- `connection-rejected.test.ts` 的 10006 断言改为新文案：`toContain('10006')` 不再成立，改为 `toContain('同一网络的连接数已达上限')`；逐字用例改为 `同一网络的连接数已达上限。请关闭其它窗口或设备后点「重新连接」再试。`。11003/10008 仍用 K1/§0。
- `room-matched-join.test.ts` 新增用例（现有文件没有这条断言）：模拟 `room.matched` 后 `room.join` 发送失败 ⇒ 会话 notice 为 `进房失败，请重试` 且 `source:'action'`；`clearNotice()` 后消失。
- `error-disposition.test.ts` 的 `signOutLocally` 签名改为 `(report) => void`；空参 mock 仍可赋值（参数少是允许的），但为了读取 report 的用例补上形参。

- [ ] **Step 9b: session 集成生命周期用例**

先把 `reconnect-flow.test.ts` 里的 `productionSession()` 抽到 `apps/client/test/helpers/production-session.ts` 并导出（两个测试文件复用），再在 `session-notice-lifecycle.test.ts` 追加：

```ts
import { ErrCode } from '@fight-the-landlord/protocol';
import { productionSession } from './helpers/production-session';
import { currentSession, stopGameSession } from '../src/composables/useGameSession';

it('transport 不可用 sticky 到恢复；恢复后 3s 消失', async () => {
  const { socket, session } = productionSession();
  socket.emitConnectError(new Error('offline'));
  vi.advanceTimersByTime(60_000);
  expect(session.notice.value?.text).toBe('连接不可用，请检查网络后重试');
  socket.emitConnect();
  expect(session.notice.value?.text).toBe('连接已恢复');
  vi.advanceTimersByTime(3000);
  expect(session.notice.value).toBeNull();
});

it('clearNotice 取消 action timer，旧 timer 不杀新 notice', async () => {
  const { session } = productionSession();
  session.client.reportErrorCode(ErrCode.ROOM_FULL, '');
  session.clearNotice();
  session.notice.value = { level: 'info', text: 'new', source: 'transport' };
  vi.advanceTimersByTime(8000);
  expect(session.notice.value?.text).toBe('new');
});

it('stopGameSession 清理 timer', async () => {
  const { session } = productionSession();
  session.client.reportErrorCode(ErrCode.ROOM_FULL, '');
  stopGameSession();
  vi.advanceTimersByTime(8000);
  expect(currentSession.value).toBeNull();
});

it('push 路径 notice.source = system', () => {
  const { session } = productionSession();
  session.client.reportErrorCode(ErrCode.ROOM_FULL, '', 'system');
  expect(session.notice.value?.source).toBe('system');
});

it('system.error 12007 push：一条「当前无匹配的玩家」且 source=system', () => {
  const { socket, session } = productionSession();
  socket.push({ type: 'system.error', version: 0, payload: { code: ErrCode.MATCH_TIMEOUT, message: 'Match timed out' } });
  expect(session.notice.value?.text).toBe('当前无匹配的玩家');
  expect(session.notice.value?.source).toBe('system');
});
```

- [ ] **Step 10: 跑测试**

Run: `pnpm -C apps/client test -- session-notice-lifecycle reconnect-flow match-state connection-rejected error-disposition`
Expected: PASS。

- [ ] **Step 11: 提交**

```bash
git add apps/client/src/composables/sessionNotice.ts apps/client/src/net/errors.ts apps/client/src/net/session.ts apps/client/src/net/socket.ts apps/client/src/composables/useGameSession.ts apps/client/src/stores/game.ts apps/client/test/helpers/production-session.ts apps/client/test/session-notice-lifecycle.test.ts apps/client/test/reconnect-flow.test.ts apps/client/test/match-state.test.ts apps/client/test/connection-rejected.test.ts apps/client/test/error-disposition.test.ts
git commit -m "feat(client): session 提示源/粘性/TTL 与 system.warning 接线

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Notice 基座（usePageNotices + NoticeStack + overlay 槽）

**Files:**
- Create: `apps/client/src/composables/usePageNotices.ts`
- Create: `apps/client/src/components/NoticeStack.vue`
- Modify: `apps/client/src/components/LandscapeStage.vue`
- Test: `apps/client/test/page-notices.test.ts`（新增）
- Test: `apps/client/test/notice-stack.test.ts`（新增）
- Test: `apps/client/test/ui-tokens.test.ts`
- Test: `apps/client/test/table-bid-ui.test.ts`
- Test: `apps/client/test/animations.test.ts`

**Interfaces:**
- Produces: `usePageNotices(): { items: Ref<NoticeItem[]>; show; dismiss; clear; setNotice }`
- Produces: `NoticeStack` props `{ items: NoticeItem[]; surface: NoticeSurface }`，emits `dismiss(id)`
- Produces: `LandscapeStage` 的 `#overlay` 槽 + `.stage__overlay`

- [ ] **Step 1: 写 `usePageNotices` 失败测试**

创建 `apps/client/test/page-notices.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { usePageNotices } from '../src/composables/usePageNotices';

function harness() {
  let api!: ReturnType<typeof usePageNotices>;
  const Comp = defineComponent({
    setup() {
      api = usePageNotices();
      return () => h('div');
    },
  });
  const wrapper = mount(Comp);
  return { api, wrapper };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePageNotices', () => {
  it('按级别 3/6/8s 自动消失', () => {
    const { api } = harness();
    api.show({ id: 'a', level: 'info', text: 'a' });
    api.show({ id: 'b', level: 'warn', text: 'b' });
    api.show({ id: 'c', level: 'error', text: 'c' });
    vi.advanceTimersByTime(3000);
    expect(api.items.value.map((i) => i.id)).toEqual(['c', 'b']);
    vi.advanceTimersByTime(3000);
    expect(api.items.value.map((i) => i.id)).toEqual(['c']);
    vi.advanceTimersByTime(2000);
    expect(api.items.value).toEqual([]);
  });

  it('同 id 替换、同文案去重、sticky 不消失', () => {
    const { api } = harness();
    api.show({ id: 'a', level: 'warn', text: 'x' });
    api.show({ id: 'a', level: 'error', text: 'y' });
    expect(api.items.value).toHaveLength(1);
    expect(api.items.value[0]!.text).toBe('y');
    api.show({ id: 'b', level: 'error', text: 'y' });
    expect(api.items.value).toHaveLength(1);
    api.show({ id: 's', level: 'error', text: 'sticky', durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(api.items.value.some((i) => i.id === 's')).toBe(true);
  });

  it('critical 不淘汰，普通项上限 5', () => {
    const { api } = harness();
    api.show({ id: 'crit', level: 'error', text: 'crit', durationMs: 0, priority: 'critical' });
    for (let i = 0; i < 7; i += 1) api.show({ id: `n${i}`, level: 'warn', text: `n${i}` });
    expect(api.items.value.filter((i) => i.priority !== 'critical')).toHaveLength(5);
    expect(api.items.value.some((i) => i.id === 'crit')).toBe(true);
  });

  it('卸载后 show no-op 并清计时器', () => {
    const { api, wrapper } = harness();
    api.show({ id: 'a', level: 'warn', text: 'a' });
    wrapper.unmount();
    api.show({ id: 'b', level: 'warn', text: 'b' });
    expect(api.items.value).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- page-notices`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `usePageNotices.ts`**

创建 `apps/client/src/composables/usePageNotices.ts`：

```ts
import { onUnmounted, ref, type Ref } from 'vue';

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';
export type NoticeSurface = 'login' | 'lobby' | 'game' | 'table' | 'wallet' | 'history';

export interface NoticeAction {
  label: string;
  kind?: 'primary' | 'secondary';
  disabled?: boolean | (() => boolean);
  onClick: () => void;
}

export interface NoticeItem {
  id: string;
  level: NoticeLevel;
  text: string;
  durationMs?: number;
  actions?: NoticeAction[];
  priority?: 'critical' | 'normal';
  dismissible?: boolean;
}

export interface PageNotices {
  items: Ref<NoticeItem[]>;
  show(item: NoticeItem): void;
  dismiss(id: string): void;
  clear(): void;
  setNotice(id: string, text: string, options?: Omit<NoticeItem, 'id' | 'text'>): void;
}

const DEFAULT_DURATION: Record<NoticeLevel, number> = {
  info: 3000,
  success: 3000,
  warn: 6000,
  error: 8000,
};
const MAX_NORMAL = 5;

export function usePageNotices(): PageNotices {
  const items = ref<NoticeItem[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function remove(id: string): void {
    items.value = items.value.filter((item) => item.id !== id);
  }

  function schedule(item: NoticeItem): void {
    const duration = item.durationMs ?? DEFAULT_DURATION[item.level];
    if (duration <= 0) return;
    const timer = setTimeout(() => {
      timers.delete(item.id);
      remove(item.id);
    }, duration);
    timers.set(item.id, timer);
  }

  function show(item: NoticeItem): void {
    if (disposed) return;
    const existing = items.value.find((entry) => entry.id === item.id);
    if (existing !== undefined) {
      clearTimer(item.id);
      items.value = items.value.map((entry) => (entry.id === item.id ? item : entry));
      schedule(item);
      return;
    }
    const duplicate = items.value.find(
      (entry) =>
        entry.level === item.level &&
        entry.text === item.text &&
        (entry.actions?.length ?? 0) === 0 &&
        (item.actions?.length ?? 0) === 0,
    );
    if (duplicate !== undefined) {
      clearTimer(duplicate.id);
      schedule(duplicate);
      return;
    }
    let next = [item, ...items.value];
    const normal = next.filter((entry) => entry.priority !== 'critical');
    if (normal.length > MAX_NORMAL) {
      const oldest = normal[normal.length - 1]!;
      clearTimer(oldest.id);
      next = next.filter((entry) => entry.id !== oldest.id);
    }
    items.value = next;
    schedule(item);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    remove(id);
  }

  function clear(): void {
    for (const id of [...timers.keys()]) clearTimer(id);
    items.value = [];
  }

  function setNotice(
    id: string,
    text: string,
    options: Omit<NoticeItem, 'id' | 'text'> = {},
  ): void {
    if (text === '') {
      dismiss(id);
      return;
    }
    show({ id, text, ...options });
  }

  onUnmounted(() => {
    disposed = true;
    clear();
  });

  return { items, show, dismiss, clear, setNotice };
}
```

- [ ] **Step 4: 实现 `NoticeStack.vue`（本任务先只渲染本地项）**

创建 `apps/client/src/components/NoticeStack.vue`。本任务先落地**本地项部分**；Task 4 再扩展 session notice 与死态项：

```vue
<script setup lang="ts">
import type { NoticeAction, NoticeItem, NoticeSurface } from '../composables/usePageNotices';

const props = defineProps<{ items: NoticeItem[]; surface: NoticeSurface }>();
const emit = defineEmits<{ (e: 'dismiss', id: string): void }>();

function isDisabled(action: NoticeAction): boolean {
  return typeof action.disabled === 'function' ? action.disabled() : action.disabled === true;
}
function roleOf(item: NoticeItem): 'alert' | 'status' {
  return item.level === 'error' || item.level === 'warn' ? 'alert' : 'status';
}
function liveOf(item: NoticeItem): 'assertive' | 'polite' {
  return item.level === 'error' || item.level === 'warn' ? 'assertive' : 'polite';
}
function dismissible(item: NoticeItem): boolean {
  return item.dismissible ?? ((item.actions?.length ?? 0) === 0);
}
</script>

<template>
  <view class="notice-stack" :data-surface="props.surface">
    <view
      v-for="item in props.items"
      :key="item.id"
      class="notice anim-toast-in"
      :class="`notice--${item.level}`"
      :data-notice-id="item.id"
      :role="roleOf(item)"
      :aria-live="liveOf(item)"
    >
      <text class="notice__text">{{ item.text }}</text>
      <view v-if="item.actions?.length" class="notice__actions">
        <button
          v-for="action in item.actions"
          :key="action.label"
          type="button"
          class="notice__action"
          :class="`notice__action--${action.kind ?? 'secondary'}`"
          :disabled="isDisabled(action)"
          @click="action.onClick()"
        >
          {{ action.label }}
        </button>
      </view>
      <button
        v-if="dismissible(item)"
        type="button"
        class="notice__close"
        aria-label="关闭提示"
        @click="emit('dismiss', item.id)"
      >
        ×
      </button>
    </view>
  </view>
</template>

<style scoped lang="scss">
@import "../styles/animations.scss";

.notice-stack {
  position: absolute;
  top: 12px;
  left: 50%;
  z-index: 15;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-3;
  width: min(720px, calc(100% - #{$ftl-space-8}));
  transform: translateX(-50%);
  pointer-events: none;
}
.notice {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-3;
  box-sizing: border-box;
  padding: $ftl-space-3 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: rgb(0 0 0 / 62%);
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  line-height: 1.4;
  pointer-events: auto;
}
.notice__text {
  min-width: 0;
  text-align: center;
  overflow-wrap: anywhere;
}
.notice--info {
  border-color: rgba($ftl-color-on-primary, 0.35);
}
.notice--success {
  border-color: $ftl-color-gold;
  color: $ftl-color-gold-light;
}
.notice--warn {
  border-color: $ftl-color-gold;
  color: $ftl-color-gold-light;
}
.notice--error {
  border-color: $ftl-color-danger;
  color: $ftl-color-danger-on-dark;
}
.notice__actions {
  display: flex;
  gap: $ftl-space-3;
}
.notice__action {
  margin: 0;
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-5;
  border: $ftl-hairline solid rgba($ftl-color-on-primary, 0.45);
  border-radius: $ftl-radius-sm;
  background: transparent;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
}
.notice__action--primary {
  border-color: $ftl-color-gold;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
}
.notice__action[disabled] {
  opacity: 0.5;
}
.notice__close {
  margin: 0;
  min-width: $ftl-control-h-sm;
  min-height: $ftl-control-h-sm;
  padding: 0;
  border: 0;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-md;
  line-height: 1;
}
</style>
```

- [ ] **Step 5: `LandscapeStage` 加 overlay 槽**

在 `apps/client/src/components/LandscapeStage.vue` 模板的 `<slot />` 之后加：

```vue
<view class="stage__overlay">
  <slot name="overlay" />
</view>
```

在样式 `.canvas` 附近加：

```scss
.stage__overlay {
  position: absolute;
  inset: 0;
  z-index: 15;
  pointer-events: none;
}
```

- [ ] **Step 6: 写 `notice-stack.test.ts`**

创建 `apps/client/test/notice-stack.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import LandscapeStage from '../src/components/LandscapeStage.vue';
import NoticeStack from '../src/components/NoticeStack.vue';

describe('NoticeStack 浮层', () => {
  it('渲染级别、动作、关闭与 data 锚点', async () => {
    const wrapper = mount(NoticeStack, {
      props: {
        surface: 'game',
        items: [
          { id: 'a', level: 'error', text: '出错了', actions: [{ label: '重试', onClick: () => {} }] },
          { id: 'b', level: 'info', text: '好' },
        ],
      },
    });
    expect(wrapper.find('.notice-stack').exists()).toBe(true);
    expect(wrapper.find('[data-notice-id="a"]').classes()).toContain('notice--error');
    expect(wrapper.text()).toContain('重试');
    expect(wrapper.find('[data-notice-id="b"] .notice__close').exists()).toBe(true);
    await wrapper.find('[data-notice-id="b"] .notice__close').trigger('click');
    expect(wrapper.emitted('dismiss')?.[0]).toEqual(['b']);
  });

  it('LandscapeStage 的 overlay 槽在 .stage__overlay 内', () => {
    const wrapper = mount(LandscapeStage, {
      slots: { default: '<view class="page-body" />', overlay: '<view class="notice-stack" />' },
    });
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  });
});
```

- [ ] **Step 7: 更新组件清单**

- `apps/client/test/ui-tokens.test.ts`：在 required 列表保留 `SessionNotice.vue`（本任务不退役），加上 `src/components/NoticeStack.vue`；确保 NoticeStack 有 `<style lang="scss">`。
- `apps/client/test/table-bid-ui.test.ts`：`TABLE_AREA` 数组从 10 件改为 11，加入 `src/components/NoticeStack.vue`；同时把文件中两处写死的 `toHaveLength(10)`（约 `:375`、`:401`）改为 `toHaveLength(11)`，注释同步。
- `apps/client/test/animations.test.ts` 无需改（NoticeStack 零 timer），跑一遍确认。

- [ ] **Step 8: 跑测试**

Run: `pnpm -C apps/client test -- page-notices notice-stack ui-tokens table-bid-ui animations`
Expected: PASS。
再跑一次真实构建（验证 SCSS `@import` 路径与 uni 编译）：
Run: `pnpm -C apps/client run build:h5`
Expected: 构建成功。

- [ ] **Step 9: 提交**

```bash
git add apps/client/src/composables/usePageNotices.ts apps/client/src/components/NoticeStack.vue apps/client/src/components/LandscapeStage.vue apps/client/test/page-notices.test.ts apps/client/test/notice-stack.test.ts apps/client/test/ui-tokens.test.ts apps/client/test/table-bid-ui.test.ts
git commit -m "feat(client): NoticeStack 浮层基座与页面提示生命周期

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 连接所有权（connection-copy + Stack 死态项 + Overlay/DeadBar 共用）

**Files:**
- Create: `apps/client/src/net/connection-copy.ts`
- Modify: `apps/client/src/components/NoticeStack.vue`
- Modify: `apps/client/src/components/ConnectionOverlay.vue`
- Modify: `apps/client/src/components/ConnectionDeadBar.vue`
- Modify: `apps/client/src/net/socket.ts`（把 Task 2 的临时 `connectionKickMessage` 迁走）
- Test: `apps/client/test/connection-copy.test.ts`（新增）
- Test: `apps/client/test/notice-connection-matrix.test.ts`（新增）
- Test: `apps/client/test/connection-overlay.test.ts`
- Test: `apps/client/test/connection-dead.test.ts`

**Interfaces:**
- Produces: `connectionDeadCopy(state: ConnectionState): { title; message; canRetry; canRelogin }`
- Produces: `connectionKickMessage(code: number | null): string`
- `NoticeStack` 新增内置死态项、transport 抑制与 session notice 合并

- [ ] **Step 1: 写 `connection-copy` 失败测试**

创建 `apps/client/test/connection-copy.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { connectionDeadCopy, connectionKickMessage } from '../src/net/connection-copy';

const base = { phase: 'dead' as const, attempt: 0 };

describe('连接文案单一真源', () => {
  it('give_up 可重试', () => {
    const copy = connectionDeadCopy({ ...base, deadReason: 'give_up', deadCode: null });
    expect(copy.message).toContain('多次自动重连仍未成功');
    expect(copy.canRetry).toBe(true);
    expect(copy.canRelogin).toBe(false);
  });

  it('10006 使用同一网络口径，且与登录 10006 文案不同', () => {
    const copy = connectionDeadCopy({ ...base, deadReason: 'server_rejected', deadCode: ErrCode.RATE_LIMITED });
    expect(copy.message).toBe('同一网络的连接数已达上限。请关闭其它窗口或设备后点「重新连接」再试。');
    expect(connectionKickMessage(ErrCode.RATE_LIMITED)).toBe(copy.message);
  });

  it('11003 不可重试；session_expired 只能重登', () => {
    const banned = connectionDeadCopy({ ...base, deadReason: 'server_rejected', deadCode: ErrCode.USER_BANNED });
    expect(banned.canRetry).toBe(false);
    expect(banned.message).toContain('如有异议请联系客服');
    const expired = connectionDeadCopy({ ...base, deadReason: 'session_expired', deadCode: ErrCode.TOKEN_EXPIRED });
    expect(expired.canRetry).toBe(false);
    expect(expired.canRelogin).toBe(true);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- connection-copy`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `connection-copy.ts`**

创建 `apps/client/src/net/connection-copy.ts`：

```ts
import { ErrCode } from '@fight-the-landlord/protocol';
import type { ConnectionState } from './socket';
import { authErrorMessage } from './copy';

export interface ConnectionCopy {
  title: string;
  message: string;
  canRetry: boolean;
  canRelogin: boolean;
}

export function connectionDeadCopy(state: ConnectionState): ConnectionCopy {
  const canRetry =
    state.deadReason === 'give_up' ||
    state.deadCode === ErrCode.RATE_LIMITED ||
    state.deadCode === ErrCode.CLIENT_DISABLED;
  const canRelogin = state.deadReason === 'session_expired';

  if (state.deadReason === 'session_expired') {
    return {
      title: '登录已过期',
      message: authErrorMessage(ErrCode.TOKEN_EXPIRED, '操作'),
      canRetry: false,
      canRelogin: true,
    };
  }
  if (state.deadReason === 'server_rejected') {
    const title = '连接被终止';
    if (state.deadCode === ErrCode.USER_BANNED) {
      return { title, message: authErrorMessage(ErrCode.USER_BANNED, '操作'), canRetry, canRelogin };
    }
    if (state.deadCode === ErrCode.RATE_LIMITED) {
      return {
        title,
        message: '同一网络的连接数已达上限。请关闭其它窗口或设备后点「重新连接」再试。',
        canRetry,
        canRelogin,
      };
    }
    if (state.deadCode === ErrCode.CLIENT_DISABLED) {
      return { title, message: authErrorMessage(ErrCode.CLIENT_DISABLED, '连接'), canRetry, canRelogin };
    }
    return { title, message: '服务端主动断开了连接。', canRetry, canRelogin };
  }
  return {
    title: '连接已断开',
    message: '多次自动重连仍未成功，请检查网络后手动重试。',
    canRetry,
    canRelogin,
  };
}

export function connectionKickMessage(code: number | null): string {
  if (code === ErrCode.USER_BANNED) return authErrorMessage(ErrCode.USER_BANNED, '操作');
  if (code === ErrCode.CLIENT_DISABLED) return authErrorMessage(ErrCode.CLIENT_DISABLED, '连接');
  if (code === ErrCode.RATE_LIMITED) {
    return '同一网络的连接数已达上限。请关闭其它窗口或设备后点「重新连接」再试。';
  }
  return code === null ? '服务端主动断开了连接。' : '连接已被服务端断开，请重新连接。';
}
```

- [ ] **Step 4: 扩展 `NoticeStack.vue`**

在 `<script setup>` 中加入：

```ts
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { currentSession } from '../composables/useGameSession';
import type { SessionNotice } from '../net/session';
import { connectionDeadCopy } from '../net/connection-copy';

const dismissedBuiltins = ref<Set<string>>(new Set());
const session = computed(() => currentSession.value);
const state = computed(() => session.value?.connectionState.value ?? null);
const topOffset = computed(() =>
  props.surface === 'table' && state.value?.phase !== 'connected' ? 48 : 12,
);

watch(
  () => [state.value?.phase, state.value?.deadReason, state.value?.deadCode],
  () => {
    dismissedBuiltins.value = new Set();
  },
);

const sessionNotice = computed<SessionNotice | null>(() => {
  if (props.surface !== 'lobby' && props.surface !== 'game' && props.surface !== 'table') return null;
  const notice = session.value?.notice.value ?? null;
  if (notice === null) return null;
  const transport = notice.source === 'transport' || notice.source === undefined;
  if (transport) {
    if (props.surface === 'table' && state.value?.phase !== 'connected') return null;
    if (props.surface !== 'table' && state.value?.phase === 'dead') return null;
  }
  return notice;
});

const sessionItem = computed<NoticeItem | null>(() => {
  const notice = sessionNotice.value;
  if (notice === null) return null;
  return { id: 'session-notice', level: notice.level, text: notice.text, durationMs: 0, dismissible: false };
});

const deadItem = computed<NoticeItem | null>(() => {
  if (props.surface !== 'lobby' && props.surface !== 'game') return null;
  const current = state.value;
  if (current?.phase !== 'dead') return null;
  if (dismissedBuiltins.value.has('connection-dead')) return null;
  const copy = connectionDeadCopy(current);
  const actions: NoticeAction[] = [];
  if (copy.canRetry) {
    actions.push({ label: '重新连接', kind: 'primary', onClick: () => session.value?.client.retryConnect() });
  }
  if (copy.canRelogin) {
    actions.push({ label: '重新登录', kind: 'primary', onClick: () => useAuthStore().clearLocalSession() });
  }
  return {
    id: 'connection-dead',
    level: 'error',
    text: copy.message,
    durationMs: 0,
    priority: 'critical',
    dismissible: actions.length === 0,
    actions,
  };
});

const actionItems = computed(() => props.items.filter((item) => (item.actions?.length ?? 0) > 0));
const normalItems = computed(() =>
  props.items.filter((item) => (item.actions?.length ?? 0) === 0),
);

const visible = computed<NoticeItem[]>(() => {
  const items: NoticeItem[] = [];
  if (deadItem.value !== null) items.push(deadItem.value);
  items.push(...actionItems.value);
  if (sessionItem.value !== null) items.push(sessionItem.value);
  for (const item of normalItems.value) {
    const dup = sessionItem.value;
    if (dup !== null && dup.level === item.level && dup.text === item.text) continue;
    items.push(item);
  }
  return items;
});

watch(
  [sessionItem, () => props.items],
  () => {
    const dup = sessionItem.value;
    if (dup === null) return;
    for (const item of props.items) {
      if ((item.actions?.length ?? 0) === 0 && item.level === dup.level && item.text === dup.text) {
        emit('dismiss', item.id);
      }
    }
  },
  { immediate: true, deep: true },
);

function dismissItem(item: NoticeItem): void {
  if (item.id === 'connection-dead') {
    const next = new Set(dismissedBuiltins.value);
    next.add('connection-dead');
    dismissedBuiltins.value = next;
    return;
  }
  emit('dismiss', item.id);
}
```

把模板根加上 `:style="{ top: topOffset + 'px' }"`，`v-for="item in visible"`，关闭按钮调用 `dismissItem(item)`。注意 `props.items` 为本地项；`sessionItem` 与 `deadItem` 不参与本地计时。

- [ ] **Step 5: `ConnectionOverlay` / `ConnectionDeadBar` 改用共享文案**

`ConnectionOverlay.vue`：

```ts
import { connectionDeadCopy } from '../net/connection-copy';
import type { ConnectionCopy } from '../net/connection-copy';

const copy = computed<ConnectionCopy | null>(() =>
  props.state.phase === 'dead' ? connectionDeadCopy(props.state) : null,
);
const isSessionExpired = computed(() => copy.value?.canRelogin ?? false);
const canRetry = computed(() => copy.value?.canRetry ?? false);
const title = computed(() => copy.value?.title ?? '连接已断开');
const message = computed(() => copy.value?.message ?? '');
```

`ConnectionDeadBar.vue` 同样改为 `const copy = computed(() => isDead.value && state.value ? connectionDeadCopy(state.value) : null)`，`text` 用 `copy.value?.message`，`canRetry`/`isSessionExpired` 用 copy 字段。模板与锚点不变。删除两文件不再使用的 `ErrCode` / `authErrorMessage` import。

- [ ] **Step 6: `socket.ts` 迁移 `connectionKickMessage`**

删除 Task 2 在 `socket.ts` 临时定义的 `connectionKickMessage`，改为：

```ts
import { connectionKickMessage } from './connection-copy';
```

并删除 `socket.ts` 不再使用的 `authErrorMessage` import。

- [ ] **Step 7: 写连接矩阵测试**

创建 `apps/client/test/notice-connection-matrix.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode } from '@fight-the-landlord/protocol';
import NoticeStack from '../src/components/NoticeStack.vue';
import { currentSession } from '../src/composables/useGameSession';
import type { SessionNotice } from '../src/net/session';
import type { ConnectionState } from '../src/net/socket';

function fakeSession(phase: 'connected' | 'reconnecting' | 'dead', deadReason: string | null, deadCode: number | null) {
  const notice = ref<SessionNotice | null>(null);
  const connectionState = ref<ConnectionState>({
    phase,
    attempt: 0,
    deadReason: deadReason as ConnectionState['deadReason'],
    deadCode,
  });
  currentSession.value = {
    notice,
    connectionState,
    client: { retryConnect: () => {} },
    clearNotice: () => {},
    disconnect: () => {},
    onDisposition: () => () => {},
  } as never;
  return { notice, connectionState };
}

beforeEach(() => {
  setActivePinia(createPinia());
  currentSession.value = null;
});

describe('连接所有权矩阵', () => {
  it('大厅 dead：只出现 connection-dead 项，且带重试按钮', () => {
    fakeSession('dead', 'give_up', null);
    const wrapper = mount(NoticeStack, { props: { surface: 'lobby', items: [] } });
    expect(wrapper.findAll('.notice')).toHaveLength(1);
    expect(wrapper.text()).toContain('多次自动重连仍未成功');
    expect(wrapper.text()).toContain('重新连接');
    expect(wrapper.find('.notice__close').exists()).toBe(false);
  });

  it('大厅 reconnecting：transport 提示是 sticky 且无死态项', () => {
    const { notice } = fakeSession('reconnecting', null, null);
    notice.value = { level: 'error', text: '连接不可用，请检查网络后重试', source: 'transport', sticky: true };
    const wrapper = mount(NoticeStack, { props: { surface: 'lobby', items: [] } });
    expect(wrapper.text()).toContain('连接不可用');
    expect(wrapper.text()).not.toContain('重新连接');
  });

  it('牌桌非 connected：transport 被抑制，交给 ConnectionOverlay', () => {
    const { notice } = fakeSession('reconnecting', null, null);
    notice.value = { level: 'error', text: '连接不可用', source: 'transport' };
    const wrapper = mount(NoticeStack, { props: { surface: 'table', items: [] } });
    expect(wrapper.text()).toBe('');
  });

  it('牌桌 connected：transport 恢复提示仍显示', () => {
    const { notice } = fakeSession('connected', null, null);
    notice.value = { level: 'info', text: '连接已恢复', source: 'transport' };
    const wrapper = mount(NoticeStack, { props: { surface: 'table', items: [] } });
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('连接已恢复');
  });

  it('11003 死态可关闭但无重试按钮', () => {
    fakeSession('dead', 'server_rejected', ErrCode.USER_BANNED);
    const wrapper = mount(NoticeStack, { props: { surface: 'game', items: [] } });
    expect(wrapper.text()).toContain('该账号已被封禁');
    expect(wrapper.find('.notice__close').exists()).toBe(true);
  });
});
```

- [ ] **Step 7b: 单次呈现（NoticeStack 层）**

创建 `apps/client/test/notice-single-presentation.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode } from '@fight-the-landlord/protocol';
import NoticeStack from '../src/components/NoticeStack.vue';
import { currentSession } from '../src/composables/useGameSession';
import type { SessionNotice } from '../src/net/session';
import type { ConnectionState } from '../src/net/socket';

function setSession(notice: SessionNotice | null, state: ConnectionState) {
  currentSession.value = {
    notice: ref<SessionNotice | null>(notice),
    connectionState: ref<ConnectionState>(state),
    client: { retryConnect: () => {} },
    clearNotice: () => {},
    disconnect: () => {},
    onDisposition: () => () => {},
  } as never;
}

beforeEach(() => {
  setActivePinia(createPinia());
  currentSession.value = null;
});

describe('单次呈现', () => {
  it('session 与本地普通项同文：只渲染一条', () => {
    setSession({ level: 'error', text: 'x', source: 'action' }, { phase: 'connected', attempt: 0, deadReason: null, deadCode: null });
    const wrapper = mount(NoticeStack, {
      props: { surface: 'lobby', items: [{ id: 'local', level: 'error', text: 'x' }] },
    });
    expect(wrapper.findAll('.notice__text').filter((n) => n.text() === 'x')).toHaveLength(1);
  });

  it('带动作的本地项不被 session 同文去重吞掉', () => {
    setSession({ level: 'error', text: 'x', source: 'action' }, { phase: 'connected', attempt: 0, deadReason: null, deadCode: null });
    const wrapper = mount(NoticeStack, {
      props: {
        surface: 'lobby',
        items: [{ id: 'local-action', level: 'error', text: 'x', actions: [{ label: '重试', onClick: () => {} }] }],
      },
    });
    expect(wrapper.findAll('.notice__text').filter((n) => n.text() === 'x')).toHaveLength(2);
  });

  it('10008 死态 + 同文 transport：只渲染带重试的死态项', () => {
    setSession(
      { level: 'error', text: '当前客户端已暂停服务，请稍后再试或更换客户端', source: 'transport' },
      { phase: 'dead', attempt: 0, deadReason: 'server_rejected', deadCode: ErrCode.CLIENT_DISABLED },
    );
    const wrapper = mount(NoticeStack, { props: { surface: 'lobby', items: [] } });
    expect(wrapper.findAll('.notice__text')).toHaveLength(1);
    expect(wrapper.text()).toContain('重新连接');
  });
});
```

- [ ] **Step 8: 更新 `connection-overlay` / `connection-dead` 既有断言**

- 10006 文案统一为新「同一网络…」。
- `ConnectionDeadBar` 的 `canRetry`/`relogin` 仍由共享 copy 决定；旧选择器不变。
- 新增 `connection-copy` 单测已覆盖 11003/10008/session_expired。

- [ ] **Step 9: 跑测试**

Run: `pnpm -C apps/client test -- connection-copy notice-connection-matrix notice-single-presentation connection-overlay connection-dead`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add apps/client/src/net/connection-copy.ts apps/client/src/components/NoticeStack.vue apps/client/src/components/ConnectionOverlay.vue apps/client/src/components/ConnectionDeadBar.vue apps/client/src/net/socket.ts apps/client/test/connection-copy.test.ts apps/client/test/notice-connection-matrix.test.ts apps/client/test/notice-single-presentation.test.ts apps/client/test/connection-overlay.test.ts apps/client/test/connection-dead.test.ts
git commit -m "feat(client): 连接文案单一真源与 Stack 死态项

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 登录页 + auth 静默路径

**Files:**
- Modify: `apps/client/src/pages/login/login.vue`
- Modify: `apps/client/src/stores/auth.ts`
- Test: `apps/client/test/login-screen.test.ts`
- Test: `apps/client/test/auth-flow.test.ts`
- Test: `apps/client/test/auth-ui-wiring.test.ts`（登录段）
- Test: `apps/client/test/error-disposition.test.ts`

**Interfaces:**
- Produces: `auth.clearLocalSession(message?: string): void`
- Produces: `auth.sessionEnded(message: string): void`

- [ ] **Step 1: 写失败测试**

在 `login-screen.test.ts` 加（并把顶部改为 `import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';`）：

```ts
it('字段校验与登录失败都渲染为 NoticeStack 项，不再有内联错误行', async () => {
  const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  await wrapper.find('.login__actions .btn--primary').trigger('click');
  expect(wrapper.find('.login__field-error').exists()).toBe(false);
  expect(wrapper.find('[data-notice-id="field"] .notice__text').text()).toContain('请输入手机号');
});

it('10005 登录尝试仍静默（负对照）', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ code: 10005, message: '签名无效', data: null }),
  })));
  const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
  await wrapper.find('.login__field--phone input').setValue('13800000000');
  await wrapper.find('input[type="password"]').setValue('secret');
  await wrapper.find('.login__actions .btn--primary').trigger('click');
  await flushPromises();
  expect(useAuthStore().error).toBe('');
  expect(wrapper.find('.notice').exists()).toBe(false);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- login-screen`
Expected: FAIL，仍是 `.login__field-error`。

- [ ] **Step 3: 登录页迁移**

在 `<script setup>` 把 `import { computed, ref } from 'vue';` 改为 `import { computed, ref, watch } from 'vue';`，并加：

```ts
import NoticeStack from '../../components/NoticeStack.vue';
import { usePageNotices } from '../../composables/usePageNotices';

const notices = usePageNotices();
const { items: noticeItems } = notices;

watch(
  () => auth.error,
  (text) => {
    notices.setNotice('auth', text, { level: 'error', durationMs: 0 });
  },
  { immediate: true },
);

function setFieldError(text: string): void {
  notices.setNotice('field', text, { level: 'error' });
}
```

把 `validate()` 的调用点改为：

```ts
const invalid = validate();
if (invalid) {
  setFieldError(invalid);
  return;
}
notices.dismiss('field');
```

删除 `const fieldError = ref('');`；`setMode` 里改 `notices.dismiss('field');`。

模板删除：

```vue
<text v-if="fieldError" class="login__field-error">{{ fieldError }}</text>
<text v-if="auth.error" class="login__error">{{ auth.error }}</text>
```

在 `<LandscapeStage>` 内加：

```vue
<template #overlay>
  <NoticeStack :items="noticeItems" surface="login" @dismiss="notices.dismiss" />
</template>
```

- [ ] **Step 4: auth store 静默路径**

在 `apps/client/src/stores/auth.ts`：

```ts
clearLocalSession(message?: string) {
  if (message !== undefined) this.error = message;
  stopSessionHook?.();
  clearSession();
  this.accessToken = '';
  this.refreshToken = '';
  this.userId = '';
  this.nickname = '';
  this.phone = '';
  clientConfig.token = '';
  this.loggedIn = false;
  this.navigate('login');
},

sessionEnded(message: string) {
  this.clearLocalSession(message);
},
```

`signIn/signUp` 的 catch：

```ts
this.error = '登录失败，请稍后重试';
// 或 '注册失败，请稍后重试'
reportError('auth.signIn', error);
```

（导入 `reportError` from `'../observability/reporter'`；source-boundary 允许包内相对导入。）

`signOut` 的两条错误文案改为：

```ts
this.error = '服务端登出未成功，本地会话已清除';
this.error = '服务端登出失败，本地会话已清除';
```

`renewHydratedSession` 的 `invalid/no_session`：

```ts
this.sessionEnded('登录状态已失效，请重新登录');
```

- [ ] **Step 5: 更新 auth 测试**

- `login-screen` 既有 7 处：`.login__field-error`（`:106,119,138,143,155`）→ `[data-notice-id="field"] .notice__text`；`.login__error`（`:174-179`）→ `[data-notice-id="auth"] .notice__text`；无错误时断言 `.notice` 不存在。
- `auth-ui-wiring` 登录段：`.login__error` / `.login__field-error` → `.notice`/`[data-notice-id="auth"]`/`[data-notice-id="field"]`；10005 负对照改为 `wrapper.find('.notice').exists() === false`。
- `auth-flow` 11002 仍为 `密码错误`；断言改读 `.notice`。
- `error-disposition` 的 `signOutLocally` 参数形状更新。

- [ ] **Step 6: 跑测试并提交**

Run: `pnpm -C apps/client test -- login-screen auth-flow auth-ui-wiring error-disposition`
Expected: PASS。

```bash
git add apps/client/src/pages/login/login.vue apps/client/src/stores/auth.ts apps/client/test/login-screen.test.ts apps/client/test/auth-flow.test.ts apps/client/test/auth-ui-wiring.test.ts apps/client/test/error-disposition.test.ts
git commit -m "feat(client): 登录提示浮层化与 auth 静默路径补因

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 历史战绩页

**Files:**
- Modify: `apps/client/src/pages/history/history.vue`
- Test: `apps/client/test/history-records.test.ts`

- [ ] **Step 1: 写失败测试**

在 `history-records.test.ts` 加：

```ts
it('加载失败显示静态失败态 + 一条 sticky 错误项（可重试）', async () => {
  stubFetch(() => ({ code: 10007, message: '上游不可用', data: null }), 500);
  const wrapper = mount(HistoryPage, { global: { plugins: [pinia] } });
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  await flushPromises();
  expect(wrapper.find('.history__error').exists()).toBe(false);
  expect(wrapper.find('[data-notice-id="history"] .notice__text').text()).toContain('服务暂时不可用，请稍后重试');
  expect(wrapper.find('.history__muted').text()).toContain('历史战绩加载失败');
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- history-records`
Expected: FAIL。

- [ ] **Step 3: 迁移历史页**

在 `<script setup>` 加：

```ts
import NoticeStack from '../../components/NoticeStack.vue';
import { usePageNotices } from '../../composables/usePageNotices';
import { playerMessage } from '../../net/copy';

const notices = usePageNotices();
const { items: noticeItems } = notices;

function showHistoryError(text: string): void {
  notices.setNotice('history', text, {
    level: 'error',
    durationMs: 0,
    priority: 'critical',
    dismissible: true,
    actions: [{ label: '重试', onClick: () => void loadFirst() }],
  });
}
```

`load` 的非 0 `toast`：

```ts
toast: (report) => {
  error.value = `历史战绩加载失败：${playerMessage(report.code, { context: 'rest', serverMessage: report.message })}`;
  showHistoryError(error.value);
},
```

catch 分支同样写 `error.value = '历史战绩加载失败，请稍后重试'` 并 `showHistoryError`。成功时 `notices.dismiss('history')`。

更新 `history-records.test.ts` 既有的两条失败态断言（`:394-416`）：
- `.history__error` 存在性改为 `.history__muted` 含 `历史战绩加载失败`；
- 错误文案改为 `[data-notice-id="history"] .notice__text`；
- 成功/空列表用例补 `expect(wrapper.find('[data-notice-id="history"]').exists()).toBe(false)`。

模板：
- 删除 `<text v-if="error" class="history__error">…</text>`。
- 在空态/加载态三元组里保留静态失败文案：`v-else-if="error"` 显示 `<text class="history__muted">历史战绩加载失败</text>`（class 可按现有中性样式调整）。
- 在 `<LandscapeStage>` 内加：

```vue
<template #overlay>
  <NoticeStack :items="noticeItems" surface="history" @dismiss="notices.dismiss" />
</template>
```

- [ ] **Step 4: 跑测试并提交**

Run: `pnpm -C apps/client test -- history-records`
Expected: PASS。

```bash
git add apps/client/src/pages/history/history.vue apps/client/test/history-records.test.ts
git commit -m "feat(client): 历史战绩提示浮层化与静态失败态

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 钱包页

**Files:**
- Modify: `apps/client/src/pages/wallet/wallet.vue`
- Test: `apps/client/test/wallet-page.test.ts`

- [ ] **Step 1: 写失败测试**

在 `wallet-page.test.ts` 加：

```ts
it('冒烟：NoticeStack 挂载且无 .wallet__error（逐类断言由 Step 4 迁移承担）', async () => {
  const wrapper = mount(WalletPage, { global: { plugins: [pinia] } });
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  await flushPromises();
  expect(wrapper.find('.wallet__error').exists()).toBe(false);
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- wallet-page`
Expected: FAIL，仍有 `.wallet__error`。

- [ ] **Step 3: 迁移钱包页**

在 `<script setup>` 加：

```ts
import NoticeStack from '../../components/NoticeStack.vue';
import { usePageNotices } from '../../composables/usePageNotices';
import { playerMessage } from '../../net/copy';

const notices = usePageNotices();
const { items: noticeItems } = notices;

function setError(id: string, text: string, retry?: () => void): void {
  notices.setNotice(id, text, {
    level: 'error',
    durationMs: retry ? 0 : 8000,
    priority: retry ? 'critical' : 'normal',
    dismissible: true,
    actions: retry ? [{ label: '重试', onClick: retry }] : undefined,
  });
}
```

替换规则：

- 所有 catch 分支改为中性文案（`钱包信息加载失败，请稍后重试` / `下单失败，请稍后重试` / `提现申请失败，请稍后重试` / `记录加载失败，请稍后重试` / `订单查询失败，请稍后重试`），原始异常进 `reportError`；不得把 `e.message` 拼进玩家文案。
- 本页所有 `dispatchRestFailure.signOutLocally`（summary/recharge/withdraw/list/return）按 Global 改为 `auth.sessionEnded(playerMessage(report.code, { context: 'auth' }))`。
- `summaryError`、`lists[].error`、`withdrawResult` 保留 ref（静态失败/成功状态与控制流用）；`rechargeError`、`withdrawError`、`returnError`、`payHint` 在替换完所有写入后删除（模板已不再渲染，避免 `noUnusedLocals`）。

- `summaryError.value = …` → `setError('summary', text, () => void loadSummary())`，同时保留 `summaryError` 供静态失败文案/template 控制流。
- `rechargeError.value = …` → `setError('recharge', text)`。
- `payHint.value = pay.PAY_BROWSER_HINT` → `notices.setNotice('pay-hint', pay.PAY_BROWSER_HINT, { level: 'info', durationMs: 0, priority: 'critical' })`。
- `withdrawError.value = …` → `setError('withdraw', text)`。
- `withdrawResult.value = …` → 用 `WITHDRAW_STATUS_LABEL[data.status]` 与 `data.withdrawNo` 拼出 `申请已提交：<label>（<no>）`，再 `notices.setNotice('withdraw-result', text, { level: 'success', durationMs: 6000 })`。
- `lists[tab].error = …` → `setError(`list-${tab}`, text, () => reloadTab(tab))`，保留 `state.error` 控制流。
- `returnError.value = …` → `setError('return', text)`。
- `reauth` 的非 0 改为：

```ts
await dispatchRestFailure(reRes, {
  toast: (report) => {
    const text = playerMessage(report.code, { context: 'rest', serverMessage: report.message });
    setError('withdraw', text);
  },
  signOutLocally: (report) => {
    stopGameSession();
    auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
  },
  replay: async () => {
    // reauth 不自动重放：避免重复密码校验；提示用户重新提交（TOAST/BACK_TO_LOBBY 已处置）。
  },
});
```

模板：
- 删除 `.wallet__error`、`.wallet__hint`、`.wallet__withdraw-result` 的渲染行。
- 在对应面板保留静态失败文案（用新类 `.wallet__failure`，**不要**用 `.wallet__muted`，否则会撞 `wallet-page.test.ts:664` 的“失败时记录区不得有 muted”断言）：`<text v-if="summaryError" class="wallet__failure">钱包信息暂不可用</text>`；列表失败显示 `<text v-if="lists[activeTab].error" class="wallet__failure">记录加载失败</text>`；提现成功状态在面板内保留一条静态 `<text v-if="withdrawResult" class="wallet__muted">申请已提交：{{ WITHDRAW_STATUS_LABEL[withdrawResult.status] }}（{{ withdrawResult.withdrawNo }}）</text>`（静态状态），同时 Stack 显示 6s success 项。为 `.wallet__failure` 加一条与 `.wallet__error` 同色的 scoped 样式。
- 在 `<LandscapeStage>` 内加：

```vue
<template #overlay>
  <NoticeStack :items="noticeItems" surface="wallet" @dismiss="notices.dismiss" />
</template>
```

- [ ] **Step 4: 更新既有 wallet 测试**

- `.wallet__error`（summary/recharge/withdraw/list/return）→ `[data-notice-id="summary"|"recharge"|"withdraw"|"list-orders"|...|"return"] .notice__text`；
- `.wallet__hint`（payHint）→ `[data-notice-id="pay-hint"] .notice__text`；
- `.wallet__withdraw-result` → `[data-notice-id="withdraw-result"] .notice__text`，并保留对静态 `.wallet__muted` 中 `wd_new` 的断言；
- 成功/无错路径补 `expect(wrapper.find('.wallet__error').exists()).toBe(false)` 与对应 `[data-notice-id]` 不存在断言；
- 10007 的失败断言从服务端 `下游不可用` 改为固定文案 `服务暂时不可用，请稍后重试`（10007 已归 FIXED）。
- 下单开始时 `notices.dismiss('pay-hint')`，成功/失败收口后也不得让旧 `pay-hint` 滞留。
- `loadSummary` 成功时 `notices.dismiss('summary')`；`loadTab(tab)` 成功时 `notices.dismiss('list-' + tab)`，否则 sticky 项永久滞留。

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm -C apps/client test -- wallet-page wallet-entry`
Expected: PASS。

```bash
git add apps/client/src/pages/wallet/wallet.vue apps/client/test/wallet-page.test.ts
git commit -m "feat(client): 钱包提示浮层化与面板静态失败态

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 大厅页

**Files:**
- Modify: `apps/client/src/pages/lobby/lobby.vue`
- Test: `apps/client/test/base-score-selection.test.ts`
- Test: `apps/client/test/lobby-ux.test.ts`
- Test: `apps/client/test/ads-flow.test.ts`
- Test: `apps/client/test/connection-dead.test.ts`（大厅页面级用例本任务迁到 NoticeStack）

- [ ] **Step 1: 写失败测试**

在 `lobby-ux.test.ts` 加：

```ts
it('大厅提示全部浮层化：无 .lobby__notice/.lobby__levels-error/.lobby__update-bar', async () => {
  const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  await flushPromises();
  expect(wrapper.find('.lobby__notice').exists()).toBe(false);
  expect(wrapper.find('.lobby__levels-error').exists()).toBe(false);
  expect(wrapper.find('.lobby__update-bar').exists()).toBe(false);
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- lobby-ux`
Expected: FAIL。

- [ ] **Step 3: 迁移大厅**

在 `<script setup>` 把 `import { computed, onMounted, onUnmounted, ref } from "vue";` 改为加入 `watch`，并加：

```ts
import NoticeStack from '../../components/NoticeStack.vue';
import { usePageNotices } from '../../composables/usePageNotices';

const notices = usePageNotices();
const { items: noticeItems } = notices;
```

把 `levelsError` 拆成两个状态：

```ts
const levelsFailed = ref(false);
const levelsEmpty = ref(false);
```

`loadClientConfig` 成功空表：

```ts
levelsEmpty.value = cfg.baseScoreLevels.length === 0;
levelsFailed.value = false;
notices.dismiss('levels');
```

失败：

```ts
levelsFailed.value = true;
levelsEmpty.value = false;
notices.setNotice('levels', '档位表加载失败，请稍后重试', {
  level: 'error',
  durationMs: 0,
  priority: 'critical',
  dismissible: true,
  actions: [{ label: '重试', onClick: () => void loadClientConfig() }],
});
```

`loadClientConfig` 的 catch 分支同样走上面的静态失败 + sticky 项，不把 `e.message` 拼进玩家文案；原始异常进 `reportError`。

本页所有 `dispatchRestFailure.signOutLocally`（config/balance/relief）按 Global 改为 `stopGameSession(); auth.sessionEnded(playerMessage(report.code, { context: 'auth' }))`。

`entryError`：

```ts
notices.setNotice('entry', `金币不足：该场次需要 ≥ ${need}`, { level: 'warn' });
```

原来清空 `entryError` 的调用点（切换场次/档位）改为 `notices.dismiss('entry')`；删除 `entryError` ref（模板已不再渲染）。

`reliefNote` 联合 watcher：

```ts
watch(
  [reliefNote, reliefOpen],
  ([note, open]) => {
    if (note !== '' && !open) {
      const level = note.startsWith('已领取救助') ? 'success' : note === '网络异常，请重试' ? 'error' : 'warn';
      notices.setNotice('relief', note, { level, durationMs: level === 'success' ? 3000 : 6000 });
    } else {
      notices.dismiss('relief');
    }
  },
  { immediate: true },
);
```

版本更新：

```ts
watch(
  updateAvailable,
  (available) => {
    if (available) {
      notices.setNotice('update', '发现新版本，刷新后即可体验', {
        level: 'info',
        durationMs: 0,
        priority: 'critical',
        dismissible: true,
        actions: [{ label: '立即刷新', kind: 'primary', onClick: reloadApp }],
      });
    } else {
      notices.dismiss('update');
    }
  },
  { immediate: true },
);
```

模板：
- 删除 `.lobby__update-bar` 块、`.lobby__levels-error`、`.lobby__entry-error`、面板外 `.lobby__relief-note`、`SessionNotice`、`ConnectionDeadBar`；删除 `levelsError`/`entryError` ref 与这两个组件的 import。
- 保留面板内 `.lobby__relief-note`。
- 档位区三段改为：`v-if="store.baseScoreLevels.length > 0"`（原样）；`v-else-if="levelsFailed"` 显示 `<text class="lobby__levels-empty">档位表加载失败，请稍后重试</text>`；`v-else-if="levelsEmpty"` 显示 `<text class="lobby__levels-empty">档位表为空，暂无可用档位</text>`；`v-else` 保留 `<text class="lobby__levels-empty">底分档位表加载中…</text>`。不要引用不存在的 `loading` ref。
- 在 `<LandscapeStage>` 内加：

```vue
<template #overlay>
  <NoticeStack :items="noticeItems" surface="lobby" @dismiss="notices.dismiss" />
</template>
```

- [ ] **Step 4: 更新既有测试**

- `base-score-selection`：
  - 成功态“不该有错误行”改为 `expect(wrapper.find('.lobby__levels-empty').exists()).toBe(false)`；
  - 10007/fetch 失败断言改为 `.lobby__levels-empty` 含 `档位表加载失败`；
  - code 0 空表断言改为 `.lobby__levels-empty` 含 `档位表为空`；
  - 10004 回登录原因不要断言 LobbyPage 上的 notice（该页不渲染 auth.error）：断言 `useAuthStore().error === '登录状态已失效，请重新登录'` 且 `auth.page === 'login'`；原因由 Task 5 的登录页 watch 显示。
- `lobby-ux`：
  - `.lobby__notice` → `[data-notice-id="session-notice"]`（错误级别断言用该项的 `.notice--error`，不要断言容器）；
  - `.lobby__entry-error` → `[data-notice-id="entry"] .notice__text`；
  - 面板外 `.lobby__relief-note` → `[data-notice-id="relief"] .notice__text`；
  - 创建房间失败（REST）→ `.notice__text` 含 `创建房间失败：` + 客户端文案（12005 → `没有权限进行该操作`）；
  - 加入房间失败（WS ack）→ 只断言 session notice 的 `房间已满`，不再有 `加入房间失败（code=…）` 前缀；
  - R455 源码闸保留（页面仍不得出现 `hasConnected`/`.connected`/`phase`）。
- `ads-flow`：面板外 `.lobby__relief-note` → `[data-notice-id="relief"] .notice__text`；面板内断言不变。
- `lobby-modes.test.ts:341` 的 `.lobby__levels-error` 存在性断言改为 `.lobby__levels-empty`（成功态不得出现），避免类名删除后恒真假绿。
- `connection-dead.test.ts` 的大厅页面级用例本任务迁到 `[data-notice-id="connection-dead"]` / `[data-notice-id="session-notice"] .notice__text`，保留“换会话不残留”两半。
- `notice-presentation` 的 lobby 段：删除 `.lobby__notice` 规则断言，改为断言 `lobby.vue` 含 `<NoticeStack` 与 `#overlay`（Task 11 最终重写整文件）。

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm -C apps/client test -- base-score-selection lobby-ux ads-flow`
Expected: PASS。

```bash
git add apps/client/src/pages/lobby/lobby.vue apps/client/test/base-score-selection.test.ts apps/client/test/lobby-ux.test.ts apps/client/test/ads-flow.test.ts apps/client/test/lobby-modes.test.ts apps/client/test/connection-dead.test.ts
git commit -m "feat(client): 大厅提示浮层化与面板失败态

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 玩法页

**Files:**
- Modify: `apps/client/src/pages/game/game.vue`
- Test: `apps/client/test/auth-ui-wiring.test.ts`（玩法段）
- Test: `apps/client/test/card-counter-purchase.test.ts`
- Test: `apps/client/test/match-state.test.ts`
- Test: `apps/client/test/connection-dead.test.ts`（玩法页面级用例本任务迁到 NoticeStack）
- Test: `apps/client/test/notice-connection-matrix.test.ts`（game surface）

- [ ] **Step 1: 写失败测试**

在 `auth-ui-wiring.test.ts` 加：

```ts
it('玩法页匹配失败只出现一条 NoticeStack 项，无 .game__error', async () => {
  const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  await flushPromises();
  expect(wrapper.find('.game__error').exists()).toBe(false);
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- auth-ui-wiring`
Expected: FAIL。

- [ ] **Step 3: 迁移玩法页**

在 `<script setup>` 加：

```ts
import NoticeStack from '../../components/NoticeStack.vue';
import { usePageNotices } from '../../composables/usePageNotices';
import { classifyAck } from '../../net/errors';
import { playerMessage } from '../../net/copy';
import { ConnectionDeadError } from '../../net/socket';
import { ClientAction } from '@fight-the-landlord/protocol';

const notices = usePageNotices();
const { items: noticeItems } = notices;
function showGameError(id: string, text: string): void {
  notices.setNotice(id, text, { level: 'error' });
}
```

替换：
- 删除 `error` ref；按来源分流，**不要 1:1 替换**：
  - **WS ack 非 0（match/unmatch/join/room.*）**：只由 session notice 呈现，页面不写任何本地文案；`12009` 幂等成功、`12011` 只导航。
  - **本地条件**：未选底分 `请先在大厅选择底分`、`blocked`（非 `ConnectionDeadError`）`上一个操作还在进行中，请稍候`、catch（中性 `匹配失败，请稍后重试` 等）→ `showGameError`。
  - **REST 失败（joinRoom/createRoom）**：走 `dispatchRestFailure` → `showGameError`（带 `加入房间失败：` / `创建房间失败：` 前缀）。
  - 每次动作开始时 `notices.dismiss('game-error')`（替代原来的清空）。
- `ccError.value = …` 保留 ref（`ccAttention` 入口圆点依赖它），同时调用 `showGameError('cc-error', text)`；成功/重试时 `ccError.value = ""` 并 `notices.dismiss('cc-error')`。模板不再渲染 `ccError` 文本。
- `loadRooms` 失败改为：

```ts
notices.setNotice(
  'rooms',
  `房间列表加载失败：${playerMessage(report.code, { context: 'rest', serverMessage: report.message })}`,
  {
    level: 'error',
    durationMs: 0,
    priority: 'critical',
    dismissible: true,
    actions: [{ label: '刷新', onClick: () => void loadRooms() }],
  },
);
```

保留服务端 message，别丢 `参数错误` 等具体原因。`loadRooms` 成功时 `notices.dismiss('rooms')`。
- `waitPrompt` watcher：

```ts
watch(
  [() => store.matchWaitPrompt, busy],
  ([prompt]) => {
    if (prompt === null) {
      notices.dismiss('match-wait');
      return;
    }
    notices.setNotice('match-wait', prompt, {
      level: 'warn',
      durationMs: 0,
      priority: 'critical',
      dismissible: false,
      actions: [
        { label: '重新匹配', disabled: () => busy.value, onClick: () => void rematchAfterPrompt() },
        { label: '延长匹配时间', kind: 'primary', disabled: () => busy.value, onClick: () => void extendMatching() },
      ],
    });
  },
  { immediate: true },
);
```

- `join()` 的 REST 占座改为（新增 `replayed` 参数；dispatch 前先释放 `busy`，否则 replay 会被入口守卫吞掉）：

在 `game.vue` 顶部加：

```ts
const ROOM_LOCAL_CODES = new Set([
  ErrCode.ROOM_NOT_FOUND,
  ErrCode.ROOM_FULL,
  ErrCode.NOT_IN_ROOM,
  ErrCode.ROOM_ALREADY_STARTED,
]);
```

把 `join()` 里 `const seated = await rest.joinRoom(code);` 之后的 `if (seated.code !== 0) { … }` 整块替换为：

```ts
if (seated.code !== 0) {
  busy.value = false;
  if (ROOM_LOCAL_CODES.has(seated.code as ErrCode)) {
    showGameError(
      'game-error',
      `加入房间失败：${playerMessage(seated.code, { context: 'rest', serverMessage: seated.message })}`,
    );
    return;
  }
  await dispatchRestFailure(seated, {
    toast: (report) =>
      showGameError(
        'game-error',
        `加入房间失败：${playerMessage(report.code, { context: 'rest', serverMessage: report.message })}`,
      ),
    signOutLocally: (report) => {
      stopGameSession();
      auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
    },
    replay: () => (replayed ? Promise.resolve() : join(code, true)),
  });
  return;
}
```

**REST 占座不是会话失效场景**：12001/12002/12004/12008 只做本地提示，绝不能走 `dispatchRestFailure` 的 `BACK_TO_LOBBY` 分支（否则“房间已满”会把玩家登出）。函数签名改为 `join(entered?: string, replayed = false)`。

- `createAndJoin(replayed = false)` 的 `res.code !== 0`：

```ts
if (res.code !== 0) {
  busy.value = false;
  if (ROOM_LOCAL_CODES.has(res.code as ErrCode)) {
    showGameError(
      'game-error',
      `创建房间失败：${playerMessage(res.code, { context: 'rest', serverMessage: res.message })}`,
    );
    return;
  }
  await dispatchRestFailure(res, {
    toast: (report) =>
      showGameError(
        'game-error',
        `创建房间失败：${playerMessage(report.code, { context: 'rest', serverMessage: report.message })}`,
      ),
    signOutLocally: (report) => {
      stopGameSession();
      auth.sessionEnded(playerMessage(report.code, { context: 'auth' }));
    },
    replay: () => (replayed ? Promise.resolve() : createAndJoin(true)),
  });
  return;
}
```
- `match` / `unmatch` / `join` / `createAndJoin` 的 catch 分支改为中性文案：`匹配失败，请稍后重试` / `取消失败，请稍后重试` / `加入房间失败，请稍后重试` / `创建房间失败，请稍后重试`；原始异常进 `reportError`。
- `loadCardCounterStatus`：`res.code !== 0` 时：

```ts
const classified = classifyAck(res);
if (classified.action === ClientAction.BACK_TO_LOBBY) {
  stopGameSession();
  auth.sessionEnded(playerMessage(res.code, { context: 'auth' }));
} else {
  ccStatusFailed.value = true;
}
```

导入 `classifyAck`（`../../net/errors`）与 `ClientAction`（protocol）。

- `sendCardCounterPurchase` 在 switch 前加：

```ts
const classified = classifyAck(res);
if (classified.action === ClientAction.BACK_TO_LOBBY) {
  clearPendingCardCounterPurchase();
  stopGameSession();
  auth.sessionEnded(playerMessage(res.code, { context: 'auth' }));
  return;
}
```

其余 14009/14010/14001/14008/10007/default 业务分支保留。
- `sendCardCounterPurchase` 的 `default`/网络错误保持现有 ccError 分支，改为 `showGameError('cc-error', text)`。
- 14009 后 `refreshClientConfig()` 失败显示 `价格刷新失败，请重试`（同一 `cc-error`），保留待确认记录。
- `ConnectionDeadError`：`match/unmatch/join` 的 blocked/catch 分支先判 `outcome.reason instanceof ConnectionDeadError`，是则直接 return，不写本地错误。

模板：
- `createAndJoin` 的按钮绑定从 `@click="createAndJoin"` 改为 `@click="createAndJoin()"`（否则 MouseEvent 会被当成 `replayed`，replay 永不执行）。
- 删除 `.game__error`、`.game__waitprompt`、`SessionNotice`、`ConnectionDeadBar` 及对应 import；删除 `error` ref（`ccError` 保留给 `ccAttention`）；删除模板删除后不再被读取的 `waitPrompt` computed（watcher 直接读 `store.matchWaitPrompt`）。
- 保留 `ccBlockWarning`/`ccStatusFailed` 的弹层内 `.game__hint`。
- 在 `<LandscapeStage>` 内加：

```vue
<template #overlay>
  <NoticeStack :items="noticeItems" surface="game" @dismiss="notices.dismiss" />
</template>
```

- [ ] **Step 4: 更新测试**

- `auth-ui-wiring` 玩法段：`.game__error`/`.game__notice`/`.game__waitprompt` → `[data-notice-id]`；`.game__waitprompt-text` → `[data-notice-id="match-wait"] .notice__text`；`.game__waitprompt-btn` → `[data-notice-id="match-wait"] .notice__action`（两个按钮文案不变）；`.game__match button` 唯一性仍成立。
- `card-counter-purchase`：`.game__error` → `[data-notice-id="cc-error"] .notice__text`；弹层打开期间 `[data-notice-id="rooms"]` 仍显示（Stack z=15 高于弹层），弹层高度不变——把旧“让位”断言反转为“提示仍可见且不挤压弹层”。
- `match-state`：`store.matchWaitPrompt` 仍保留；`.game__waitprompt` 断言改为 `[data-notice-id="match-wait"]`。
- `notice-connection-matrix` 增加 `surface="game"` 的死态用例（与大厅同）。

- 单次呈现的结构性判据在 Task 4 的 `notice-single-presentation.test.ts`（NoticeStack 合并去重）；本任务只负责 `[data-notice-id]` 迁移与 `.game__error` 清零，不重复造 FakeSocket 页面夹具。
- `notice-presentation` 的 game 段：删除 `.game__notice` 规则断言，改为断言 `game.vue` 含 `<NoticeStack` 与 `#overlay`。
- `lobby-ux` 的两种进房失败要分开：
  - **REST 占座** 12002（`rejectClaim`）⇒ 本地 `[data-notice-id="game-error"] .notice__text` 含 `加入房间失败：房间已满`，**不得登出**（`auth.page` 仍是 `game`）；
  - **WS `room.join` ack** 12002 ⇒ 只断言 session notice 的 `房间已满`，无 `加入房间失败：` 前缀。
- `connection-dead.test.ts` 的玩法页面级用例本任务迁到 `[data-notice-id="connection-dead"]` / `[data-notice-id="session-notice"] .notice__text`，保留“换会话不残留”两半。

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm -C apps/client test -- auth-ui-wiring card-counter-purchase match-state notice-connection-matrix connection-dead`
Expected: PASS。

```bash
git add apps/client/src/pages/game/game.vue apps/client/test/auth-ui-wiring.test.ts apps/client/test/card-counter-purchase.test.ts apps/client/test/match-state.test.ts apps/client/test/notice-connection-matrix.test.ts apps/client/test/connection-dead.test.ts
git commit -m "feat(client): 玩法页提示浮层化与 REST 统一处置

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 牌桌页

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`
- Test: `apps/client/test/table-play-ui.test.ts`
- Test: `apps/client/test/action-feedback.test.ts`
- Test: `apps/client/test/notice-connection-matrix.test.ts`（table surface）
- Test: `apps/client/test/connection-overlay.test.ts`

- [ ] **Step 1: 写失败测试**

在 `table-play-ui.test.ts` 加：

```ts
it('牌桌动作拒绝只出现一条 .notice，无 .table__notice', async () => {
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  await flushPromises();
  expect(wrapper.find('.table__notices').exists()).toBe(false);
  expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test -- table-play-ui`
Expected: FAIL。

- [ ] **Step 3: 迁移牌桌**

在 `<script setup>` 加：

```ts
import NoticeStack from '../../components/NoticeStack.vue';
import { usePageNotices } from '../../composables/usePageNotices';
import { ConnectionDeadError } from '../../net/socket';

const notices = usePageNotices();
const { items: noticeItems } = notices;
```

`send()`（table.vue 的动作发送函数）：

```ts
if (outcome.status === 'blocked') {
  if (outcome.reason instanceof ConnectionDeadError) return;
  notices.setNotice('table-local', '上一个操作尚未确认，请稍候', { level: 'warn' });
  haptic('medium');
  return;
}
if (outcome.code === ErrCode.NOT_YOUR_TURN) {
  notices.setNotice('table-12003', actionCopyFor(ErrCode.NOT_YOUR_TURN)!, { level: 'warn' });
  return;
}
if (outcome.code !== ErrCode.OK) {
  // 服务端错误由 session notice 呈现；不写本地文案
  haptic('heavy');
  return;
}
```

`doLeave` 失败：

```ts
notices.setNotice('table-local', '退出失败，请重试', { level: 'error' });
```

12001 视为成功时：

```ts
if (outcome.code === ErrCode.ROOM_NOT_FOUND) getGameSession().clearNotice();
```

`ConnectionDeadError` catch 分支同样直接 return。

删除 `visibleNotice` / `suppressedNoticeText` / `localError` / `notice` computed 与两个 watch；所有 `localError.value = …` 写入改为 `notices.setNotice('table-local', …)`。结算出现时的 `localError.value = ""` 改为 `notices.dismiss('table-local')`。把 `import { actionErrorMessage } from '../../net/action-copy'` 改为 `import { actionCopyFor } from '../../net/action-copy'`。

模板：
- 删除 `.table__notices` 块。
- 在 `<LandscapeStage>` 内加：

```vue
<template #overlay>
  <NoticeStack :items="noticeItems" surface="table" @dismiss="notices.dismiss" />
</template>
```
- 保留 `ConnectionOverlay`。

- [ ] **Step 4: 更新测试**

- `table-play-ui`：`.table__notice` → `[data-notice-id] .notice__text`；删除 `suppressedNoticeText` 断言；单条断言改用 `.notice__text` 精确文本。**12001 断言反转**：`room.leave` 12001 视为成功，不得出现「房间不存在」；另用 13001 的真实拒绝作为“页面有提示”的正对照。
- `action-feedback`：未知码/12003 断言；`.table__notice` → `.notice__text`。旧“同源 notice 不得复活”改为新语义：下一次动作只清本地项（`table-12003`/`table-local`），session notice 按自身 TTL 存在，不得因本地项清空而复制出第二条。
- `notice-connection-matrix` 增加 `surface="table"`：reconnecting/dead 时 transport 被抑制，Stack 无连接文案，`ConnectionOverlay` 仍在。
- `connection-overlay` 不变（除文案已更新）。

- 单次呈现的结构性判据在 Task 4 的 `notice-single-presentation.test.ts`；本任务只负责 `[data-notice-id]` 迁移、`.table__notice` 清零与 12001 反转。
- `notice-presentation` 的 table 段：删除 `.table__notices` 规则断言，改为断言 `table.vue` 含 `<NoticeStack` 与 `#overlay`。

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm -C apps/client test -- table-play-ui action-feedback notice-connection-matrix connection-overlay`
Expected: PASS。

```bash
git add apps/client/src/pages/table/table.vue apps/client/test/table-play-ui.test.ts apps/client/test/action-feedback.test.ts apps/client/test/notice-connection-matrix.test.ts apps/client/test/connection-overlay.test.ts
git commit -m "feat(client): 牌桌提示单通道与连接死态去重

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: 退役旧组件、锚点清理、e2e 与全量验证

**Files:**
- Delete: `apps/client/src/components/SessionNotice.vue`
- Delete: `apps/client/src/components/ConnectionDeadBar.vue`
- Modify: `apps/client/test/ui-tokens.test.ts`
- Modify: `apps/client/test/notice-presentation.test.ts`
- Modify: `scripts/browser-e2e.mjs`
- Test: 全量 `apps/client/test`

- [ ] **Step 1: 删除旧组件**

```bash
git rm apps/client/src/components/SessionNotice.vue apps/client/src/components/ConnectionDeadBar.vue
```

- [ ] **Step 2: 重写 `notice-presentation.test.ts`**

改为断言：

```ts
const sources = collectSourceFiles();
function sourceOf(path: string): string {
  const file = sources.find((f) => f.path === path);
  expect(file, `${path} 必须在源码扫描集合里`).toBeDefined();
  return file!.content;
}
function ruleBody(source: string, selector: string): string | null {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(stripComments(source));
  return m ? m[1]! : null;
}

it('NoticeStack 与 overlay 槽绝对定位', () => {
  const stack = sourceOf('src/components/NoticeStack.vue');
  expect(ruleBody(stack, '.notice-stack')).toContain('position: absolute');
  const stage = sourceOf('src/components/LandscapeStage.vue');
  expect(ruleBody(stage, '.stage__overlay')).toContain('position: absolute');
  expect(ruleBody(stack, '.notice-stack')).toContain('pointer-events: none');
  expect(ruleBody(stack, '.notice')).toContain('pointer-events: auto');
});

it('六页都填了 overlay 槽', () => {
  for (const page of ['login','lobby','game','table','wallet','history']) {
    expect(sourceOf(`src/pages/${page}/${page}.vue`)).toContain('<NoticeStack');
    expect(sourceOf(`src/pages/${page}/${page}.vue`)).toContain('#overlay');
  }
});

it('旧锚点清零（剥注释）', () => {
  const forbidden = [
    '.login__error', '.login__field-error', '.lobby__levels-error', '.lobby__entry-error',
    '.lobby__notice', '.lobby__update-bar', '.game__error', '.game__notice', '.game__waitprompt',
    '.table__notice', '.table__notices', '.wallet__error', '.wallet__hint',
    '.wallet__withdraw-result', '.history__error', '.connection-dead-bar',
  ];
  for (const file of collectSourceFiles()) {
    const code = stripComments(file.content);
    for (const anchor of forbidden) {
      expect(code.includes(anchor), `${file.path} 残留 ${anchor}`).toBe(false);
    }
  }
});

it('救助 note 仅允许在弹层内', () => {
  const lobby = stripComments(sourceOf('src/pages/lobby/lobby.vue'));
  expect(lobby.match(/class="lobby__relief-note"/g)?.length ?? 0).toBe(1);
  // 该唯一渲染点位于 `.lobby__relief-panel` 的 v-if="reliefOpen" 子树内；
  // 挂载断言：弹层关闭时页面不存在 .lobby__relief-note。
});
```

> `collectSourceFiles()` 只扫 `src/**`；`test/**` 的旧类名由 Task 5–10 的迁移逐项清零，最终用 `rg` 复核时只允许出现在本闸的 `forbidden` 数组里。

- [ ] **Step 2b: 玩家面旧串清零**
  const JARGON = ['socket.io 已重连', '已按 M03', 'lastVersion=', '取回快照'];
  for (const path of ['src/net/socket.ts', 'src/net/session.ts']) {
    const code = stripComments(sourceOf(path));
    for (const jargon of JARGON) expect(code, `${path} 不得含 ${jargon}`).not.toContain(jargon);
  }
  const oldCopy = 'socket.io 已重连，已按 M03 用 lastVersion=3 取回快照（applied）';
  for (const jargon of JARGON) expect(oldCopy.includes(jargon)).toBe(true);
});
```

> 旧锚点扫描必须对**剥注释视图**做，否则 `table.vue`/`lobby.vue` 的解释性注释会误红；`test/**` 侧的旧类名只允许出现在迁移闸自身的 `forbidden` 数组里，由 G6 的“旧断言已迁移”清单人工/半自动核对。

- [ ] **Step 2b: 玩家面旧串清零**

创建 `apps/client/test/player-sink.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const BANNED_SNIPPETS = [
  '匹配失败（code=',
  '取消失败（code=',
  '加入房间失败（code=',
  '创建房间失败（code=',
  '操作未通过（code=',
  '[13004] refresh_snapshot',
  'resync_ack 快照 version',
  'reconnect_ack 快照 version',
  '同一 IP 的并发连接数',
  '§5.4 为 5',
  'lastVersion=',
  'socket.io 已重连',
  '已按 M03',
  '取回快照',
  '服务端登出未成功（code=',
];

describe('玩家面旧技术串清零', () => {
  it('src 代码（剥注释）不再包含任何旧串', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles()) {
      const code = stripComments(file.content);
      for (const snippet of BANNED_SNIPPETS) {
        if (code.includes(snippet)) offenders.push(`${file.path}: ${snippet}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('判别力：旧串样本必须命中', () => {
    const old = 'toast(`匹配失败（code=${outcome.code}）`); const s = "[13004] refresh_snapshot";';
    for (const snippet of ['匹配失败（code=', '[13004] refresh_snapshot']) {
      expect(old.includes(snippet)).toBe(true);
    }
  });
});
```

> 这里刻意只扫**逐字旧串**，不扫 `code=`/`back_to_lobby`/`lastVersion` 这类协议键或类型名（否则合法线格式与类型联合会被误判）；泛化禁词由 `player-copy.test` 对所有 `playerMessage` 输出做表驱动断言。`describeAction` 只允许出现在 reporter/日志调用，Task 2 已把 UI 通路替换为中性文案。

- 六页挂载判据不另建文件：在 Task 5–10 各自页面的既有挂载用例里加一条 `expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true)`（复用它自己的 pinia/fetch/session 夹具）。

- [ ] **Step 2d: 确认 `connection-dead.test.ts` 已完成迁移**

页面级死态用例已在 Task 8（大厅）/ Task 9（玩法）迁到 NoticeStack；Task 11 只确认该文件不再引用 `.connection-dead-bar`、仍保留：
- 换会话后旧死态项不残留（`stopGameSession()` 后 `currentSession.value = null`，无 `[data-notice-id="connection-dead"]`）；
- 换会话后旧**会话提示**不残留：`[data-notice-id="session-notice"] .notice__text` 不再含 11003 的 K1 文案；
- 11003 无重试按钮；give_up/10006/10008 有重试按钮。

- REST 会话失效原因由 Task 5/7/8/9 的 `auth.error` / 登录页 `.notice` 用例覆盖；登录尝试 10005 的零提示负对照在 Task 5；未知码中性文案 + reporter 在 Task 1。Task 11 只做最终全量复核，不重复造夹具。

- [ ] **Step 3: `ui-tokens` 必列改成 `NoticeStack.vue`**

把 `src/components/SessionNotice.vue` 从 required 列表删除，加入 `src/components/NoticeStack.vue`。`TABLE_AREA` 已在 Task 3 加 11 件。

- [ ] **Step 4: `browser-e2e.mjs` 更新 notice 断言**

把 `document.querySelector('.table__notice')` 改为：

```js
notice: document.querySelector('.notice__text')?.innerText ?? null,
```

在登录页就绪、填入字段**之前**插入真实提示断言：

```js
const clickedEmptySubmit = await cdp.eval(`(() => {
  const el = document.querySelector('.login__actions .btn--primary');
  if (!el) return false;
  el.click();
  return true;
})()`);
if (!clickedEmptySubmit) throw new Error('登录页主按钮不存在');
const noticeReady = await waitForSelector(cdp, '.notice__text', 5000);
if (!noticeReady) throw new Error('空表单提交后未出现浮动提示');
const noticeText = await cdp.eval(`document.querySelector('.notice__text')?.innerText ?? ''`);
if (!noticeText.includes('请输入')) throw new Error(`浮动提示文案异常: ${noticeText}`);
```

这条走的是真实浏览器 + 真实组件挂载，验证 `.stage__overlay .notice-stack` 在 H5 上确实可见且文案非空。

- [ ] **Step 5: 全量验证**

```bash
pnpm -C apps/client test
pnpm -C apps/client run lint
node scripts/browser-e2e.mjs
```

Expected: 全绿；H5 e2e 通过。

- [ ] **Step 6: H5 + App 走查**

逐页截图：登录校验、大厅档位失败/空表/版本条、玩法匹配失败/缺人等待、牌桌动作拒绝/12003/12001、钱包下单失败/提现结果、历史加载失败、连接 reconnecting/dead/session_expired。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore(client): 退役旧提示组件并完成提示锚点迁移

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自查清单（写计划后执行）

- [ ] spec §1 的 P1–P9 每一项都能在 Task 1–11 找到落点。
- [ ] spec §4.5 的每个 FIXED/MESSAGE_FIRST/IGNORE 码都有文案或明确忽略。
- [ ] spec §4.8 的每个测试文件都有迁移/反转/保留说明。
- [ ] 没有 `TBD`/`TODO`/“类似 Task N”/未定义接口。
- [ ] `NoticeItem`、`NoticeAction`、`NoticeSurface`、`PageNotices` 的命名在各任务一致。
- [ ] 每个任务都以“写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交”结束。

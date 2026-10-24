import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CURRENCY_OWNER_TYPES,
  CURRENCY_SOURCES,
  MAX_ABS_DELTA_BY_SOURCE,
  currencyApplyHash,
  normalizeOwnerType,
  validateCurrencyApply,
  validateCurrencyCardCounterConsume,
  validateCurrencyEntryFeeSkip,
  validateCurrencyGet,
  type CurrencyWithdrawableGetRequest,
  type CurrencyWithdrawableGetResponse,
} from './currency';
import { ProtocolError } from './validate';

/**
 * 货币核心 T2：`currency.ts`（规格 §2.2 导出面逐字 + §2.3 ⚙️2 的 request_hash 规范化）单测。
 *
 * - 参考实现 = `node:crypto`，**只在测试侧**（本包源码不得静态引入 node 内建——理由见
 *   `currency.ts` 头注：`export *` 会让客户端求值本模块，Vite 把 node 内建重写成抛错模块）。
 * - 期望的规范化 JSON 在测试里**独立构造**（键序逐字写出）：两边只要有一个人改了键序/省略规则即红。
 */

const HEX64 = /^[0-9a-f]{64}$/;

/** ⚙️2 的规范化（测试侧独立构造）：键序 `source / entries / actor / reason / refId` 固定。 */
function canonical(input: {
  source: string;
  entries: Array<{ ownerId: string; ownerType?: string; delta: number }>;
  actor?: string;
  reason?: string;
  refId?: string;
}): string {
  return JSON.stringify({
    source: input.source,
    entries: [...input.entries]
      .sort((a, b) => (a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0))
      .map((e) => ({ ownerId: e.ownerId, ownerType: e.ownerType ?? 'user', delta: e.delta })),
    actor: input.actor ?? null,
    reason: input.reason ?? null,
    refId: input.refId ?? null,
  });
}

function nodeSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('currency 契约面导出（规格 §2.2 逐字）', () => {
  it('allowlist 逐字：CURRENCY_SOURCES / CURRENCY_OWNER_TYPES', () => {
    expect(CURRENCY_SOURCES).toEqual([
      'signup_grant',
      'admin_adjust',
      'game_settle',
      'robot_pool',
      'relief_grant',
      'admin_reverse',
      // 支付片 T1（§2.1）：+5 源，**追加在尾**（顺序 = 追加序；allowlist 判据按集合）
      'recharge',
      'refund_hold',
      'refund_rollback',
      'withdraw_hold',
      'withdraw_rollback',
      // 台费片（尾追第 12 源）
      'entry_fee',
      // 记牌器收费片（尾追第 13 源）
      'card_counter',
    ]);
    expect(CURRENCY_SOURCES.length).toBe(13);
    expect(CURRENCY_OWNER_TYPES).toEqual(['user', 'robot']);
  });
});

describe('normalizeOwnerType（§2.3：缺省归一 user；其余非法 ⇒ 抛）', () => {
  it("undefined（缺省）⇒ 'user'；显式 'user' / 'robot' 原样返回", () => {
    expect(normalizeOwnerType(undefined)).toBe('user');
    expect(normalizeOwnerType('user')).toBe('user');
    expect(normalizeOwnerType('robot')).toBe('robot');
  });

  it('非法值（null / 空串 / 陌生串 / 数字 / 布尔 / 对象）⇒ ProtocolError 中文原因', () => {
    for (const bad of [null, '', 'admin', 'USER', 0, 1, true, {}, []]) {
      expect(() => normalizeOwnerType(bad), `normalizeOwnerType(${JSON.stringify(bad)})`).toThrow(
        ProtocolError,
      );
      expect(() => normalizeOwnerType(bad)).toThrow(/[一-鿿]/);
    }
  });
});

describe('currencyApplyHash（§2.3 ⚙️2：逐字节）', () => {
  it('输出形态：小写 hex、定长 64', () => {
    const h = currencyApplyHash({
      source: 'signup_grant',
      entries: [{ ownerId: 'u-1', delta: 100 }],
    });
    expect(h).toMatch(HEX64);
  });

  it('逐字节 = node:crypto(JSON.stringify(规范化对象))：键序 source/entries/actor/reason/refId、条目 {ownerId,ownerType,delta}', () => {
    const h = currencyApplyHash({
      source: 'signup_grant',
      entries: [{ ownerId: 'u-1', delta: 100 }],
      refId: 'u-1',
    });
    // 独立构造的规范化串（缺省 actor/reason ⇒ null；ownerType 缺省 ⇒ 归一 'user' 且不省略）
    expect(h).toBe(
      nodeSha256(
        '{"source":"signup_grant","entries":[{"ownerId":"u-1","ownerType":"user","delta":100}],"actor":null,"reason":null,"refId":"u-1"}',
      ),
    );
    // 与测试侧 canonical() 助手互为镜像（同一事实的两处独立构造）
    expect(h).toBe(
      nodeSha256(canonical({ source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 100 }], refId: 'u-1' })),
    );
  });

  it('带 burn（本片）：canonical 末位追加 `burn:{residue,rake}`（子对象键序 residue→rake）；缺席 ≡ 显式 undefined', () => {
    const base = {
      source: 'game_settle',
      entries: [
        { ownerId: 'u-1', delta: -25 },
        { ownerId: 'u-2', delta: 12 },
        { ownerId: 'u-3', delta: 12 },
      ],
    };
    // 独立构造（键序逐字写出；burn 在 refId 之后、子对象 residue 在前）
    expect(currencyApplyHash({ ...base, burn: { residue: 1, rake: 0 } })).toBe(
      nodeSha256(
        '{"source":"game_settle","entries":[{"ownerId":"u-1","ownerType":"user","delta":-25},{"ownerId":"u-2","ownerType":"user","delta":12},{"ownerId":"u-3","ownerType":"user","delta":12}],"actor":null,"reason":null,"refId":null,"burn":{"residue":1,"rake":0}}',
      ),
    );
    // 缺席的 canonical 串 = 加片前形态（逐字节），显式 undefined 同哈希
    expect(currencyApplyHash(base)).toBe(
      nodeSha256(
        '{"source":"game_settle","entries":[{"ownerId":"u-1","ownerType":"user","delta":-25},{"ownerId":"u-2","ownerType":"user","delta":12},{"ownerId":"u-3","ownerType":"user","delta":12}],"actor":null,"reason":null,"refId":null}',
      ),
    );
    expect(currencyApplyHash({ ...base, burn: undefined })).toBe(currencyApplyHash(base));
  });

  it('排序不变性：乱序 entries ⇒ 同 hash；且不改写调用方数组（纯函数）', () => {
    const entries = [
      { ownerId: 'b-2', delta: 5 },
      { ownerId: 'a-1', delta: -3 },
      { ownerId: 'c-3', delta: 7 },
    ];
    const sorted = [{ ownerId: 'a-1', delta: -3 }, { ownerId: 'b-2', delta: 5 }, { ownerId: 'c-3', delta: 7 }];

    const h = currencyApplyHash({ source: 'admin_adjust', entries, actor: 'admin', reason: 'x' });

    expect(h).toBe(currencyApplyHash({ source: 'admin_adjust', entries: sorted, actor: 'admin', reason: 'x' }));
    expect(h).toBe(nodeSha256(canonical({ source: 'admin_adjust', entries, actor: 'admin', reason: 'x' })));
    expect(entries.map((e) => e.ownerId)).toEqual(['b-2', 'a-1', 'c-3']); // 入参未被排序就地改写
  });

  it("ownerType 缺省与显式 'user' 同 hash；显式 'robot' 则不同（参与指纹）", () => {
    const base = { source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 1 }] };

    const omitted = currencyApplyHash({ ...base, entries: [{ ownerId: 'u-1', delta: 1 }] });
    const explicitUser = currencyApplyHash({ ...base, entries: [{ ownerId: 'u-1', delta: 1, ownerType: 'user' }] });
    const explicitRobot = currencyApplyHash({ ...base, entries: [{ ownerId: 'u-1', delta: 1, ownerType: 'robot' }] });

    expect(omitted).toBe(explicitUser);
    expect(explicitRobot).not.toBe(omitted);
  });

  it('actionId 不入指纹：同载荷不同 actionId ⇒ 同 hash（本函数根本不吃 actionId）', () => {
    const payload = { source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 1 }], refId: 'u-1' };
    const withA = { ...payload, actionId: 'signup:u-1' };
    const withB = { ...payload, actionId: 'admin:完全不同的-id' };

    expect(currencyApplyHash(withA)).toBe(currencyApplyHash(withB));
    expect(currencyApplyHash(withA)).toBe(currencyApplyHash(payload));
  });

  it('delta 变则 hash 变（+100 vs +99 vs -100）', () => {
    const h = (delta: number) => currencyApplyHash({ source: 'signup_grant', entries: [{ ownerId: 'u-1', delta }] });
    expect(new Set([h(100), h(99), h(-100)]).size).toBe(3);
  });

  it('source/actor/reason/refId 皆入指纹：各改一处 hash 皆变（缺省与显式 null 等价）', () => {
    const base = { source: 'admin_adjust', entries: [{ ownerId: 'u-1', delta: 1 }], actor: 'admin', reason: 'r' };
    const h = (patch: Record<string, unknown>) => currencyApplyHash({ ...base, ...patch });

    expect(h({})).not.toBe(h({ source: 'signup_grant' }));
    expect(h({})).not.toBe(h({ actor: 'admin2' }));
    expect(h({})).not.toBe(h({ reason: 'r2' }));
    expect(h({})).not.toBe(h({ refId: 'x' }));
    expect(currencyApplyHash({ source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 1 }] }))
      .toBe(currencyApplyHash({ source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 1 }], actor: undefined, reason: undefined, refId: undefined }));
  });

  it('sha256 交叉验证：reason 长度扫 0..140（覆盖 55/56/63/64/65/119/120 等填充边界；含 3 字节汉字路径）⇒ 与 node:crypto 全等', () => {
    for (let len = 0; len <= 140; len++) {
      const input = {
        source: 'admin_adjust' as const,
        entries: [{ ownerId: 'u-1', delta: -1 }],
        actor: 'admin',
        reason: '干'.repeat(len % 7) + 'x'.repeat(len),
      };
      expect(currencyApplyHash(input), `reason len=${len}`).toBe(nodeSha256(canonical(input)));
    }
  });

  it('sha256 交叉验证：4 字节字符（代理对）与孤立代理 ⇒ 与 node:crypto 全等', () => {
    for (const reason of ['😀😀', 'a\ud800b', '\udfff', '中😀\ud800x']) {
      const input = { source: 'admin_adjust' as const, entries: [{ ownerId: 'u-1', delta: 1 }], reason };
      expect(currencyApplyHash(input), `reason=${JSON.stringify(reason)}`).toBe(nodeSha256(canonical(input)));
    }
  });
});

describe('validateCurrencyApply（§2.3 字段表 + §5.4：唯一校验点，抛 ProtocolError 中文原因）', () => {
  it('合法请求（signup_grant 最小形态 + meta）⇒ 不抛', () => {
    expect(() =>
      validateCurrencyApply({
        actionId: 'signup:u-1',
        source: 'signup_grant',
        entries: [{ ownerId: 'u-1', delta: 100 }],
        refId: 'u-1',
        meta: { traceId: 't-1' },
      }),
    ).not.toThrow();
  });

  it('合法请求（admin_adjust 全形态 + 边界值）⇒ 不抛：delta ±1,000,000、20 条、ownerId 36 字符、actionId 128、actor 64、reason 255、refId 128', () => {
    const ownerIds = Array.from({ length: 20 }, (_, i) => `u-${i}`.padEnd(36, '_'));
    expect(() =>
      validateCurrencyApply({
        actionId: 'a'.repeat(128),
        source: 'admin_adjust',
        entries: [
          { ownerId: ownerIds[0], delta: 1_000_000 },
          { ownerId: ownerIds[1], delta: -1_000_000, ownerType: 'robot' },
          ...ownerIds.slice(2).map((ownerId) => ({ ownerId, delta: 1 })),
        ],
        actor: 'a'.repeat(64),
        reason: 'r'.repeat(255),
        refId: 'x'.repeat(128),
      }),
    ).not.toThrow();
  });

  it('校验矩阵：每条非法输入 ⇒ ProtocolError，且 message 是中文原因（与 parseConfigValue 同口径）', () => {
    const ok = { actionId: 'a-1', source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 1 }] };
    const cases: Array<[string, unknown]> = [
      ['请求非对象', null],
      ['请求非对象（数组）', []],
      ['actionId 缺失', { ...ok, actionId: undefined }],
      ['actionId 空串', { ...ok, actionId: '' }],
      ['actionId 超 128', { ...ok, actionId: 'a'.repeat(129) }],
      ['actionId 非字符串', { ...ok, actionId: 123 }],
      ['source 不在 allowlist', { ...ok, source: 'pay' }],
      ['source 非字符串', { ...ok, source: 1 }],
      ['entries 非数组', { ...ok, entries: 'u-1' }],
      ['entries 0 条', { ...ok, entries: [] }],
      ['entries 21 条', { ...ok, entries: Array.from({ length: 21 }, (_, i) => ({ ownerId: `u-${i}`, delta: 1 })) }],
      ['entry 非对象', { ...ok, entries: ['u-1'] }],
      ['ownerId 缺失', { ...ok, entries: [{ delta: 1 }] }],
      ['ownerId 空串', { ...ok, entries: [{ ownerId: '', delta: 1 }] }],
      ['ownerId 超 36 字符', { ...ok, entries: [{ ownerId: 'a'.repeat(37), delta: 1 }] }],
      ['ownerId 非法字符（空格）', { ...ok, entries: [{ ownerId: 'a b', delta: 1 }] }],
      ['ownerId 非法字符（汉字）', { ...ok, entries: [{ ownerId: '用户一', delta: 1 }] }],
      ['ownerId 重复', { ...ok, entries: [{ ownerId: 'u-1', delta: 1 }, { ownerId: 'u-1', delta: 2 }] }],
      ['delta = 0', { ...ok, entries: [{ ownerId: 'u-1', delta: 0 }] }],
      ['delta 非整数', { ...ok, entries: [{ ownerId: 'u-1', delta: 1.5 }] }],
      ['delta 非数字', { ...ok, entries: [{ ownerId: 'u-1', delta: '5' }] }],
      ['delta > 1,000,000', { ...ok, entries: [{ ownerId: 'u-1', delta: 1_000_001 }] }],
      ['delta < -1,000,000', { ...ok, entries: [{ ownerId: 'u-1', delta: -1_000_001 }] }],
      ['ownerType 非法', { ...ok, entries: [{ ownerId: 'u-1', delta: 1, ownerType: 'admin' }] }],
      ['admin_adjust 缺 actor', { ...ok, source: 'admin_adjust', reason: 'r' }],
      ['admin_adjust actor 空串', { ...ok, source: 'admin_adjust', actor: '', reason: 'r' }],
      ['admin_adjust 缺 reason', { ...ok, source: 'admin_adjust', actor: 'admin' }],
      ['admin_adjust reason 空串', { ...ok, source: 'admin_adjust', actor: 'admin', reason: '' }],
      ['actor 超 64', { ...ok, actor: 'a'.repeat(65) }],
      ['reason 超 255', { ...ok, source: 'admin_adjust', actor: 'admin', reason: 'r'.repeat(256) }],
      ['refId 超 128', { ...ok, refId: 'x'.repeat(129) }],
    ];

    for (const [name, req] of cases) {
      expect(() => validateCurrencyApply(req), name).toThrow(ProtocolError);
      expect(() => validateCurrencyApply(req), name).toThrow(/[一-鿿]/);
    }
  });

  it('burn 正例：三座截断示例 (−25+12+12)+1+0=0 ⇒ 不抛；{0,0} 与 2^31−1 边界不抛', () => {
    const entries = [
      { ownerId: 'u-1', delta: -25 },
      { ownerId: 'u-2', delta: 12 },
      { ownerId: 'u-3', delta: 12 },
    ];
    expect(() =>
      validateCurrencyApply({ actionId: 'a-1', source: 'game_settle', entries, burn: { residue: 1, rake: 0 } }),
    ).not.toThrow();
    // ⚠️ 偏差登记（task-1-report.md）：计划稿此例两条目 [-2147483647, +2147483646]（Σ=-1）与 residue=2^31−1
    // 在 V3 下不自洽（Σ+residue+rake = 2147483646 ≠ 0 ⇒ 必抛）；按 V3 修正为单条目 Σ=-2147483647，保留 residue 正例边界。
    expect(() =>
      validateCurrencyApply({
        actionId: 'a-2',
        source: 'game_settle',
        entries: [{ ownerId: 'u-1', delta: -2147483647 }],
        burn: { residue: 2147483647, rake: 0 },
      }),
    ).not.toThrow();
    expect(() =>
      validateCurrencyApply({
        actionId: 'a-3',
        source: 'game_settle',
        entries: [{ ownerId: 'u-1', delta: 7 }, { ownerId: 'u-2', delta: -7 }],
        burn: { residue: 0, rake: 0 },
      }),
    ).not.toThrow();
  });

  it('burn 反例：形状 → 范围 → 来源 → 不变量（次序即契约，前者先报）', () => {
    const ok = {
      actionId: 'a-1',
      source: 'game_settle',
      entries: [
        { ownerId: 'u-1', delta: -25 },
        { ownerId: 'u-2', delta: 12 },
        { ownerId: 'u-3', delta: 12 },
      ],
    };
    const cases: Array<[string, unknown, RegExp]> = [
      ['burn=null', { ...ok, burn: null }, /burn 必须是含 residue 与 rake 两个字段的对象/],
      ['burn 非对象', { ...ok, burn: 1 }, /burn 必须是含 residue 与 rake 两个字段的对象/],
      ['burn 缺 rake', { ...ok, burn: { residue: 1 } }, /burn 必须是含 residue 与 rake 两个字段的对象/],
      ['residue 负数', { ...ok, burn: { residue: -1, rake: 0 } }, /burn\.residue 必须是 0 ≤ n ≤ 2147483647 的整数/],
      ['residue 超界', { ...ok, burn: { residue: 2147483648, rake: 0 } }, /burn\.residue 必须是 0 ≤ n ≤ 2147483647 的整数/],
      ['residue 非整数', { ...ok, burn: { residue: 1.5, rake: 0 } }, /burn\.residue 必须是 0 ≤ n ≤ 2147483647 的整数/],
      ['residue 字符串', { ...ok, burn: { residue: '1', rake: 0 } }, /burn\.residue 必须是 0 ≤ n ≤ 2147483647 的整数/],
      ['rake NaN', { ...ok, burn: { residue: 1, rake: Number.NaN } }, /burn\.rake 必须是 0 ≤ n ≤ 2147483647 的整数/],
      [
        '范围先于来源（次序钉死；v1.2 授权补例）',
        { actionId: 'a-1', source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 3 }], burn: { residue: -3, rake: 0 } },
        /burn\.residue 必须是 0 ≤ n ≤ 2147483647 的整数/,
      ],
      [
        '来源非 game_settle',
        { actionId: 'a-1', source: 'signup_grant', entries: [{ ownerId: 'u-1', delta: 3 }], burn: { residue: 3, rake: 0 } },
        /burn 仅 game_settle 来源可携带/,
      ],
      ['不变量不符', { ...ok, burn: { residue: 2, rake: 0 } }, /Σentries\(-1\) \+ residue\(2\) \+ rake\(0\) 必须为 0/],
    ];
    for (const [name, req, message] of cases) {
      expect(() => validateCurrencyApply(req), name).toThrow(ProtocolError);
      expect(() => validateCurrencyApply(req), name).toThrow(message);
    }
  });
});

describe('admin_reverse（③ T1 协议扩容：与 admin_adjust **内核同规**，规格 §2.8/S6）', () => {
  it('合法全形态：actor ≤64 / reason ≤255 / refId ≤128 + 反向 delta ⇒ 不抛', () => {
    expect(() =>
      validateCurrencyApply({
        actionId: 'admin:reverse:7',
        source: 'admin_reverse',
        entries: [{ ownerId: 'u-1', delta: -100 }],
        actor: 'a'.repeat(64),
        reason: 'r'.repeat(255),
        refId: 'admin:adjust:5', // 原 action_id（双向关联）
      }),
    ).not.toThrow();
  });

  it('缺 actor / actor 空串 / 缺 reason / reason 空串 ⇒ 抛 ProtocolError 中文原因（与 admin_adjust 同规的四条）', () => {
    const ok = {
      actionId: 'admin:reverse:7',
      source: 'admin_reverse',
      entries: [{ ownerId: 'u-1', delta: -1 }],
      actor: 'admin',
      reason: 'r',
    };
    for (const bad of [
      { ...ok, actor: undefined },
      { ...ok, actor: '' },
      { ...ok, reason: undefined },
      { ...ok, reason: '' },
    ]) {
      expect(() => validateCurrencyApply(bad), JSON.stringify(bad)).toThrow(ProtocolError);
      expect(() => validateCurrencyApply(bad), JSON.stringify(bad)).toThrow(/[一-鿿]/);
    }
  });

  it('S6：内核**不设** ≤200 预闸（那是端点 body 的事）—— reason 201 / 255 过、256 拒', () => {
    const req = (reason: string) => ({
      actionId: 'a-1',
      source: 'admin_reverse',
      entries: [{ ownerId: 'u-1', delta: -1 }],
      actor: 'admin',
      reason,
    });
    expect(() => validateCurrencyApply(req('r'.repeat(201)))).not.toThrow();
    expect(() => validateCurrencyApply(req('r'.repeat(255)))).not.toThrow();
    expect(() => validateCurrencyApply(req('r'.repeat(256)))).toThrow(ProtocolError);
    // 对称核验：admin_adjust 在 201 处同样过（两源核对称，防只给 reverse 加闸）
    expect(() =>
      validateCurrencyApply({ ...req('r'.repeat(201)), source: 'admin_adjust' }),
    ).not.toThrow();
  });

  it('delta 走缺省上限 1e6（不抬）：±1,000,000 过、±1,000,001 拒（消息里显示 1000000）', () => {
    const req = (delta: number) => ({
      actionId: 'a-1',
      source: 'admin_reverse',
      entries: [{ ownerId: 'u-1', delta }],
      actor: 'admin',
      reason: 'r',
    });
    expect(() => validateCurrencyApply(req(1_000_000))).not.toThrow();
    expect(() => validateCurrencyApply(req(-1_000_000))).not.toThrow();
    expect(() => validateCurrencyApply(req(1_000_001))).toThrow(/1000000/);
    expect(() => validateCurrencyApply(req(-1_000_001))).toThrow(/1000000/);
  });

  it('MAX_ABS_DELTA_BY_SOURCE 不扩：admin_reverse 无 source 化上限（与既有「仅 game_settle/robot_pool」断言互锁）', () => {
    expect(MAX_ABS_DELTA_BY_SOURCE.admin_reverse).toBeUndefined();
  });

  it('错误文案点名真实 source（防复制粘贴抄错）：两源的 actor/reason 缺失消息各自含自己的 source 名', () => {
    const errOf = (source: 'admin_adjust' | 'admin_reverse', drop: 'actor' | 'reason'): string => {
      const req: Record<string, unknown> = {
        actionId: 'a-1',
        source,
        entries: [{ ownerId: 'u-1', delta: 1 }],
        actor: 'admin',
        reason: 'r',
      };
      delete req[drop];
      try {
        validateCurrencyApply(req);
        return '(未抛)';
      } catch (e) {
        return (e as Error).message;
      }
    };
    for (const source of ['admin_adjust', 'admin_reverse'] as const) {
      expect(errOf(source, 'actor'), source).toContain(`source=${source}`);
      expect(errOf(source, 'reason'), source).toContain(`source=${source}`);
    }
  });
});

describe('source 化上限（② 金币场 §8 / C23）：cap = MAX_ABS_DELTA_BY_SOURCE[source] ?? 1e6', () => {
  it('MAX_ABS_DELTA_BY_SOURCE 逐字：仅 game_settle / robot_pool 抬到 2^31−1（int 列容量哨兵）', () => {
    expect(MAX_ABS_DELTA_BY_SOURCE).toEqual({ game_settle: 2_147_483_647, robot_pool: 2_147_483_647 });
  });

  it('三个新 source 可过（relief_grant 走缺省 1e6）', () => {
    for (const source of ['game_settle', 'robot_pool', 'relief_grant'] as const) {
      expect(
        () => validateCurrencyApply({ actionId: 'a-1', source, entries: [{ ownerId: 'u-1', delta: 1 }] }),
        source,
      ).not.toThrow();
    }
  });

  it('game_settle / robot_pool：2^31−1 可过；> 2^31−1 拒（消息里显示 cap）', () => {
    for (const source of ['game_settle', 'robot_pool'] as const) {
      expect(
        () =>
          validateCurrencyApply({
            actionId: 'a-1',
            source,
            entries: [{ ownerId: 'u-1', delta: 2_147_483_647 }],
          }),
        source,
      ).not.toThrow();
      // 越界在**校验层**即终态（10001），不落库（哨兵语义：抓算法 bug，不是经济参数）
      expect(
        () =>
          validateCurrencyApply({
            actionId: 'a-1',
            source,
            entries: [{ ownerId: 'u-1', delta: 2_147_483_648 }],
          }),
        source,
      ).toThrow(/2147483647/);
    }
  });

  it('admin_adjust 仍 1e6 上限：1,000,000 可过、1,000,001 拒（消息里显示 1000000）', () => {
    const req = (delta: number) => ({
      actionId: 'a-1',
      source: 'admin_adjust',
      entries: [{ ownerId: 'u-1', delta }],
      actor: 'admin',
      reason: 'r',
    });
    expect(() => validateCurrencyApply(req(1_000_000))).not.toThrow();
    expect(() => validateCurrencyApply(req(1_000_001))).toThrow(/1000000/);
  });

  it('缺省 source（signup_grant / relief_grant）仍是 1e6 上限：1,000,001 拒', () => {
    for (const source of ['signup_grant', 'relief_grant'] as const) {
      expect(
        () =>
          validateCurrencyApply({
            actionId: 'a-1',
            source,
            entries: [{ ownerId: 'u-1', delta: 1_000_001 }],
          }),
        source,
      ).toThrow(/1000000/);
    }
  });
});

describe('支付五源（§2.1：recharge/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback）', () => {
  it('逐个可过 allowlist（锚形如 refund_rb:…/withdraw_rb:… 由调用方保证，内核只认 source 集合）', () => {
    for (const source of ['recharge', 'refund_hold', 'refund_rollback', 'withdraw_hold', 'withdraw_rollback'] as const) {
      expect(
        () => validateCurrencyApply({ actionId: 'a-1', source, entries: [{ ownerId: 'u-1', delta: 1 }] }),
        source,
      ).not.toThrow();
      // 出账方向（withdraw_hold 实际为负）同规
      expect(
        () => validateCurrencyApply({ actionId: 'a-2', source, entries: [{ ownerId: 'u-1', delta: -1 }] }),
        source,
      ).not.toThrow();
    }
  });

  it('不设专属上限：走缺省 1e6（100,000=1,000 元/日模拟量可过；1,000,001 拒——消息显示 1000000）', () => {
    for (const source of ['recharge', 'refund_hold', 'refund_rollback', 'withdraw_hold', 'withdraw_rollback'] as const) {
      expect(
        () =>
          validateCurrencyApply({
            actionId: 'a-1',
            source,
            entries: [{ ownerId: 'u-1', delta: 100_000 }],
          }),
        source,
      ).not.toThrow();
      expect(
        () =>
          validateCurrencyApply({
            actionId: 'a-2',
            source,
            entries: [{ ownerId: 'u-1', delta: 1_000_001 }],
          }),
        source,
      ).toThrow(/1000000/);
    }
    // MAX_ABS_DELTA_BY_SOURCE 逐字断言在上一 describe（toEqual 恰 {game_settle, robot_pool}）——
    // 五新源**不入表**即「不设专属上限」的机械表达。
  });
});

describe('currency.withdrawable.get 契约（§2.2：**仅类型**两 DTO；运行期键归 rpc.ts，T4 同提交加）', () => {
  it('请求 {ownerId} / 响应 {cap,balance} 形状逐字（编译期由 tsc 兜底，这里钉键集）', () => {
    const req: CurrencyWithdrawableGetRequest = { ownerId: 'u-1' };
    const res: CurrencyWithdrawableGetResponse = { cap: 300, balance: 500 };

    expect(Object.keys(req).sort()).toEqual(['ownerId']);
    expect(Object.keys(res).sort()).toEqual(['balance', 'cap']);
    expect(res.cap).toBeLessThanOrEqual(res.balance); // cap ≤ balance 不变式例示（clamp 语义见 §2.2.1）
  });
});

describe('validateCurrencyGet（§2.4：1..50 条、允许重复、逐条 ownerId 约束）', () => {
  it('边界：1 条与 50 条 ⇒ 通过；0 条与 51 条 ⇒ 抛中文原因', () => {
    expect(() => validateCurrencyGet({ ownerIds: ['u-1'] })).not.toThrow();
    expect(() =>
      validateCurrencyGet({ ownerIds: Array.from({ length: 50 }, (_, i) => `u-${i}`) }),
    ).not.toThrow();

    expect(() => validateCurrencyGet({ ownerIds: [] })).toThrow(ProtocolError);
    expect(() => validateCurrencyGet({ ownerIds: Array.from({ length: 51 }, (_, i) => `u-${i}`) })).toThrow(/[一-鿿]/);
  });

  it('允许重复（与 §2.4「响应与请求同序一一对应」配套）；meta 不参与校验', () => {
    expect(() => validateCurrencyGet({ ownerIds: ['u-1', 'u-1', 'u-1'], meta: { traceId: 't' } })).not.toThrow();
  });

  it('逐条 ownerId 约束（同 §2.3）：非字符串 / 空串 / 超长 / 非法字符 ⇒ 抛中文原因', () => {
    for (const bad of [[1], [''], ['a'.repeat(37)], ['a b'], ['用户']] as unknown[][]) {
      expect(() => validateCurrencyGet({ ownerIds: bad }), JSON.stringify(bad)).toThrow(ProtocolError);
      expect(() => validateCurrencyGet({ ownerIds: bad })).toThrow(/[一-鿿]/);
    }
    expect(() => validateCurrencyGet({ ownerIds: 'u-1' })).toThrow(/[一-鿿]/);
    expect(() => validateCurrencyGet(null)).toThrow(ProtocolError);
  });
});

describe('currency.entryFeeSkip 校验（本片 C19：字段表正反例 + 证据文案）', () => {
  const ok = {
    roomCode: 'ABC123',
    ownerId: 'u-1',
    seat: 0,
    baseScore: 15,
    feeAmount: 1,
    reason: 'insufficient_funds' as const,
  };

  it('正例：全字段合法；seat 缺席也合法（可选 0..2）；三值 reason 全放行', () => {
    expect(() => validateCurrencyEntryFeeSkip(ok)).not.toThrow();
    const { seat: _seat, ...withoutSeat } = ok;
    expect(() => validateCurrencyEntryFeeSkip(withoutSeat)).not.toThrow();
    expect(() => validateCurrencyEntryFeeSkip({ ...ok, baseScore: 8191 })).not.toThrow();
    for (const reason of ['insufficient_funds', 'unknown_outcome', 'internal_error'] as const) {
      expect(() => validateCurrencyEntryFeeSkip({ ...ok, reason }), reason).not.toThrow();
    }
  });

  it('反例：逐字段命中中文文案（对象 → roomCode → ownerId → seat → baseScore → feeAmount → reason 枚举）', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['非对象', null, /currency\.entryFeeSkip 请求必须是对象/],
      ['roomCode 空串', { ...ok, roomCode: '' }, /roomCode 必须是 1\.\.16 字符的非空字符串/],
      ['roomCode 超列宽', { ...ok, roomCode: 'X'.repeat(17) }, /roomCode 必须是 1\.\.16 字符的非空字符串/],
      ['ownerId 含空格', { ...ok, ownerId: 'a b' }, /ownerId 必须是 1\.\.36 字符的 \[A-Za-z0-9_-\] 字符串/],
      ['ownerId 超 36', { ...ok, ownerId: 'o'.repeat(37) }, /ownerId 必须是 1\.\.36 字符的 \[A-Za-z0-9_-\] 字符串/],
      ['seat 越界', { ...ok, seat: 3 }, /seat 必须是 0\.\.2 的整数/],
      ['seat 非整数', { ...ok, seat: 1.5 }, /seat 必须是 0\.\.2 的整数/],
      ['baseScore 非正', { ...ok, baseScore: 0 }, /baseScore 必须是正整数且 ≤ 8191/],
      ['baseScore 超界', { ...ok, baseScore: 8192 }, /baseScore 必须是正整数且 ≤ 8191/],
      ['seat 负', { ...ok, seat: -1 }, /seat 必须是 0\.\.2 的整数/],
      ['reason 缺席', { ...ok, reason: undefined }, /reason 必须是 insufficient_funds \/ unknown_outcome \/ internal_error 之一/],
      ['feeAmount 为 0', { ...ok, feeAmount: 0 }, /feeAmount 必须是正整数且 ≤ 1000000/],
      ['feeAmount 超上限', { ...ok, feeAmount: 1_000_001 }, /feeAmount 必须是正整数且 ≤ 1000000/],
      ['reason 枚举外（action_conflict 不在域）', { ...ok, reason: 'action_conflict' }, /reason 必须是 insufficient_funds \/ unknown_outcome \/ internal_error 之一/],
      ['reason 非字符串', { ...ok, reason: 1 }, /reason 必须是 insufficient_funds \/ unknown_outcome \/ internal_error 之一/],
    ];
    for (const [name, req, message] of cases) {
      expect(() => validateCurrencyEntryFeeSkip(req), name).toThrow(ProtocolError);
      expect(() => validateCurrencyEntryFeeSkip(req), name).toThrow(message);
    }
  });
});

describe('validateCurrencyCardCounterConsume（记牌器收费片）', () => {
  const ok = { roomCode: 'ABC123', ownerId: 'user-1' };

  it('合法：roomCode 1..16 / ownerId 1..36 / seat 0..2 / meta 可选', () => {
    expect(() => validateCurrencyCardCounterConsume(ok)).not.toThrow();
    expect(() => validateCurrencyCardCounterConsume({ ...ok, seat: 0 })).not.toThrow();
    expect(() => validateCurrencyCardCounterConsume({ ...ok, seat: 2 })).not.toThrow();
    expect(() => validateCurrencyCardCounterConsume({ ...ok, meta: { traceId: 't1' } })).not.toThrow();
  });

  it('非法：非对象 / roomCode / ownerId / seat 各反例', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['非对象', null, /请求必须是对象/],
      ['roomCode 空', { ...ok, roomCode: '' }, /roomCode 必须是 1\.\.16 字符的非空字符串/],
      ['roomCode 非字符串', { ...ok, roomCode: 1 }, /roomCode 必须是 1\.\.16 字符的非空字符串/],
      ['roomCode 超列宽', { ...ok, roomCode: 'X'.repeat(17) }, /roomCode 必须是 1\.\.16 字符的非空字符串/],
      ['ownerId 含空格', { ...ok, ownerId: 'a b' }, /ownerId 必须是 1\.\.36 字符的 \[A-Za-z0-9_-\] 字符串/],
      ['ownerId 超 36', { ...ok, ownerId: 'o'.repeat(37) }, /ownerId 必须是 1\.\.36 字符的 \[A-Za-z0-9_-\] 字符串/],
      ['seat 越界', { ...ok, seat: 3 }, /seat 必须是 0\.\.2 的整数/],
      ['seat 非整数', { ...ok, seat: 1.5 }, /seat 必须是 0\.\.2 的整数/],
    ];
    for (const [name, req, message] of cases) {
      expect(() => validateCurrencyCardCounterConsume(req), name).toThrow(ProtocolError);
      expect(() => validateCurrencyCardCounterConsume(req), name).toThrow(message);
    }
  });
});

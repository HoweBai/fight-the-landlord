import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ClaimService, ClaimTransientError } from '../ads/claim.service';
import { GetService } from '../apply/get.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { TRANSPORT_FAILURE_MESSAGE } from '../config/config.client';
import { httpException } from '../http/errors';
import { shanghaiDateOf } from '../util/shanghai-date';

/**
 * 玩家 REST（T5 + 广告片 T15；规格 §2.5 / §6.1 http.controller 行）：
 * `GET /api/wallet/balance` + `GET /api/wallet/relief[?claim=]`。
 *
 * ─── balance 契约（§2.5 逐字）────────────────────────────────────────────
 *  - 入参**只**取 `X-User-Id`（网关验签后注入，照 `/api/records/mine` 模式）——
 *    **没有任何「查谁」参数**（无 query、无 path 变量）；缺/空 ⇒ **10002/401**
 *    （空串视同缺失 = fail-closed，照 `records.controller.ts:28-30` 先例）；
 *  - 成功 ⇒ `{code:0, data:{balance}}`：经 `GetService` 读路径（缓存优先、miss 回源并
 *    写缓存；`exists=false` ⇒ 0）；**不建行**（§2.5 / C3：只读，查询永不产垃圾行）。
 *
 * ─── relief 契约（广告片 T15；规格 §2.5 **逐字**；旧 POST「金币场救助发放」已退役）───
 *  路由 `GET /api/wallet/relief[?claim=]`（**发放唯一入口 = T14 广告回调**；本端点永不
 *  发放、不落账），身份同取 `X-User-Id`（缺/空 ⇒ 10002/401）；`claim` 是查询参数
 *  （数组取首元素、非字符串/空串视同未携 —— 与网关 `whitelistedQueryOf` 的丢弃口径同形）。
 *
 *  响应信封 `{code:0, data:ReliefQueryData}`：**`amount`/`balance` 恒在场**；
 *  `claim` 仅「签发/复用」（无 claim 路径 · eligible）在场；`reason` 仅不可领/终态拒绝/
 *  失效在场（四条文案逐字见 `ReliefQueryData` 注）。
 *
 *  **判定次序（无 claim 路径，逐字；次序即判据）**：
 *    ① 配置**从未拉到**（`hasSnapshot()==false`）⇒ **503/10007**（沿用既有语义，不默认放行）；
 *    ② **今日已发**（账本当日 `actionId` = `reliefActionId(userId, 现在)` 存在）⇒
 *       `{grantedToday:true, eligible:false, reason:'今天已经领过了'}`——**先于开关与余额闸**
 *       （余额回升后的已领用户不得看到「余额充足」）；
 *    ③ `reliefEnabled` 关 ⇒ `reason:'救助暂未开放'`；
 *    ④ `balance ≥ 档位表最低档 × entryMultiplier` ⇒ `reason:'余额充足，无需救助'`；
 *    ⑤ eligible ⇒ 调 T12 `findOrCreate`（签发/复用 + **续期**）⇒ `claim` 随响应返回。
 *
 *  **携 claim 路径（轮询专用；只读——不签发、不续期；账本=唯一真源、Redis 记录=加速与
 *  回调侧载体 → 「先记录身份校验、再账本、后记录态」的次序正是 Redis 丢失时的兜底）**：
 *    ① 记录 `userId` ≠ JWT 本人 ⇒ 按「不存在」处理（不泄露他人凭证状态）；
 *    ② 账本（JWT 本人 + **时钟当日** actionId；跨零点必 miss——设计 §3 口径）已真 ⇒ 成功面
 *       `{grantedToday:true, eligible:false}`（先于记录态：`issued`/丢失记录也直接成功面）；
 *    ③ 记录 `done` ⇒ `granted`/`replayed` ⇒ 成功面；`disabled`/`balance_ok` ⇒ 对应 reason；
 *    ④ 记录 `issued` ⇒ pending `{eligible:true, grantedToday:false}`（轮询继续）；
 *    ⑤ 记录不存在 ⇒ `reason:'领取凭证已失效，请重试'`（`claim_invalid` 文案的唯一读取路径）。
 *
 *  **瞬态**：快照不可用 / claim 读取故障（`'read-failure'`——r3 🟡-6：**不得**归「失效」）/
 *  `findOrCreate` 的 `ClaimTransientError` ⇒ **503/10007**（既有文案）。
 *
 *  ⚠️ **指标面**：`currency_relief_total` 在本端点**零写点**（§2.7：旧 POST 的五处写点
 *  已迁至回调链；回看历史版本别把「发放桶」加回来）。
 *  ⚠️ **账本读**（`LEDGER_EXISTS_SQL`）与 `ad-callback.service.ts` 的同名常量**有意各自
 *  独立持有**：两处消费面互不 import（T14 的常量是私有），由各自单测夹具的同文独立副本
 *  双向钉住——SQL 漂移一个字符即在对应假库当场 reject，不会静默空测。
 *  ⚠️ **DI 纪律**：四个服务类**值导入** + 显式 `@Inject(...)`（本仓既有惯例，同
 *  `currency.rpc.controller.ts`：不依赖 `emitDecoratorMetadata` 的隐式注入）。
 *  ⚠️ 系统级故障（MySQL 不可达等）⇒ 服务层抛 ⇒ 这里**不吞**（Nest 默认 500）；
 *     §2.5 的错误面只有 503 与 10002/10001，其余不发明。
 */
export const USER_ID_HEADER = 'x-user-id';

/**
 * 查询响应 data（§2.5 逐字六字段）——`amount`/`balance` **恒在场**；`claim` 仅「签发/复用」
 * 在场；`reason` 仅不可领/终态拒绝/失效在场，四条文案逐字：
 * `今天已经领过了` · `救助暂未开放` · `余额充足，无需救助` · `领取凭证已失效，请重试`。
 */
export type ReliefQueryData = {
  eligible: boolean;
  grantedToday: boolean;
  amount: number;
  balance: number;
  claim?: string;
  reason?: string;
};

/**
 * 账本按 `actionId` 存在性读（**设计 §3 口径**：actionId 内嵌**签发日**，「今天」由
 * `reliefActionId(userId, 现在)` 构造——`done` 短路/账本先行的同源读面）。⚠️ 与 T14 的
 * 同文副本独立持有（见文件头「账本读」注）。
 */
const LEDGER_EXISTS_SQL = 'SELECT 1 FROM `currency_ops` WHERE `action_id` = ? LIMIT 1';

/**
 * 救助幂等锚（② 金币场 §9 逐字 + 广告片 T15 消费）：`relief:<userId>:<YYYY-MM-DD>`——
 * 日期按 **Asia/Shanghai** 在**服务端**计算（客户端时区不参与）。日期口径已抽出至
 * `../util/shanghai-date.ts`（`shanghaiDateOf`——**唯一实现点**；广告片 T12 的
 * `ads/claim.service.ts` `todayShanghai()` 与本节同源消费：claim 签发日必须与本锚的日期
 * 逐字一致，否则跨 UTC 日界会「凭证锚 A 日、账本查 B 日」两处分歧 —— 两处互指注释）。
 * T15 的两个 GET 判据（无 claim 的 ② 与携 claim 的 ②）都经**本函数**构造「今日」查询
 * （`grantedToday` 同口径），日边界定值向量由单测钉住（UTC 日界两侧 + 跨零点轮回）。
 */
export function reliefActionId(userId: string, now: Date): string {
  return `relief:${userId}:${shanghaiDateOf(now)}`;
}

@Controller('wallet')
export class WalletController {
  constructor(
    @Inject(GetService) private readonly getService: GetService,
    @Inject(ConfigCacheService) private readonly configCache: ConfigCacheService,
    @Inject(ClaimService) private readonly claims: ClaimService,
    @Inject(DataSource) private readonly dataSource: DataSource,
  ) {}

  @Get('balance')
  async balance(
    @Headers(USER_ID_HEADER) userId: string | undefined,
  ): Promise<{ code: ErrCode; data: { balance: number } }> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
    }
    return { code: ErrCode.OK, data: { balance: await this.readBalance(userId) } };
  }

  /**
   * 救助查询/签发（§2.5 全量；状态机与文案见文件头与 `ReliefQueryData`）。
   * **本方法不发放**：账本与余额恒只读；唯一的写面 = `findOrCreate` 的 claim 双键。
   */
  @Get('relief')
  async reliefQuery(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Query('claim') claimRaw?: string | string[],
  ): Promise<{ code: ErrCode; data: ReliefQueryData }> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
    }

    // ① 快照不可用 ⇒ 503/10007（两路径共同第一闸：连 `amount` 都算不出）
    if (!this.configCache.hasSnapshot()) {
      throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
    const amount = this.configCache.reliefAmount();

    // claim 归一：数组取首元素；非字符串/空串 ⇒ 视同未携（与网关白名单的丢弃口径同形——
    // 网关本就丢弃空值，直连形态同口径 ⇒ 端到端一致）。
    const first = Array.isArray(claimRaw) ? claimRaw[0] : claimRaw;
    const claim = typeof first === 'string' && first.length > 0 ? first : null;

    // 余额 = 响应**恒在场值**（非闸）：读取本身不裁决任何事，闸的次序见两分支内注号。
    const balance = await this.readBalance(userId);

    return claim === null
      ? this.queryWithoutClaim(userId, amount, balance)
      : this.queryWithClaim(userId, claim, amount, balance);
  }

  /** 无 claim 路径：裁决 + eligible 时签发/复用凭证（§2.5 判定次序 ②–⑤ 逐字）。 */
  private async queryWithoutClaim(
    userId: string,
    amount: number,
    balance: number,
  ): Promise<{ code: ErrCode; data: ReliefQueryData }> {
    // ② 今日已发（账本当日 actionId 存在；**先于开关与余额闸**——余额回升后的已领用户
    //    不得看到「余额充足」）
    if (await this.ledgerExists(reliefActionId(userId, new Date()))) {
      return this.reliefOk({ eligible: false, grantedToday: true, amount, balance, reason: '今天已经领过了' });
    }

    // ③ 开关关 ⇒ 14004 文案（次序即判据：连余额闸都不看）
    if (!this.configCache.reliefEnabled()) {
      return this.reliefOk({ eligible: false, grantedToday: false, amount, balance, reason: '救助暂未开放' });
    }

    // ④ 余额 ≥ 门槛（档位表最低档 × entryMultiplier）⇒ 14004 文案
    //    2026-10-21：底分锚点来自配置（无代码常量）；档位表不可用 ⇒ 钱路径 fail-closed。
    const lowest = this.configCache.minBaseScoreLevel();
    if (lowest === null) {
      throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }
    const threshold = lowest * this.configCache.entryMultiplier();
    if (balance >= threshold) {
      return this.reliefOk({ eligible: false, grantedToday: false, amount, balance, reason: '余额充足，无需救助' });
    }

    // ⑤ eligible ⇒ 签发/复用（T12 findOrCreate：NX + 条件删 + 复用两键续期；瞬态 ⇒ 503）
    const nonce = await this.findOrCreateOr503(userId);
    return this.reliefOk({ eligible: true, grantedToday: false, amount, balance, claim: nonce });
  }

  /** 携 claim 路径：轮询只读（§2.5 五态表逐行；不签发、不续期、永不写 Redis）。 */
  private async queryWithClaim(
    userId: string,
    claim: string,
    amount: number,
    balance: number,
  ): Promise<{ code: ErrCode; data: ReliefQueryData }> {
    // ①a 记录读：`'read-failure'`（Redis 连接故障）= 瞬态 ⇒ 503/10007——
    //     **不得**与「不存在」同归「失效」（r3 🟡-6：5xx 可重投，失效不可）
    const record = await this.claims.read(claim);
    if (record === 'read-failure') {
      throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
    }

    // ①b 跨主体 ⇒ 按「不存在」处理（不泄露他人凭证的 state/result）
    const mine = record !== null && record.userId === userId ? record : null;

    // ② 账本（JWT 本人 + **时钟当日**；跨零点必 miss——设计 §3）已真 ⇒ 成功面。
    //    **先于记录态**：Redis 记录丢失/错位时由账本兜底（唯一真源 = 账本）
    if (await this.ledgerExists(reliefActionId(userId, new Date()))) {
      return this.reliefOk({ eligible: false, grantedToday: true, amount, balance });
    }

    // ⑤ 不存在（含跨主体/过期/畸形）⇒ claim_invalid 文案的唯一读取路径（不建键——读侧自证）
    if (mine === null) {
      return this.reliefOk({ eligible: false, grantedToday: false, amount, balance, reason: '领取凭证已失效，请重试' });
    }

    // ④ issued ⇒ pending（轮询继续——窗内轮询看到的恒为 issued，不会误报失效）
    if (mine.state === 'issued') {
      return this.reliefOk({ eligible: true, grantedToday: false, amount, balance });
    }

    // ③ done ⇒ 按 result 出终态（granted/replayed ⇒ 成功面；disabled/balance_ok ⇒ 对应 reason）
    switch (mine.result) {
      case 'granted':
      case 'replayed':
        return this.reliefOk({ eligible: false, grantedToday: true, amount, balance });
      case 'disabled':
        return this.reliefOk({ eligible: false, grantedToday: false, amount, balance, reason: '救助暂未开放' });
      case 'balance_ok':
        return this.reliefOk({ eligible: false, grantedToday: false, amount, balance, reason: '余额充足，无需救助' });
      default:
        // 不可达（markDone 恒写 result；`isClaimRecord` 的 result 可选只服务 issued 态）——
        // 照「不变量破坏要响亮」纪律（同下 balance 形状守卫），不静默映射任何对外面子。
        throw new Error('claim 记录 done 态缺 result（不可达：markDone 恒写 result——数据面损坏）');
    }
  }

  /** 统一成功信封（code 恒 `OK`；data 形状见 `ReliefQueryData`）。 */
  private reliefOk(data: ReliefQueryData): { code: ErrCode; data: ReliefQueryData } {
    return { code: ErrCode.OK, data };
  }

  /** `FindOrCreate` 的 503 收口（`ClaimTransientError` = 瞬态：读故障/写故障/重试耗尽）。 */
  private async findOrCreateOr503(userId: string): Promise<string> {
    try {
      const { nonce } = await this.claims.findOrCreate(userId);
      return nonce;
    } catch (err) {
      if (err instanceof ClaimTransientError) {
        throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
      }
      throw err; // 非瞬态 = 真缺陷：不吞（Nest 默认 500）
    }
  }

  /**
   * 账本按 `actionId` 存在性读（`LEDGER_EXISTS_SQL`；见其注）。查询抛错（DB 不可达）⇒
   * 原样抛（Nest 500）——**不得**按「不存在」继续裁决（那会让已发用户走到签发面）。
   */
  private async ledgerExists(actionId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(LEDGER_EXISTS_SQL, [actionId])) as unknown[];
    return rows.length > 0;
  }

  /**
   * 单用户余额读（balance 端点与 relief 响应值共用；§2.4 读路径语义在 `GetService`）。
   * 非法 userId ⇒ 400/10001（表收口，`res.ok===false` 直透）；形状异常 ⇒ 响亮（防静默 0）。
   */
  private async readBalance(userId: string): Promise<number> {
    const res = await this.getService.get({ ownerIds: [userId] });
    if (!res.ok) throw httpException(res.code, res.message); // 非法 userId ⇒ 400/10001（表收口）
    const entry = res.data.balances[0];
    if (entry === undefined || res.data.balances.length !== 1) {
      // 单元素请求 ⇒ 单元素响应的不变量（get 实现被改动时会在这里响亮，而非静默 0）
      throw new Error('currency.get 返回的 balances 与请求不同构（单元素请求收到形状异常）');
    }
    return entry.balance;
  }
}

/**
 * 广告片 T14：**回调业务链**（账本先行 / 落序 / 计数六路径）——本片最核心的一件
 * （链序经过五轮设计评审，**逐字落，不许「优化」**；规格 §2.4/§2.6/§2.7 + 设计 §2/§3/§4.3）。
 *
 * ─── 链序契约（逐段；下文方法体按 ①–⑤ 注号一一对应）────────────────────────
 *  验签（T13）→ ① `read(nonce)`（`'read-failure'` ⇒ 抛瞬态【5xx 可重投，≠ claim_invalid】）
 *  → ② 记录 `done` ⇒ **短路**：回调面 `accepted`；发放面**不计**；返回
 *  → ③ **账本先行**：`ledgerExists(relief:{userId}:{date})` ⇒ `markDone('replayed')`；
 *     发放面 `replayed`；`accepted`（`date` = **claim 签发日**——设计 §3 口径：actionId
 *     内嵌签发日，**不看流水 `created_at` 落账时刻**；「apply 已提交而记录未落」的重投
 *     在此确定性判重放，不会撞余额闸、不污染 `granted` 桶）
 *  → ④ 正向裁决（`wallet.controller` 同款四步的 ①②③，**次序即判据**）：
 *     `hasSnapshot` 缺 ⇒ 抛瞬态（**不落 done**，保持 issued）；开关关 ⇒ `markDone('disabled')`
 *     ⇒ `rejected`；余额 ≥ 门槛 ⇒ `markDone('balance_ok')` ⇒ `rejected`
 *  → ⑤ `apply`（`actionId = relief:<userId>:<date>`，与 ③ 同一锚）：granted ⇒
 *     **立即计 `granted`**（「与 apply 返回同点计入」——金钱事实已发生）⇒ `markDone('granted')`；
 *     replayed / 14002 ⇒ 计 `replayed` ⇒ `markDone('replayed')`
 *  → 终态后落 `done/result`（**落序**：`done/result` 只在终态之后落；瞬态 ⇒ 不落任何东西、
 *     保持 issued）。
 *
 * ─── 计数六路径（§2.7 表「落定版」；一回调在**回调面**恰入一桶、**发放面**只记真实裁决）──
 *  ① done 短路 ⇒ 回调面 `accepted` / 发放面**不计**（原处置已计）  ② 账本先行 ⇒ `accepted` / `replayed`
 *  ③ 正向拒绝 ⇒ `accepted` / `rejected`                            ④ apply granted ⇒ `accepted` / `granted`
 *  ⑤ apply replay / 14002 ⇒ `accepted` / `replayed`                ⑥ 瞬态 ⇒ `error` / 不计
 *
 *  🔴 「一回调一计」的实现机制：各路径**在契约点就近入桶**（③④ 在 `markDone` 成功后、
 *  ⑤ 在 apply 返回同点——与冻结链序的字面次序一致）；本文件的**总收口 catch** 只在
 *  「尚未入桶」时补 `error` 桶。这使「granted 已计但 `markDone` 失败」的回调**不重复
 *  入 error 桶**（其 5xx 只是投递面——重投走 ③ 再计 `replayed`，两笔各计一次；设计 §4.3）。
 *
 * ─── 每次回调对 apply 的载荷（逐字照 wallet 先例；§9/§3）────────────────────────
 *  `{ actionId, source:'relief_grant', entries:[{ownerId: userId, delta: amount}], refId: userId }`
 *  ——`amount` = 配置快照 `reliefAmount()`；门槛 = `档位表最低档 × entryMultiplier()`。
 *
 * ─── 与简报 Interfaces 的一处实现期订正（登记；报告 §Issues）────────────────────
 *  简报 Interfaces 行写 `processCallback({ extra, transId })`。但 T13 冻结的验签契约是
 *  `verify(request)`（形状解析的**唯一实现点** `extractCallbackFields` 在验签器内；
 *  v1.4 T0 回填后入参形态 = GET query），且本任务的 Interfaces「Consumes: T13 verifier」
 *  明确验签在链内——`{extra, transId}` 正是**验签产物**（`{ok:true, extra, transId}`
 *  的两字段），作为入参无法驱动验签。⇒ 对外入口取**原始请求**（`RewardedCallbackRequest`），
 *  `extra/transId` 在链内由验签步骤产出；控制器面照 v1.4 把结果编码 200/5xx + JSON
 *  （`{"isValid":…}`）。
 *
 * ⚠️ **DI 纪律**：被注入的类一律**值导入**（`import type` 会容器崩——只有真容器抓得到）；
 *  `DataSource` 同仓先例值导入。验签器经类 token `DefaultRewardedCallbackVerifier` 注入
 *  （app.module 注册；T13 报告移交的「或注册 or 手构」取前者）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ApplyService } from '../apply/apply.service';
import { GetService } from '../apply/get.service';
import { ConfigCacheService } from '../config/config-cache.service';
import {
  currencyReliefTotal,
  reliefCallbackTotal,
  type ReliefCallbackResult,
} from '../metrics/currency.metrics';
import { ClaimService } from './claim.service';
import { DefaultRewardedCallbackVerifier } from './ads-verifier';
import type {
  RewardedCallbackRequest,
  RewardedCallbackVerifyResult,
  RewardedCallbackVerifier,
} from './ads-verifier';

/**
 * ⑤ 的结果域（简报 Interfaces 逐字四值；「claim 无效」归 `'success-terminal'`——
 * 线上编码与其它终态逐字相同：200 + `{"isValid":true}`；**监控桶**在链内单独入 `claim_invalid`）。
 */
export type AdCallbackOutcome = 'success-terminal' | 'reject-sign' | 'reject-malformed' | 'transient';

/**
 * `ledgerExists` 的只读查询（**设计 §3 口径**：按 `actionId` 存在性读——actionId 内嵌
 * **claim 签发日**，不看流水 `created_at` 落账时刻）。形态自选（简报允许）：不复用
 * `ApplyService` 的私有读面（那是 private；本任务提交面不含其文件），单发一条只读
 * `SELECT 1 … LIMIT 1`。⚠️ 本 SQL 的**独立副本**在单测夹具（`ad-callback.test.ts`）——
 * 漂移一个字符 ⇒ 假库当场 reject，不会静默空测。
 */
const LEDGER_EXISTS_SQL = 'SELECT 1 FROM `currency_ops` WHERE `action_id` = ? LIMIT 1';

/** 错误原因短句（日志面；不透传内部拓扑的场合由调用侧固定文案兜）。 */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class AdCallbackService {
  private readonly logger = new Logger(AdCallbackService.name);

  /**
   * ⚠️ **显式 `@Inject(...)`**（本仓既有惯例）：不依赖 `emitDecoratorMetadata` 的隐式注入。
   * 六个依赖全部在 app.module 的可见面内（验签器/ClaimService = 本模块 providers；
   * ConfigCacheService = ConfigModule exports；GetService/ApplyService = RpcModule exports；
   * DataSource = TypeOrmModule 全局）。
   */
  constructor(
    @Inject(DefaultRewardedCallbackVerifier) private readonly verifier: RewardedCallbackVerifier,
    @Inject(ClaimService) private readonly claims: ClaimService,
    @Inject(ConfigCacheService) private readonly configCache: ConfigCacheService,
    @Inject(GetService) private readonly getService: GetService,
    @Inject(ApplyService) private readonly applyService: ApplyService,
    @Inject(DataSource) private readonly dataSource: DataSource,
  ) {}

  /**
   * 回调链总入口（控制器 ③ 的唯一接线面）。返回四值之一；控制器按 v1.4 §2.4 表编码
   * （终态 200 `{"isValid":true}` / 瞬态 503 `{"isValid":false}`）。
   * **本方法不抛**（一切异常收口为 `'transient'` + `error` 桶）。
   */
  async processCallback(request: RewardedCallbackRequest): Promise<AdCallbackOutcome> {
    /** 「一回调一计」的入桶口：回调面恰一次（见文件头机制注）。 */
    let callbackCounted = false;
    const count = (bucket: ReliefCallbackResult): void => {
      reliefCallbackTotal.inc({ result: bucket });
      callbackCounted = true;
    };

    // ── 验签（T13 + v1.4 真算法；密钥不可用 ⇒ 抛瞬态）────────────────────────
    let verified: RewardedCallbackVerifyResult;
    try {
      verified = await this.verifier.verify(request);
    } catch (err) {
      // 密钥未配置/拉取不可用 ⇒ 瞬态（503 {"isValid":false} 等重投——**不得**映射确定性拒绝）
      this.logger.warn(`广告回调验签不可用（瞬态 ⇒ 5xx 等重投）：${reasonOf(err)}`);
      count('error');
      return 'transient';
    }
    if (!verified.ok) {
      // 确定性拒绝（坏签名/畸形）：v1.4 有意口径——归**终态** 200 {"isValid":true}
      // （确定性结局不可改变；平台不重投。密钥错配窗口由 ReliefCallbackBroken 告警兜底）
      count(verified.reason === 'bad_sign' ? 'bad_sign' : 'malformed');
      this.logger.warn(`广告回调确定性拒绝 reason=${verified.reason}（终态 200 isValid:true 不重投）`);
      return verified.reason === 'bad_sign' ? 'reject-sign' : 'reject-malformed';
    }

    // ── 业务链（①–⑤；一切抛错 = 瞬态；已入桶则不重复计——见文件头机制注）
    try {
      return await this.runChain(verified.extra, verified.transId, count);
    } catch (err) {
      if (!callbackCounted) count('error');
      this.logger.warn(`广告回调处理瞬态失败（5xx 等重投；记录保持 issued）：${reasonOf(err)}`);
      return 'transient';
    }
  }

  /**
   * 链体 ①–⑤（链序逐字；与文件头 map 一致）。`count` = 回调面入桶口（发放面在链内
   * `currencyReliefTotal` 就近入桶）。
   */
  private async runChain(
    extra: string,
    transId: string,
    count: (bucket: ReliefCallbackResult) => void,
  ): Promise<AdCallbackOutcome> {
    // ① 读记录：'read-failure'（Redis 连接故障）⇒ 瞬态，**不得**与「不存在」同归 claim_invalid
    const record = await this.claims.read(extra);
    if (record === 'read-failure') {
      throw new Error('claim 读取故障（瞬态：Redis 连接异常）');
    }
    if (record === null) {
      // claim 无效（不存在/过期/畸形）：**不建键**、只计回调面（§2.6/§4.3）；
      // 线上编码与其它终态相同 = 200 + {"isValid":true}（重投不可改变结局）。
      count('claim_invalid');
      return 'success-terminal';
    }

    // ② done 短路（顺序重投）：回调面 accepted、发放面不计（原处置已计）、记录零改写。
    if (record.state === 'done') {
      count('accepted');
      return 'success-terminal';
    }

    // ③ 账本先行：actionId = relief:<claim.userId>:<claim.签发日>（唯一真源 = 账本；
    //    Redis 记录只是加速与回调侧载体——设计 §3）。构造中的重投在此确定性判重放。
    const actionId = `relief:${record.userId}:${record.date}`;
    if (await this.ledgerExists(actionId)) {
      await this.claims.markDone(extra, 'replayed'); // 抛 ⇒ 瞬态（尚未入桶）
      currencyReliefTotal.inc({ result: 'replayed' });
      count('accepted');
      return 'success-terminal';
    }

    // ④ 正向裁决（wallet.controller:106-153 同款四步的 ①②③；**次序即判据**）
    if (!this.configCache.hasSnapshot()) {
      // 配置**从未拉到** ⇒ 瞬态（不默认放行、**不落 done**——保持 issued，等重投）
      throw new Error('配置快照从未拉到（瞬态：不落 done）');
    }
    if (!this.configCache.reliefEnabled()) {
      await this.claims.markDone(extra, 'disabled'); // 终态后落 done（落序）
      currencyReliefTotal.inc({ result: 'rejected' });
      count('accepted');
      return 'success-terminal';
    }
    const amount = this.configCache.reliefAmount();
    // 2026-10-24 平行化：平台级绝对门槛；缺失/非法 ⇒ 瞬态（不落 done、等平台重投）。
    const threshold = this.configCache.reliefThresholdCoins();
    if (threshold === null) {
      throw new Error('平台救助门槛不可用（瞬态：不落 done）');
    }
    const got = await this.getService.get({ ownerIds: [record.userId] });
    if (!got.ok) {
      throw new Error(`currency.get 拒绝（瞬态）：code=${got.code} ${got.message}`);
    }
    const entry = got.data.balances[0];
    if (entry === undefined || got.data.balances.length !== 1) {
      // 单元素请求 ⇒ 单元素响应的不变量（同 wallet：形状异常要响亮，不得静默 0）
      throw new Error('currency.get 返回的 balances 与请求不同构（不变量破坏）');
    }
    if (entry.balance >= threshold) {
      await this.claims.markDone(extra, 'balance_ok');
      currencyReliefTotal.inc({ result: 'rejected' });
      count('accepted');
      return 'success-terminal';
    }

    // ⑤ apply（actionId 与 ③ 同一锚：同日同 claim 幂等独占——超时重投安全）
    const res = await this.applyService.apply({
      actionId,
      source: 'relief_grant',
      entries: [{ ownerId: record.userId, delta: amount }],
      refId: record.userId,
    });
    if (!res.ok) {
      if (res.code === ErrCode.E_ACTION_CONFLICT) {
        // 14002（同日改金额/竞窗）⇒ 照 D10 翻成 replayed 终态（**不**把冲突透给平台）
        currencyReliefTotal.inc({ result: 'replayed' });
        count('accepted');
        await this.claims.markDone(extra, 'replayed');
        return 'success-terminal';
      }
      // 其余拒绝码（正 delta 下 14001 不可达；10001 = 数据面异常）⇒ 瞬态：不落 done、响亮
      throw new Error(`currency.apply 拒绝（瞬态——非 14002 的异常面）：code=${res.code} ${res.message}`);
    }
    if (res.data.replayed) {
      // apply 重放（③ 账本读与 apply 之间的竞窗）：计 replayed ⇒ 落 done:replayed
      currencyReliefTotal.inc({ result: 'replayed' });
      count('accepted');
      await this.claims.markDone(extra, 'replayed');
      return 'success-terminal';
    }

    // granted：**与 apply 返回同点计入**（金钱事实已发生——先计后落 done；
    // 此后记录写失败 ⇒ 重投走 ③ 再计 replayed，两笔各计一次）
    currencyReliefTotal.inc({ result: 'granted' });
    count('accepted');
    this.logger.log(
      `广告回调发放 granted user=${record.userId} actionId=${actionId} transId=${transId}`,
    );
    await this.claims.markDone(extra, 'granted');
    return 'success-terminal';
  }

  /**
   * 账本按 `actionId` 存在性读（设计 §3 口径；见 `LEDGER_EXISTS_SQL` 注）。
   * 查询抛错（DB 不可达）⇒ 原样抛 ⇒ 链收口为瞬态（**不得**按「不存在」继续裁决——
   * 那会让「apply 已提交」的窄窗重投撞余额闸）。
   */
  private async ledgerExists(actionId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(LEDGER_EXISTS_SQL, [actionId])) as unknown[];
    return rows.length > 0;
  }
}

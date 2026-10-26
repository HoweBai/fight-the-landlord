/**
 * conformance 入口（协调者拥有）。
 *
 * 为什么**不**挂进 `turbo run test`：这些用例需要 3000-3003 的真实服务与 Redis
 * 一直在跑，挂进去会让「没有容器的环境」出现假红。它们由协调者在每个切片的
 * 门禁里显式运行：
 *
 *   pnpm --filter @fight-the-landlord/conformance build
 *   pnpm --filter @fight-the-landlord/conformance conformance:slice-05
 */
import { ConformanceError, info, step, type SkippedAssertion } from './lib/assert';
import { GAME_URL, GATEWAY_URL, INTERNAL_TOKEN, assertGatewayHealthy, getJson, registerUser } from './lib/http';
import { runSlice05 } from './slices/slice-05-reconnect';
import { runSlice06 } from './slices/slice-06-auth-rooms';
import { runSlice07 } from './slices/slice-07-match-join';
import { runSlice071 } from './slices/slice-07.1-room-atomic-seating';
import { runSlice08 } from './slices/slice-08-bidding';
import { runSlice09 } from './slices/slice-09-play-rotation';
import { runSlice10 } from './slices/slice-10-settlement';
import { runSlice11 } from './slices/slice-11-robot-system';
import { runSlice072Security } from './slices/slice-07.2-security';
import { runSlice072Boundary } from './slices/slice-07.2-boundary';
import { runSlice072Hardening } from './slices/slice-07.2-hardening';
import { runSlice072Deploy } from './slices/slice-07.2-deploy';
import { runSlice072Rpc } from './slices/slice-07.2-rpc';
import { runSlice073Edge } from './slices/slice-07.3-edge';
import { runSlice12 } from './slices/slice-12-manual-join';
import { runSlice074Pipeline } from './slices/slice-07.4-pipeline';
import { runSlice075Backup } from './slices/slice-07.5-backup';
import { runSlice13 } from './slices/slice-13-ai-rollout';
import { runSlice14 } from './slices/slice-14-config-center';
import { runSlice15 } from './slices/slice-15-records';
import { runSlice16 } from './slices/slice-16-monitoring';
import { runSlice17 } from './slices/slice-17-currency';
import { runSlice18 } from './slices/slice-18-gold-room';
import { runSlice19 } from './slices/slice-19-admin-rbac-audit';
import { runSlice20 } from './slices/slice-20-risk-control';
import { runSlice21 } from './slices/slice-21-payment';
import { runSlice22 } from './slices/slice-22-pay-channel';
import { runSlice23 } from './slices/slice-23-notify-channel';
import { runSlice24 } from './slices/slice-24-ads-relief';
import { runSlice25 } from './slices/slice-25-entry-fee';
import { runSlice26 } from './slices/slice-26-client-gate';
import { runSlice27 } from './slices/slice-27-idle-trustee';
import { runSlice28 } from './slices/slice-28-card-counter';
import { runSlice29 } from './slices/slice-29-paodekuai';
import { runSlice30 } from './slices/slice-30-pdk-metrics';
import { runSlice31 } from './slices/slice-31-pdk-gold';
import { runSlice32 } from './slices/slice-32-agent';
import { runSlice33 } from './slices/slice-33-pdk-risk-gold';

interface Case {
  title: string;
  /** `skipped` 可选：只有会**显式跳过**断言的切片（如 `slice-07.5-backup` 缺 `flock` 时的锁判据）才带它。 */
  run: () => Promise<{ passed: string[]; skipped?: readonly SkippedAssertion[] }>;
}

const CASES: Record<string, Case> = {
  'slice-05': { title: '断线重连', run: runSlice05 },
  'slice-06': { title: '登录 + 房间列表', run: runSlice06 },
  'slice-07': { title: '匹配 → 进房', run: runSlice07 },
  'slice-07.1': { title: 'room 原子入座（C11）', run: runSlice071 },
  'slice-08': { title: '叫抢地主', run: runSlice08 },
  'slice-09': { title: '出牌轮转（一局打到分出胜负）', run: runSlice09 },
  'slice-10': { title: '结算（N1/守恒/N17）', run: runSlice10 },
  'slice-11': { title: '机器人系统（§9 驱动/池/不可区分）', run: runSlice11 },
  'slice-07.2-security': { title: '视图座位归属（S2/S8/N3）', run: runSlice072Security },
  'slice-07.2-boundary': { title: '服务间身份边界（N4/N7）', run: runSlice072Boundary },
  'slice-07.2-hardening': { title: '安全收口（A6/S4/S5/N5/N6/S6/§9.8）', run: runSlice072Hardening },
  'slice-07.2-deploy': { title: '生产编排收口（R98 / §A.3）', run: runSlice072Deploy },
  'slice-07.2-rpc': { title: '§4.2 TCP RPC 迁移（N20/P4）', run: runSlice072Rpc },
  'slice-07.3-edge': { title: '门口（TLS/静态站/反代 + 可信 IP）', run: runSlice073Edge },
  'slice-12': { title: '手动进房（F6：建房 → REST 占座 → WS 挂载）', run: runSlice12 },
  'slice-07.4-pipeline': { title: '流水线清点（工作流集合 / 触发分级 / needs 串行）', run: runSlice074Pipeline },
  'slice-07.5-backup': { title: '备份与恢复路径（片③-B）', run: runSlice075Backup },
  // ⚠️ 新片**追加在末尾**：CI 的切片循环按本表顺序跑（`--list`），baselines.json 的 full 列
  //    也按此顺序由 CI 回填（spec §5 的 S3：本机读数**不得**回填）。
  'slice-13-ai-rollout': { title: '机器人 AI 全量化（并发/模型契约/缺模型）', run: runSlice13 },
  'slice-14-config-center': { title: '配置中心 + 好友房开关（C1/C2/C5半/C6半/C7/C8/C13-C17/C20）', run: runSlice14 },
  // 记录片 T9：**追加在末尾**（同前一条注释的纪律 —— 顺序即 CI 切片循环与 full 回填的顺序）。
  'slice-15-records': { title: '记录片（幂等/只本人/白名单/保留期/失败姿态 + 同毫秒 keyset）', run: runSlice15 },
  // 监控片 T12：**追加在末尾**（同前——监控六容器与边缘由 `--profile edge --profile monitoring` 起栈覆盖）。
  'slice-16-monitoring': { title: '监控片（指标面/守卫/告警链/边缘路由/供给链）', run: runSlice16 },
  // 货币核心片（P2-①）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序）。
  'slice-17-currency': { title: '货币核心（服务/三表/幂等重放/管理面/注册赠送/对账）', run: runSlice17 },
  // ② 金币场（T12）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序）。
  'slice-18-gold-room': { title: '金币场（开关/门槛/结算/机器人池/救助/三值化）', run: runSlice18 },
  // ③ 财务后台 + RBAC + 审计（T11）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序）。
  'slice-19-admin-rbac-audit': { title: '财务后台 + RBAC + 审计（登录策略矩阵/账号留痕/冲正/读口/CSV 字节）', run: runSlice19 },
  // 风控片（T11）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序）。
  'slice-20-risk-control': { title: '风控（配置面/谓词开关对照/数据链/检测链/限流档/封禁/权限/审计/回归）', run: runSlice20 },
  // 支付片（T16）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序；
  // 本片依赖 `conformance-stack.sh up` 起的 `ftl-alipay-stub` 与 ⚙️18 六值注入）。
  'slice-21-payment': { title: '支付（十八组：下单/回调/入账/提现/退款/cap/权限/自检/防护/翻页）', run: runSlice21 },
  // 支付配置管理化片（T16）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序；
  // 本片依赖 `conformance-stack.sh up` 的渠道六键种子 + stub 控制面 `/_control/set-app-public`）。
  'slice-22-pay-channel': { title: '支付配置管理化（十组：种子/未配置/轮换/读不回/审计/广播/加密/日志/权限/主钥/回落）', run: runSlice22 },
  // 通知通道管理化片（T16）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序；
  // 本片依赖 `conformance-stack.sh up` 起的真栈（含 am-renderer；投递 stub 由本片①自起自停）。
  'slice-23-notify-channel': { title: '通知通道管理化（十一组：种子取值/不进广播/静态加密/审计/权限变体/relay 端到端/AM 渲染/回落/fail-closed/gauge规则/日志）', run: runSlice23 },
  // 广告小片（T21）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序；
  // 本片依赖 `conformance-stack.sh up` 起的真栈（含 edge `/ad/notify/*` 路由与第四键空间种子）。
  // ⚠️ **T0-2 边界**：④ 起签名依赖步在 T20 helper 回填（T0-2 到货）前**响亮红**——
  // ⓪①②③ 及 ④ 的免签名钉子照常执行；真绿判定以 T0-2 到货为前置。
  'slice-24-ads-relief': { title: '广告救助（十二组：起手/键空间/键面/签发/拒发穷尽/正路/重投/账本先行/跨零点/轮询四态/不建键/旧POST）', run: runSlice24 },
  // 台费片（T9）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序；
  // 本片含真实时序（30s 补位窗口、两局完整对局）与逐人收费窗轮询）。
  'slice-25-entry-fee': { title: '台费（真栈：收费/免单/重放冲突 + 汇总/报表面）', run: runSlice25 },
  // 客户端接入片（T8）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序；
  // 本片前置 = 以**本分支源码**重建 api-gateway + config-service 两容器——旧发布镜像无
  // 本片代码，⓪ 前置自证会反成归因难题。本机手动等价；CI 侧两条路径天然满足：
  // `conformance-stack.sh up` 默认模式（`IMAGE_TAG_PULL` 空）即 `up -d --build` 本机构建，
  // release 复用路径（PULL_MODE=1）拉的就是被验 tag 自己的镜像）。
  'slice-26-client-gate': { title: '客户端接入开关（真栈：闸矩阵/真链序/三豁免/socket 拦新不踢旧/留痕/复原）', run: runSlice26 },
  // 挂机治理片（T8）：**追加在末尾**（同前——顺序即 CI 切片循环与 full 回填的顺序）。
  // 本片前置 = **注入四枚测试 env（1500/1000/400/3）并以本分支源码重建 game-service**，
  // 收尾 finally 还原四 env + 重建回默认 + 行为面复验（30s 档实读）。⚠️ 注入态若残留，
  // 后续片（尤其 slice-11 的「<5s ⇒ 非超时兜底」判别）会全部读错 ⇒ 还原失败 = 硬失败。
  'slice-27-idle-trustee': { title: '挂机治理（真栈：加速两档/自动托管/复位/R8三格+C14/弃局回桌/C18 回调）', run: runSlice27 },
  // 记牌器收费片（T16）：追加在末尾（顺序即 CI 切片循环与 full 回填顺序）。
  // 本片含一次金币局开局（1 真人 + 30s 补位窗口）与价格临时改→还原；未知态不在真栈构造。
  'slice-28-card-counter': { title: '记牌器收费（真栈：购买/重放/改价重试/并发/包时/不足/金币局消费）', run: runSlice28 },
  // 多玩法片（S7.3）：追加在末尾（顺序即 CI 切片循环与 full 回填顺序）。
  // 本片经管理面开启跑得快（收尾还原），用独立 oracle 打完整一局并核对结算/记录。
  'slice-29-paodekuai': { title: '跑得快（真栈：匹配/开局/出牌过牌/结算/记录/房间过滤/风控扫描）', run: runSlice29 },
  // 多玩法 A1：PDK 指标标签真栈（只打一局，断言 started/ended 的 game_type）。
  'slice-30-pdk-metrics': { title: '跑得快指标（真栈：按玩法 started/ended）', run: runSlice30 },
  // 多玩法 A2/A3：PDK 金币场账本玩法维度 + 管理玩家统计（本机无 Docker，待权威轮）。
  'slice-31-pdk-gold': { title: '跑得快金币场（真栈：台费/结算/记录/管理统计玩法维度）', run: runSlice31 },
  // 代理分润片（2026-10-26，任务 15）：追加在末尾（原计划 slice-30 与 PDK 指标片撞号，
  // 合并后顺延为 32）。真库证明 SAVEPOINT/额度首建并发/水位结算 SUM+hash 复核/关闭期对账；
  // 收尾恢复两开关/表名/冻结态。
  'slice-32-agent': { title: '代理分润（真栈：绑定/计佣链/自玩冻结/并发/SAVEPOINT/结算/调账/对账/鉴权）', run: runSlice32 },
  // B 组：PDK gold 2/4 + 风控 2/3/4 + 机器人局剔除 + 自动限流。
  // ⚠️ 2026-10-26 与代理分润片合并时撞号（dev 已占 slice-32）⇒ 本片顺延为 slice-33；
  //    spec/plan 的历史文本仍写 slice-32，代码与基线以本键为准。
  'slice-33-pdk-risk-gold': { title: '跑得快 B 组（真栈：gold 2/4/截断/风控人数/机器人剔除/自动限流）', run: runSlice33 },
};

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      '用法：node dist/run.js <case>',
      '用例：',
      ...Object.entries(CASES).map(([name, c]) => `  ${name.padEnd(12)} ${c.title}`),
      '',
      `环境变量：GW（默认 ${GATEWAY_URL}）、GAME_URL（默认 ${GAME_URL}，S8 直连用）、DDZ_NAMESPACE（默认 /ws/ddz）`,
      `          USER_URL/ROOM_URL/ROBOT_URL（默认 3001/3002/3005，直连探针用，见 lib/http.ts）`,
      `          INTERNAL_TOKEN（默认 ${INTERNAL_TOKEN}，必须与 compose 的 INTERNAL_SERVICE_TOKEN 一致；R96）`,
    ].join('\n'),
  );
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '选项：',
      '  --render  纯渲染形态：**不**探测网关健康（跳过 `assertGatewayHealthy()`）。',
      '            只对不依赖 docker daemon 的切片有意义（本仓 = `slice-07.2-deploy` 的',
      '            prod/dev 段，配合 `CONFORMANCE_DEPLOY_STEPS=prod,dev`，以及 `slice-07.4-pipeline`）。',
      '  --list    按 `CASES` 的顺序逐行打印用例名。**CI 的切片循环用它取顺序** ——',
      '            另抄一份清单就是第二个真源。',
      '  --fresh   默认态前置断言（C11，**不是切片**）：注册用户 → `GET /api/config` ⇒',
      '            `friendRoomEnabled === false`。由 conformance.yml 在「起真栈」与「跑切片」之间调用。',
    ].join('\n'),
  );
}

// ── 支付配置管理化片 T14（规格 §5.4）：两枚新 env 的**单一 runner 供给点** ─────────────────
// runner 进程 env 是 `docker compose` **插值的第二来源**：本文件经 run.ts 触发的一切
// `docker compose up` 重建点（slice-14 C6/C16 · slice-21 ⑬ · slice-22 ⑨ 两处）都从**本进程**
// 继承 env ⇒ 两枚在这里供给后，那些重建不会把 compose 插值（`${VAR:-}` 空默认透传）插空。
// 初起整栈的供给在 `scripts/deploy/conformance-stack.sh` 顶部 export（同一组 dev 常量，
// 两处同源 — 与 `ADMIN_PASSWORD` 同一条「唯一供给点」纪律：本机与 CI 同路径）。
// ⚠️ `??=` 而非 `=`：尊重**显式覆盖**——只在本进程 env 未设（undefined）时才落 dev 值。
//    slice-22 ⑨ 的 `{...process.env, PAY_CONFIG_ENC_KEY: ''}` 空构造（fail-closed 窗口）
//    与恢复步从容器 `pick('PAY_CONFIG_ENC_KEY')` 取回的值都会**显式**进 env（`''`/实值
//    都不是 undefined）⇒ 不受本行影响；开发者/CI 若显式 export 了自己的值亦然。
// ⚠️ 这是 runner 侧**唯一**供给点：**不**另开 `conformance.yml` 副本（避免多源漂移，R96
//    教训）；将来若出现**不经 run.ts** 的 compose 调用点，扩此处管辖（T-1）。
process.env.PAY_CONFIG_ENC_KEY ??= 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';
process.env.PAY_CHANNEL_PULL_TOKEN ??= 'dev-pay-channel-pull-token-change-in-production';
// ── 通知通道管理化片 T16（规格 ⚙️13/§5.4）：第三枚新 env 的 runner 供给点 ───────────────
// `NOTIFY_CHANNEL_PULL_TOKEN`（**三持有**：config-service + alert-relay + am-renderer；§2.6）。
// slice-23 的 ⑧/⑨ 会经 `docker compose up --force-recreate` 重建 relay / renderer /
// config-service —— 那一侧 compose 插值走**本进程** env（`${VAR:-}` 空默认透传）⇒ 不在这里
// 供给，重建出的三个持有者会拿到空令牌（消费端拉取全被拒——⑧e/⑨ 的复绿判据当场红）。
// 初起整栈的供给在 `scripts/deploy/conformance-stack.sh` 顶部 export（同一 dev 常量，
// 两处同源——与 `PAY_*` 两键同一条「唯一供给点」纪律）。⚠️ `??=` 尊重**显式覆盖**
// （只在本进程 env 未设时才落 dev 值——开发者/CI 显式 export 自己的值不受影响）。
process.env.NOTIFY_CHANNEL_PULL_TOKEN ??= 'dev-notify-channel-pull-token-change-in-production';
// ── 广告片 T10（规格 §2.3）：第四枚新 env 的 runner 供给点 ───────────────────────────────
// `AD_CHANNEL_PULL_TOKEN`（**两持有**：config-service + currency-service）。本文件经 run.ts
// 触发的一切 `docker compose up` 重建点从**本进程**继承 env ⇒ 两持有在这里供给后，那些重建
// 不会把 compose 插值（`${VAR:-}` 空默认透传）插空（与 `PAY_*`/`NOTIFY_*` 两段同一机制陈述）。
// 初起整栈的供给在 `scripts/deploy/conformance-stack.sh` 顶部 export（同一 dev 常量，
// 两处同源——与 `PAY_*`/`NOTIFY_*` 同键同一「唯一供给点」纪律；字面与 T7 测内
// `DEV_AD_PULL_TOKEN` 逐字一致）。⚠️ `??=` 尊重**显式覆盖**（只在本进程 env 未设时才落
// dev 值——开发者/CI 显式 export 自己的值不受影响）。
process.env.AD_CHANNEL_PULL_TOKEN ??= 'dev-ad-channel-pull-token-change-in-production';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // ⚠️ `--list` 必须在 case 查找**之前**：它不是一次运行，是取顺序。
  if (args.includes('--list')) {
    for (const name of Object.keys(CASES)) {
      // eslint-disable-next-line no-console
      console.log(name);
    }
    return;
  }
  // ⚠️ `--fresh` 同样必须在 case 查找**之前**：它不是一次切片运行，而是「起真栈之后、跑切片之前」
  //    的**默认态前置断言**（C11 的载体；conformance.yml 的「默认态前置断言」步）：注册用户 →
  //    `GET /api/config` ⇒ `friendRoomEnabled === false`（种子=生产默认的铁律 —— fresh 态是
  //    唯一可观测时点；做成切片会恒红/空洞二选一）。⚠️ **不进 baselines**：它不在 CASES 里、
  //    也不进 `--list` 顺序（不在切片循环日志里 ⇒ 条数闸看不见它，这是有意的）。
  if (args.includes('--fresh')) {
    try {
      // 起真栈后紧接着跑 ⇒ 网关可能还在预热：先过有界的就绪等待（同主路径的第一步）。
      await assertGatewayHealthy();
      const user = await registerUser(0);
      const cfg = await getJson<{ friendRoomEnabled: boolean }>('/api/config', user.accessToken);
      const ok = cfg.body?.code === 0 && cfg.body.data?.friendRoomEnabled === false;
      // eslint-disable-next-line no-console
      console.log(ok
        ? '✅ fresh 态前置断言（C11）：friendRoomEnabled === false（种子=生产默认）'
        : `❌ fresh 态前置断言（C11）失败：${JSON.stringify(cfg.body)}（期望 false —— 栈种子被改过？）`);
      process.exitCode = ok ? 0 : 1;
    } catch (err) {
      // ⚠️ 「跑挂 ≠ 断言红」：分开说 —— 否则「注册失败/网关没起」会被读成「栈种子不是 false」。
      // eslint-disable-next-line no-console
      console.error(`❌ fresh 态前置断言（C11）跑挂：${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    return;
  }
  const name = args.find((a) => !a.startsWith('--'));
  const renderOnly = args.includes('--render');
  if (!name) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const testCase = CASES[name];
  if (!testCase) {
    // eslint-disable-next-line no-console
    console.error(`未知用例：${name}`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  step(
    `conformance / ${name} —— ${testCase.title}（网关 ${GATEWAY_URL}）` +
      (renderOnly ? ' · `--render`（纯渲染，不探测网关）' : ''),
  );
  const startedAt = Date.now();
  try {
    if (renderOnly) {
      // ⚠️ 纯渲染形态的**全部**理由（B2）：这一步是本 runner 唯一的无条件网络调用，
      //    而渲染类判据（`docker compose config`）**不需要 docker daemon**、
      //    更不需要网关在跑 ⇒ 每次 push 都能跑，2.8s。
      info('`--render`：跳过 `assertGatewayHealthy()`（纯渲染不依赖 docker daemon）');
    } else {
      await assertGatewayHealthy();
    }
    const checks = await testCase.run();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    // ⚠️ 跳过**不许**混进「通过」：本机缺 flock 这类环境缺条件时，切片把判据登记进
    //    `checks.skipped`（见 `lib/assert.ts` 的 `skip()`）⇒ 收尾行必须把**条数与原因**写进
    //    结论里，否则「绿」会被读成「全验过」。跳过为 0 时此行与从前**逐字相同**。
    const skips = checks.skipped ?? [];
    const skipNote = skips.length === 0
      ? ''
      : `，跳过 ${skips.length} 项（${[...new Set(skips.map((s) => s.reason))].join('；')}）`;
    // eslint-disable-next-line no-console
    console.log(`\n✅ ${name} 通过：${checks.passed.length} 项断言${skipNote}，用时 ${seconds}s`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`\n❌ ${name} 失败：${detail}`);
    // ⚠️ undici 的 `fetch failed` 这类错误的**根因在 `err.cause` 链上**（`err.message` 只有四个字，
    //    ECONNRESET / 证书 / 封禁端口全在 cause 里）——2026-10-02 slice-14 首跑实测：结论里只剩
    //    「fetch failed」，根因不可判。只走**失败路径**、有界（≤5 跳）打印，成功路径一个字节不变。
    let cause: unknown = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    for (let depth = 0; cause !== undefined && cause !== null && depth < 5; depth++) {
      const c = cause as Error & { cause?: unknown; code?: unknown };
      const label = cause instanceof Error ? `${c.name}: ${c.message}` : String(cause);
      // eslint-disable-next-line no-console
      console.error(`   ↳ cause：${label}${typeof c.code === 'string' ? ` (${c.code})` : ''}`);
      cause = c.cause;
    }
    if (!(err instanceof ConformanceError) && err instanceof Error && err.stack) {
      // eslint-disable-next-line no-console
      console.error(err.stack);
    }
    process.exitCode = 1;
  }
}

// ⚠️ **R156 的反面**（2026-09-25，CI 首跑实证）：R156 处理的是「事件循环被**吊住** ⇒ 进程永不退出」，
//    而这里处理的是**反过来**的那一半 —— 某个 `await` 若在等待期间**不持有 ref 状态的句柄**，
//    事件循环会**空转** ⇒ Node **自然退出（码 0）且不打印任何结论**，一整片的输出凭空消失。
//    实证：CI 里 `slice-12` 与 `slice-07.4-pipeline` 各只活 **60ms / 65ms**（本机同一条要 74s / 0.3s），
//    日志里只剩标题行 + `[loop] … ⇒ exit 0`。本机（Node 24）**复现不出来** ⇒ 是 Node 20 侧
//    undici 在连接建立前那段窗口的句柄行为差异。
//    ⇒ 用一个 **ref 的**心跳把「main 还没结束」这段时间兜住：循环**永不为空** ⇒ 这类静默消失
//    从原理上不可能再发生。main 一结束就清掉，**不影响** R156 的强制退出。
//    ⚠️ 代价（有意接受）：某个用例**真的吊死**时，过去会「静默 exit 0」，现在会**一直挂着**直到
//    job 的 `timeout-minutes` —— 那是**响亮**的失败，比「绿着退出、什么都没验」好得多。
const keepAlive = setInterval(() => {}, 1_000);
void main().finally(() => {
  clearInterval(keepAlive);
  // R156：**必须显式退出**。用例失败时若泄漏了 socket（例如某个 `startFreshRoom` 在抛出前
  // 已经连上了几条），事件循环会被吊住 ⇒ 本文件只设了 `process.exitCode`、**永不退出** ⇒
  // 门禁**永久卡住**（切片 7.2 实测卡了 693s 直到被 SIGTERM）。`unref()` 让「事件循环本来
  // 就会自然结束」的正常情形不受影响（那时进程先退出），只在被吊住时兜底强制退出。
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
});

/**
 * FTL 管理面 —— 无构建静态页的唯一脚本（片⑦ T12 立页；③ T10 扩为账号登录 + 财务/审计/账号
 * 三视图；风控片 T9 加「风控」视图 + 审计第五页签「风控处置」；支付片 T12 加「支付订单 /
 * 退款审核 / 提现审核」三视图 + 审计第六页签「支付处置」；支付配置管理化片 T10 加「支付渠道」
 * 视图 —— 渠道凭据掩码写，写控件仅 super_admin）。
 *
 * 契约：
 *  - 登录 `POST /api/admin/login {username, password}` ⇒ `{code:0, data:{token, expiresIn:7200,
 *    username, role}}`（③ T10：账号登录；username 为归一后值）；token/username/role 存
 *    `sessionStorage`（**非 cookie** ⇒ 跨站请求天然不携带，CSRF 不适用），此后每个请求带
 *    `Authorization: Bearer <token>`；
 *  - 读 `GET /api/admin/config` ⇒ `{code:0, data:{config:{<key>:{value,version}}, version}}`；
 *  - 写 `PUT /api/admin/config/:key {value}` ⇒ `{code:0, data:{saved:true, announced, version}}`；
 *    非法值 ⇒ 400 + 原因（**服务端是唯一校验点**，本页不校验、只回显原因）。
 *
 * 「风控」视图与审计第五页签（风控片 T9 / 规格 §2.10；四端点 = T6 产物，授权 = 网关 P-r1..r4）：
 *  - `GET  /api/admin/risk/reviews`      —— 审核队列（`status&limit&cursor`，keyset `id DESC`；
 *    响应 `data.{items,nextCursor}`）；
 *  - `GET  /api/admin/risk/users/:userId` —— 详情聚合（stats/设备原文含关联账号/谓词拒绝计数/
 *    条目历史/`accountStatus`/`limitSource`/`bannedFlagPresent`〔终审 F2：孤儿封禁旗态，
 *    驱动 unban 解锁〕；404 借 11004）；
 *  - `POST /api/admin/risk/actions`      —— 五动作（`{userId, action, reviewId?, reason}`；
 *    条目态动作随行 `reviewId` = 提交者看到的条目〔服务端陈旧断言〕；成功 ⇒ 200 `{ok:true}`）；
 *  - `GET  /api/admin/risk/actions(.csv)` —— 审计列表 + CSV 导出（审计第五页签「风控处置」）。
 *  纪律：只按 HTTP status 分流（M1）；动作按钮可用性 = 条目 status / `accountStatus` /
 *  `limitSource` 的 UI 门面（服务端 409 才是权威）；deviceId 同 textContent 纪律。
 *
 * 「支付」三视图与审计第六页签（支付片 T12 / 规格 §2.4.2 + §5；授权 = 网关 P-p1..P-p7——
 * 读面全角色、review/confirm = super_admin|finance）：
 *  - `GET  /api/admin/pay/orders[.csv]?status=&userId=&from=&to=`（JSON 另带 `cursor`，
 *    响应 `data.{items,nextCursor}`）+ `GET /api/admin/pay/orders/:orderNo`（详情含
 *    `notifyLog` 尾 20 条）；
 *  - `GET  /api/admin/pay/refunds[.csv]?status=&userId=` + `/:refundNo`；
 *  - `POST /api/admin/pay/refunds/:refundNo/review` `{action:'approve'|'reject', note?}`；
 *  - `GET  /api/admin/pay/withdrawals[.csv]?status=&userId=` + `/:withdrawNo`（详情含余额/cap
 *    快照读）+ `POST …/review` + `POST …/confirm {voucher≤64, note?}`；
 *  - `GET  /api/admin/pay/actions[.csv]?from=&to=&actor=` —— 审计第六页签「支付处置」。
 *  纪律（规格 §2.4.2 末行 + §5）：
 *  ① actor 取网关 `x-admin-actor` 注入（服务端 reviewed_by/confirmed_by）；页面只按 HTTP
 *     status 分流（M1 同款），409 回显服务端 message（15009 = 状态已变更，含当前态与合法动作）；
 *  ② ⚠️ **退款「通过」是长挂请求**：服务端就地跑渠道退避重试（最长约 12.6 分钟），网关 5 秒
 *     兜底超时可能先回 503（10007）——**服务端仍在继续**；页面提示用户稍后刷新看实际状态；
 *     重复审批由 15009 兜底（不会双退）；
 *  ③ CSV 导出走 `fetch`+`blob` 带 Bearer（同 ③；不能裸 `<a>`）；列表键集 = 服务端严格白名单
 *     （未知键 400），CSV 变体不带 `cursor`；
 *  ④ 一切数据（订单号/原因/凭证/detail…）一律 textContent 渲染；时间一律北京时间。
 *
 * 「支付渠道」视图（支付配置管理化片 T10 / 规格 §2.8；授权 = 网关 P-c1/P-c2 写面仅 super_admin，
 * 读面任意已认证角色落 P8）：
 *  - `GET    /api/admin/pay-channel`              —— 六项键位状态（顺序即响应序；`secret` 键
 *    `value` 恒 null —— 私钥只写不读，仅回指纹 `<12hex>`）；
 *  - `PUT    /api/admin/pay-channel/:key {value}` —— 保存（掩码写；400 回显服务端 message）；
 *  - `DELETE /api/admin/pay-channel/:key`         —— 清空（幂等；未配置时回默认 / 不可用语义）。
 *  纪律：保存 / 清空按钮仅 `super_admin` 渲染（后端 policy 才是真门）；非密键显示明文 + 输入框
 *  留空（不预填值，防误覆盖）；私钥输入 `type=password` 且 placeholder 粘贴友好；
 *  503（缺主钥）⇒「渠道密钥存储未启用（缺主钥）」。
 *
 * 「通知通道」视图（通知通道管理化片 T9 / 规格 §2.8；授权 = 网关写面两条前缀（T8）仅 super_admin，
 * 读面任意已认证角色落 P8）：
 *  - `GET    /api/admin/notify-channel`              —— 九项键位状态（顺序即响应序 = ⚙️1；
 *    密键 `value` 恒 null —— 只写不读，仅回指纹 `<12hex>`；URL 三键附 `hint`）；
 *  - `PUT    /api/admin/notify-channel/:key {value}` —— 保存（掩码写；400 回显服务端 message）；
 *  - `DELETE /api/admin/notify-channel/:key`         —— 清空（幂等；未配置时该通道关闭）。
 *  纪律：两组渲染（邮件（SMTP）5 行 + IM 通道 4 行）；保存 / 清空按钮仅 `super_admin` 渲染；
 *  非密键显示明文 + 输入框留空；`smtp.pass` 输入 `type=password` + `-webkit-text-security:disc`；
 *  组尾完整性提示（邮件通道 / 钉钉通道）客户端算（零新服务端面；IM 组尾只判钉钉两键须成对）。
 *
 * 「广告回调」视图（广告片 T9 / 规格 §2.3；授权 = 网关写面两条前缀 P-a1/P-a2（T8）仅 super_admin，
 * 读面任意已认证角色落 P8）：
 *  - `GET    /api/admin/ad-channel`              —— 唯一键状态（顺序即响应序 = `AD_CHANNEL_KEYS`；
 *    本空间全密键（`AD_CHANNEL_SECRET_KEYS` = 全键）⇒ 掩码读 —— `value` 恒 null，仅回指纹 `<12hex>`）；
 *  - `PUT    /api/admin/ad-channel/:key {value}` —— 保存（掩码写；400 回显服务端 message）；
 *  - `DELETE /api/admin/ad-channel/:key`         —— 清空（幂等；未配置时回调验签不可用）。
 *  纪律：单列表渲染（本空间恰 1 键）；保存 / 清空按钮仅 `super_admin` 渲染；输入框留空
 *  （不预填值，防误覆盖）+ 遮蔽（`type=password` + 行内 `-webkit-text-security:disc`——照
 *  `smtp.pass` 先例）；503（缺主钥）⇒「广告回调密钥存储未启用（缺主钥）」。
 *
 * 「钱包调整」视图（货币核心 T9 / 规格 §2.14 六点，与配置编辑并列、不推倒）：
 *  ① 手机号 → `GET /api/admin/users/lookup?phone=` ⇒ 显示 userId（404 ⇒ 回显「未找到」）；
 *  ② `GET /api/admin/wallet/accounts/:userId` ⇒ 显示当前余额；
 *  ③ ±金额（≠0、|±|≤1,000,000）+ 原因（1..200）→ `POST /api/admin/wallet/adjust`；
 *  ④ actionId 每次填一次表生成一次（`admin:<uuid>`）、**重试时原样复用**（双击保护 +
 *     服务端幂等）；成功或**明确失败**（服务端给了裁决：400/409/401）后换新；
 *     传输失败 / 未知状态**保留 id** ⇒ 原样重试不重复调整；
 *  ⑤ 只按 HTTP status 分流（M1 纪律照抄 —— **绝不读 body.code**）；409 回显服务端 message；
 *  ⑥ 成功 ⇒ 显示「调整后余额」并**刷新 ②**。
 *
 * ③ T10（规格 §2.12）三视图：
 *  - **财务**（全角色）：筛选（source/actor/ownerId 或手机号/时间预设）× 流水表（keyset
 *    「加载更多」；行内「冲正」仅在 `source==='admin_adjust'` 且未冲正且角色为
 *    super_admin/finance 时显示；「详情」展开消费 `GET /api/admin/wallet/ops/:opId` 的
 *    **`data.rows`**（T6 裁定形状：同 join 行数组、含 traceId））+ 汇总卡（按来源/按日 +
 *    totals）+ 机器人池卡（`accounts/robot-pool`）+ 对账面板（四字段 + 「立即对账」）+
 *    导出（CSV 走 `fetch`+`blob` 带 Bearer —— **不能裸 `<a>`**）；
 *  - **审计**（全角色）：六页签（配置变更 / 资金操作＝流水预筛 `source∈{admin_adjust,
 *    admin_reverse}` / 登录事件 / 账号变更 / 风控处置〔风控片 T9〕 / 支付处置〔支付片 T12〕），
 *    各带筛选 + 导出；
 *  - **支付订单 / 退款审核 / 提现审核**（支付片 T12；读面全角色，审核动作按钮 =
 *    super_admin/finance 门面）：详见上方「支付」三段；
 *  - **账号**（super_admin）：表格 + 建号表单 + 行内（改角色下拉、停用/启用、重置口令弹窗）；
 *  - **风控**（风控片 T9；super_admin/operator）：审核队列（status 过滤 + keyset「加载更多」）
 *    + 行内「详情 / 处置」（stats / 设备原文含关联账号 / 谓词拒绝计数 / 条目历史 + 动作条
 *    dismiss/throttle/unthrottle/ban/unban + reason 必填前端第一道）；动作成功/冲突后重拉队列。
 *  - **导航按角色显隐 = 仅 UI 门面**（服务端 policy 才是闸）：配置（super_admin/operator）·
 *    风控（super_admin/operator）· 钱包调整（super_admin/finance）· 财务/审计（全角色）·
 *    支付订单/退款审核/提现审核（全角色；审核动作 = super_admin/finance）· 账号（super_admin）。
 *
 * 🔴 M1：`POST /api/admin/login` 在「管理面未启用（零账号）」时回 **404**，其 body 里的
 *    code 是**借来的 10001**（「路不存在」的既有先例码，见 config-service `admin.controller.ts`
 *    的 notEnabled404）。因此本页**只按 HTTP status 分流、绝不读 code** —— 拿 code 分流的那一天，
 *    「管理面未启用」会在某次码表调整后静默变成「网络错误」。登录五分支：
 *    404 ⇒ 管理面未启用（未创建任何管理员账号）· 401 ⇒ 用户名或口令错误 · **403 ⇒ 账号已停用**
 *    （③ T10 新增）· 429 ⇒ 尝试过于频繁 · 其余状态码通用文案。
 *    （其余端点同规：`body.message` 只作**展示文本**回显，永不参与控制流。）
 *
 * 🔴 输出编码纪律（规格 §2.12）：昵称/手机号/reason/username/detail 等一切数据渲染
 *    **只用 `textContent`**（不拼接 HTML 串）；时间展示 = 北京时间
 *    （`toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })`，⚙️1）。
 *
 * ⚠️ 页面不静态携带**运行期**配置值（R4）：九十二键与它们的值全部在登录后从 API 拉取；
 *    静态备注只含**出厂默认**（见下方 CONFIG_NOTES 注）。
 */
'use strict';

const TOKEN_KEY = 'ftl-admin-token';
/** ③ T10 / ⚙️12：登录成功同时存用户名与角色（导航显隐与「自己」判定用；登出即清）。 */
const USERNAME_KEY = 'ftl-admin-username';
const ROLE_KEY = 'ftl-admin-role';

/** 列表页大小（服务端 `limit` 上限 100；取小值让「加载更多」在真栈联测里可见）。 */
const PAGE_LIMIT = 20;

/**
 * 既有键逐项备注（静态文案；键 → 4 行「作用 / 取值（含默认） / 生效 / 注意」）；
 * **76 个 active 键全覆盖**（2026-10-25 补齐跑得快规则/计分/开关 13 键；无备注条目时展示通用说明）。
 *
 * 真源（逐条可溯源，勿杜撰）：
 *  - 取值域与约束 = `packages/protocol/src/config.ts`（写入校验的唯一真源）；
 *  - 语义 / 默认值 / 消费方 = `docs/design.md` §7.5；跑得快规则/计分键另以
 *    `packages/shared/src/pdk/rules.ts`（默认值）+ 跑得快设计 spec §4.7.1 / §5.6 为准；
 *  - 运维措辞（≤60s 上界 / 好友房默认关 / 30s 无匹配文案）= `docs/ops/first-deploy.md`「怎么改配置」。
 *
 * ⚠️ 与 R4（「页面不含**配置值**」）的口径说明：本表只含**静态说明文案**（出厂默认值随文引用
 *    —— 与 design / 手册同源，非运行期值）；运行期的键与值**仍只在登录后从 API 拉取**。
 * ⚠️ 未知键 ⇒ 不渲染备注块（不报错）：键集合以 API 为准，本表只做展示。
 * ⚠️ 记录片遗留（货币核心 T9 顺带补齐）：`record.retentionDays` 此前缺席 ⇒ 十键对十一键
 *    失配（规格 §4.2 p 的登记项）；补齐后 **11 条对 11 键**；② 金币场加六键后 **17 条对 17 键**；
 *    风控片 T9 加八键后 **25 条对 25 键**；支付配置管理化片 T10 搭车补 pay.* 九键（26–34；D4）后
 *    **34 条对 34 键**；节奏/清理旋钮管理化片 T16 加六键（35–40）后 **40 条对 40 键**；
 *    广告片 T9 加第 41 键（`ad.reliefAdpid`）后 **41 条对 41 键**；
 *    台费片 T8 加第 42 键（`currency.entryFeePercents`）后 **42 条对 42 键**；
 *    客户端接入片 T3 加第 43/44 键、机器人补位开关片加第 45–47 键、提现再认证第 48 键、
 *    设备绑定第 49 键、记牌器第 50 键与两价格第 51/52 键；2026-10-24 配置平行化后
 *    **61 条备注 / 74 个 active 键**；2026-10-25 跑得快风控两键后 **63 条备注 / 76 个 active 键**；
 *    2026-10-25 补齐跑得快规则/计分/开关 13 键后 **76 条备注 / 76 个 active 键（全覆盖）**
 *    （另有 16 个旧键只读、无备注）。
 */
const CONFIG_NOTES = {
  'game.doudizhu.robot.skillDistribution': [
    ['作用', '补位机器人的弱 / 中 / 高抽取比例 —— 玩家匹配时遇到的机器人强度按此分布。'],
    ['取值', '三键齐全 {beginner, intermediate, advanced}，各 ≥ 0，合计须 > 0；可写权重（如 15 / 35 / 50），保存时按合计归一化成占比。默认 0.15 / 0.35 / 0.5。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '难度在机器人入座绑定时抽取 ⇒ 改动只影响之后的补位，已在局中的不受影响。'],
  ],
  'game.doudizhu.robot.ruleFallback': [
    ['作用', 'DouZero（AI 模型服务）不可用时，匹配还补不补机器人 —— 开 ⇒ 照补；关 ⇒ 不补。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开）。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '关 ⇒ 仅当 DouZero 不可用时，匹配玩家等满 30s 收到「当前无匹配的玩家」；只管匹配路径，好友房 / 自动开局与已入座对局不受影响。'],
  ],
  'game.doudizhu.robot.modelBySkill': [
    ['作用', '弱 / 中 / 高三档机器人各用哪个 DouZero 模型（玩家感知为出牌强弱）。'],
    ['取值', '三键齐全 {beginner, intermediate, advanced}；取值只能是 sl / douzero_WP / douzero_ADP。默认 sl / douzero_WP / douzero_ADP。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '模型名逐字写（区分大小写与下划线），其他名字会被拒绝；难度在入座绑定时抽取 ⇒ 改动只影响之后的补位。'],
  ],
  'robot.reclaimIntervalMs': [
    ['作用', '机器人兜底回收的扫描周期 —— 回收闲置超 10 分钟且房间已不存在的机器人（对局中的不回收）。'],
    ['取值', '整数毫秒，0 < n ≤ 600000（上限 10 分钟）。默认 60000（60 秒）。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮起用新值。'],
    ['注意', '改小 = 扫描更频繁（回收更及时）；改大 = 机器人归还更迟。'],
  ],
  'room.matchScanIntervalMs': [
    ['作用', '匹配队列的扫描周期 —— 每轮撮合等待玩家；人数不足则由补位流程兜住（等待窗口 30s）。'],
    ['取值', '整数毫秒，0 < n ≤ 600000（上限 10 分钟）。默认 5000（5 秒）。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮起用新值。'],
    ['注意', '改小 = 撮合更频繁（等待体感更短）；改大 = 玩家可能多等几个扫描周期。'],
  ],
  'room.autostartIntervalMs': [
    ['作用', '手动房（含好友房）自动开局的扫描周期 —— 满座立即开；缺人且越过补位死线 ⇒ 补机器人开。'],
    ['取值', '整数毫秒，0 < n ≤ 600000（上限 10 分钟）。默认 5000（5 秒）。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮起用新值。'],
    ['注意', '只管手动房；匹配局的开局不走这条扫描。改小 = 开局更及时。'],
  ],
  'room.reapIntervalMs': [
    ['作用', '房间回收的扫描周期 —— 清理已结束与等待超时的房间；对局中的房间不回收。'],
    ['取值', '整数毫秒，0 < n ≤ 600000（上限 10 分钟）。默认 60000（60 秒）。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮起用新值。'],
    ['注意', '玩家感知 = 过期房间多快从大厅列表消失；改小 = 回收更勤。'],
  ],
  'game.doudizhu.friendRoomEnabled': [
    ['作用', '好友房总开关。开 ⇒ 大厅显示入口、可创建 / 加入；关 ⇒ 入口隐藏、创建 / 加入被拒（12006「好友房暂未开放」）、房间列表为空。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关）。'],
    ['生效', '保存后服务端秒级生效（推送正常时）、最晚 ≤60s；玩家端进大厅时取新值（已打开的页面刷新一次最快拿到）。'],
    ['注意', '上线要开放好友房 ⇒ 第一件事就是打开它；已在途的好友房不受影响（切换前开的房可正常打完）。'],
  ],
  'game.levels.doudizhu': [
    ['作用', '底分档位表（大厅的底分卡）—— 建房与匹配可选底分都出自这张表。'],
    ['取值', '非空数组，每项 {name, baseScore, entryFeePercent}：name 非空字符串、baseScore 正整数且 ≤ 8191（上限 = 金币金额列 int 的容量上界，超出会被拒绝）、档位值不得重复；entryFeePercent 为 0–100 的整数百分比（0 = 不收台费，100 = 入场费等于底分，缺省即 0）；省略底分时取表内最低档。默认 15 / 80 / 480 / 1200（台费全 0）。'],
    ['生效', '保存后服务端秒级生效（推送正常时）、最晚 ≤60s；玩家端进大厅时取新表（已打开的页面刷新一次最快拿到）。'],
    ['注意', '**台费就在本表第三列**（旧「台费费率表」键已删除）；档位可自由增删（含 15）；省略底分时取表内最低档。改动只影响之后的新开局，已在途房间不受影响。'],
  ],
  'game.levels.paodekuai': [
    ['作用', '跑得快底分档位表（大厅的跑得快底分卡）—— 可选底分与台费都出自这张表；与斗地主档位表相互独立。'],
    ['取值', '非空数组，每项 {name, baseScore, entryFeePercent}：name 非空字符串、baseScore 正整数且 ≤ 8191、档位值不得重复；entryFeePercent 为 0–100 的整数百分比（0 = 不收台费，100 = 入场费等于底分，缺省即 0）；省略底分时取表内最低档。默认 15 / 80 / 480 / 1200（台费全 0）。'],
    ['生效', '保存后服务端秒级生效（推送正常时）、最晚 ≤60s；玩家端进大厅时取新表（已打开的页面刷新一次最快拿到）。'],
    ['注意', '跑得快**不回落**斗地主档位表（`game.levels.doudizhu` 改这里不受影响）；档位可自由增删；改动只影响之后的新开局，已在途房间不受影响。'],
  ],
  'game.doudizhu.cardCounterEnabled': [
    ['作用', '记牌器总开关（客户端）。开 ⇒ 牌桌左上角显示记牌器入口与横条；关 ⇒ 入口不渲染、记牌累积器不启动。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开 —— 保持现状）。'],
    ['生效', '保存后玩家端下次进大厅取到新值；已打开的牌桌不热更新。'],
    ['注意', '客户端软门控：旧版客户端不认识该键，仍会显示记牌器。收费与购买由下面两个价格键控制（另立片）。'],
  ],
  'game.doudizhu.cardCounterPricePerGameCoins': [
    ['作用', '记牌器「单局卡」单价（金币/局）。玩家开局前购买；进入金币场对局时自动消耗 1 张。'],
    ['取值', '整数 0..1,000,000；0 = 该商品隐藏（不售）。默认 10。'],
    ['生效', '保存后玩家端下次进大厅取到新价；改价只影响之后的购买，已购权益不受影响。'],
    ['注意', '仅金币场收费；免费场/好友房不消耗权益。两个价格都为 0 ⇒ 金币场免费（不消费、不显示购买）。旧版客户端仍免费显示。'],
  ],
  'game.doudizhu.cardCounterPricePerHourCoins': [
    ['作用', '记牌器「包时卡」每小时单价（金币/小时）。购买后自购买时刻起顺延；包时内每局不再扣单局卡。'],
    ['取值', '整数 0..1,000,000；0 = 该商品隐藏（不售）。默认 100。'],
    ['生效', '保存后玩家端下次进大厅取到新价；改价只影响之后的购买，已在包时中的玩家不受影响。'],
    ['注意', '仅金币场收费；包时到期判定以服务端数据库时间为准（局中到期不回收本局）。两个价格都为 0 ⇒ 金币场免费。'],
  ],
  'record.retentionDays': [
    ['作用', '对局记录保留天数 —— 超过这么多天的对局会从玩家的「历史战绩」里清掉（库里也删；备份里仍有）。'],
    ['取值', '整数天数，1 ≤ n ≤ 3650。默认 365（一年）。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。清理任务每轮开始时现读该值 ⇒ 当前一轮按旧值跑完，下一轮起用新值。'],
    ['注意', '改小 = 更早的对局记录被删（不可恢复 —— 玩家战绩与库里都消失）；只管对局记录，金币流水与账户余额不受本键影响。'],
  ],
  'currency.signupGrant': [
    ['作用', '注册赠送金币 —— 新玩家注册成功时自动到账的金币数（到账后玩家可在大厅顶栏余额与钱包页看到）。'],
    ['取值', '整数，0 ≤ n ≤ 1000000。默认 0（不赠送）。'],
    ['生效', '只影响之后注册的新用户（注册那一刻取一次快照）；已在册玩家不受影响。'],
    ['注意', '赠送与注册捆在同一条链路上：赠送失败会让这次注册整体失败（玩家可稍后重试；重试不会重复发放）。'],
  ],
  'game.doudizhu.freeRoomEnabled': [
    ['作用', '免费场（随机匹配）开关。开 ⇒ 大厅显示「免费场」入口、可匹配；关 ⇒ 入口隐藏、匹配被拒（12010「该场次暂未开放」）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开 —— 保持现状）。'],
    ['生效', '保存后服务端秒级生效（推送正常时）、最晚 ≤60s；玩家端进大厅时取新值（已打开的页面刷新一次最快拿到）。'],
    ['注意', '与金币场开关（game.doudizhu.goldRoomEnabled）各管一场；两个都关 ⇒ 大厅没有可玩的场次（空态）。'],
  ],
  'game.doudizhu.goldRoomEnabled': [
    ['作用', '金币场开关。开 ⇒ 大厅显示「金币场」入口、可按门槛（余额 ≥ 底分 × entryMultiplier）匹配；关 ⇒ 入口隐藏、匹配被拒（12010「该场次暂未开放」）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（默认开 —— 2026-10-04 用户裁决，原默认关/暗上线）。'],
    ['生效', '保存后服务端秒级生效（推送正常时）、最晚 ≤60s；玩家端进大厅时取新值（已打开的页面刷新一次最快拿到）。'],
    ['注意', '默认开；首次开放前先把机器人虚拟池种上（见手册「虚拟池：种子与充值」）；要暂缓开放 ⇒ 改这里为 false。已在途的金币局不受影响。'],
  ],
  'game.doudizhu.freeBotFillEnabled': [
    ['作用', '免费场「缺人补机器人」开关。开 ⇒ 匹配缺人时等待 30 秒后用机器人补位开局（现状）；关 ⇒ 绝不补机器人，30 秒后给玩家弹「重新匹配 / 继续等待」提示，真人凑齐 3 人才开局。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开 —— 保持现状）。'],
    ['生效', '保存后 room-service 下一轮扫描（≤5s）即按新开关分流。只影响之后的匹配；已在途的局不受影响。'],
    ['注意', '与金币场补位开关（game.doudizhu.goldBotFillEnabled）各管一场；关闭后的最长等待由 room.matchNoBotMaxWaitMs 兜底（到点 12007）；好友房（practice）不受这两个开关管控，缺人仍补机器人。'],
  ],
  'game.doudizhu.goldBotFillEnabled': [
    ['作用', '金币场「缺人补机器人」开关。开 ⇒ 匹配缺人时等待 30 秒后用机器人补位开局（现状）；关 ⇒ 绝不补机器人，30 秒后给玩家弹「重新匹配 / 继续等待」提示，真人凑齐 3 人才开局。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开 —— 保持现状）。'],
    ['生效', '保存后 room-service 下一轮扫描（≤5s）即按新开关分流。只影响之后的匹配；已在途的金币局不受影响。'],
    ['注意', '关闭意味着真人不足时金币局开不起来（玩家持续等待或到上限超时）—— 请结合在线高峰评估；最长等待由 room.matchNoBotMaxWaitMs 兜底。'],
  ],
  'room.matchNoBotMaxWaitMs': [
    ['作用', '补机器人开关**关闭**时，真人匹配的总等待上限（毫秒，自玩家本次入队时刻起算；玩家点「继续等待」只平移提示窗口、不重置本上限）。到点 ⇒ 服务端判匹配超时（12007），玩家出队并收到「匹配超时：当前在线玩家不足，请稍后再试」。'],
    ['取值', '整数毫秒，30000 ≤ n ≤ 1800000（30 秒～30 分钟）。默认 300000（5 分钟）。'],
    ['生效', '保存后 room-service 下一轮扫描（≤5s）即按新值判超时；只影响仍在等待中的票。'],
    ['注意', '仅在免费场/金币场补位开关关闭时有意义；开关开着时走原有 30 秒补位流程，本键不参与。'],
  ],
  'game.doudizhu.entryMultiplier': [
    ['作用', '斗地主金币场入场门槛倍率：入队要求余额 ≥ 所选底分 × 本值（如底分 1200 × 10 = 12,000）。救助门槛已改为平台级 currency.reliefThresholdCoins，不再用本键。'],
    ['取值', '整数，1 ≤ n ≤ 100。默认 10。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。玩家端进大厅时取新值（门槛提示用它）。'],
    ['注意', '改动同时影响门槛与机器人水位（补线 / 目标 / 回收线随 max 底分 × 本值联动）；调高 = 门槛更贵、机器人携带更多钱。'],
  ],
  'game.doudizhu.rakePercent': [
    ['作用', '抽水：从每局赢家的所得里扣一笔归系统（销毁，不进任何账户）—— 调高 = 玩家赢面变小。'],
    ['取值', '整数百分比，0 ≤ n ≤ 50。默认 0（不抽水）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。只影响之后结算的局。'],
    ['注意', '抽水额随结算销毁（可用 currency_flows 按局核对）；本键不对玩家展示。'],
  ],
  'currency.reliefEnabled': [
    ['作用', '每日救助开关。开 ⇒ 余额不足的玩家可在大厅领一笔救助金（每人每天一次）；关 ⇒ 领取入口隐藏、领取被拒（14004「救助暂未开放」）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关）。'],
    ['生效', '保存后 currency-service 秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '发放条件 = 余额 < platform 级绝对门槛 currency.reliefThresholdCoins（够门槛的领不了）；发放走正式账务流水（currency_flows），可核对。'],
  ],
  'currency.reliefAmount': [
    ['作用', '每日救助金额：每次领取发放的金币数。'],
    ['取值', '整数金币，1 ≤ n ≤ 1000000。默认 200（当前平台门槛 150，满足门槛）。'],
    ['生效', '保存后 currency-service 秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '建议 ≥ currency.reliefThresholdCoins，否则领完回不了桌；停发用开关，别把金额改成 0（0 会被拒绝）。'],
  ],
  'risk.predicate.sameDevice': [
    ['作用', '同设备谓词开关 —— 开 ⇒ 撮合该组时两台「同一设备（同一 deviceId）」的账号不同房（防一人多号同桌）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关 —— 暗上线）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。只影响之后的撮合抽取。'],
    ['注意', '开启手顺见运维手册：先开本条观察一周（看「谓词拒绝率」面板与告警），再评估同 IP 谓词；随时可回关。开发 / 探针环境多账号同机 ⇒ 默认关是有意为之。'],
  ],
  'risk.predicate.sameIp': [
    ['作用', '同 IP 谓词开关 —— 开 ⇒ 同一出口 IP 的账号不同房（防同伙同桌；同宽带 / 网吧也有误伤面）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。只影响之后的撮合抽取。'],
    ['注意', '先观察同设备谓词再评估本键；运营商大内网（CGNAT）下大量玩家同 IP ⇒ 开启前先看拒绝率告警，误伤明显就回关。'],
  ],
  'game.doudizhu.risk.winRateThreshold': [
    ['作用', '胜率阈值 —— 扫描命中条件之一：对局局数超过「扫描最少局数」且胜率严格高于本值的账号进 / 更新审核队列。'],
    ['取值', '数字，0.5 ≤ n ≤ 1.0，最多两位小数（如 0.8）。默认 0.8。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。当前一轮扫描按旧值跑完，下一轮起用新值。'],
    ['注意', '两个检测项各记 25 分；≥50 分且「命中自动限流」开时自动进限流档（可自动恢复）。改小 = 更敏感（误报更多）。'],
  ],
  'game.doudizhu.risk.minGames': [
    ['作用', '扫描最少局数 —— 对局局数必须「大于」本值才参与胜率命中判定（防小样本误判）。'],
    ['取值', '整数，1 ≤ n ≤ 100000。默认 100。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。下一轮扫描起用新值。'],
    ['注意', '判定是严格「大于」（恰 100 局不算）；与胜率阈值同属一条命中项，两个条件同时满足才记分。'],
  ],
  'risk.deviceLimit': [
    ['作用', '单账号设备数上限 —— 窗口期内同一账号出现过的不同设备号数超过本值 ⇒ 记一次命中（账号共享 / 租借线索）。'],
    ['取值', '整数，2 ≤ n ≤ 100。默认 3。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。下一轮扫描起用新值。'],
    ['注意', '数据来自匹配入队上报的设备号（玩家可清存储 / 重装漂移 —— 威慑级控制）；改小 = 更敏感。'],
  ],
  'risk.deviceWindowDays': [
    ['作用', '设备计数窗口 —— 「单账号设备数」只统计最近这么多天活跃过的设备行。'],
    ['取值', '整数天数，1 ≤ n ≤ 365。默认 30。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。下一轮扫描起用新值。'],
    ['注意', '窗口放宽会增大共享 / 重装设备的误报面；收紧会漏掉低频使用的账号。'],
  ],
  'risk.autoThrottle': [
    ['作用', '命中自动限流总开关 —— 开 ⇒ 扫描给 50 分及以上的账号自动进限流档（3 次/秒）；关 ⇒ 只进审核队列、等人工处置。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开）。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。下一轮扫描起用新值。'],
    ['注意', '自动动作上限只到限流档（指标回落自动解除）；封禁恒为人工动作（管理页「风控」视图处置）。'],
  ],
  'risk.deviceBindingEnabled': [
    ['作用', '账号设备绑定总开关 —— 开 ⇒ 同一账号只允许在已绑定的一台设备上使用：换设备时 REST 登录 / 注册 / 令牌刷新与 WS 握手**双闸**拒绝（11005「账号已绑定其他设备」），本机继续使用需管理员在「风控」或「玩家」详情里解绑。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关 —— 暗上线）。'],
    ['生效', '保存后 user-service 的 REST 闸秒级读到新值（推送正常时；最晚 ≤60s）；WS 闸不直接读开关 —— 仅开关开时服务端才写 Redis 绑定键，键缺即放行，故关回开关后新登录不再产生 / 校验绑定。'],
    ['注意', '开关开启后，存量玩家首次登录静默绑定当前设备（不拦人）；设备指纹存在客户端本地存储，可被清除或复制，因此本功能是业务级防账号共享、不是强安全边界。解绑入口 = 风控队列「详情 / 处置」或「玩家」详情的设备绑定卡片（解绑写风控审计）。'],
  ],
  'risk.deviceRetentionDays': [
    ['作用', '设备记录保留期 —— 超过这么多天没再出现的设备行会被清理任务删除。'],
    ['取值', '整数天数，1 ≤ n ≤ 3650。默认 365（一年）。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。清理任务每轮现读该值。'],
    ['注意', '改小 = 更早删设备数据（不可恢复；影响「同设备关联账号」的回溯面）；只管设备行，对局记录看 record.retentionDays。'],
  ],
  // 支付配置管理化片 T10 搭车（D4）：支付业务九键（26–34）此前缺席 —— 补齐后 34 条对 34 键；
  // 节奏/清理旋钮管理化片 T16 加六键（35–40）后 40 条对 40 键；广告片 T9 加第 41 键（ad.reliefAdpid）
  // 后 41 条对 41 键；台费片 T8 加第 42 键（currency.entryFeePercents）后 42 条对 42 键；
  // 客户端接入片 T3 加第 43/44 键（client.appEnabled / client.h5Enabled）；机器人补位开关片加第
  // 45–47 键（game.doudizhu.freeBotFillEnabled / game.doudizhu.goldBotFillEnabled / room.matchNoBotMaxWaitMs）后 47 条对 47 键；
  // 提现再认证片加第 48 键（risk.withdrawReAuthEnabled，归「支付与提现 → 提现」）后 48 条对 48 键；
  // 设备绑定片加第 49 键（risk.deviceBindingEnabled，归「风控安全」）后 49 条对 49 键
  // 记牌器片第 50 键 + 两价格第 51/52 键；2026-10-24 配置平行化后 61 条备注 / 74 个 active 键；
  // 2026-10-25 跑得快风控两键后 63 条备注 / 76 个 active 键。

  //（内容源 = protocol/src/config.ts 键注释 + design.md §7.5 行，改写为运营口吻）。
  'pay.rechargeEnabled': [
    ['作用', '充值开关。开 ⇒ 玩家端显示充值入口、可按档位下单；关 ⇒ 新建充值单被拒（15008「充值暂未开放」）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关 —— 暗上线）。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '只挡新建单：在途订单照常支付入账；首次开放前先在「支付渠道」视图把六项凭据配好（缺凭据下单报 15001）。'],
  ],
  'risk.withdrawReAuthEnabled': [
    ['作用', '提现再认证开关 —— 开 ⇒ 玩家点「提现」先弹密码框，输对后换一张一次性票据再提交申请（防手机被他人临时拿去提现）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关 —— 暗上线，行为与改造前一致）。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s。只挡新申请，已提交的不受影响。'],
    ['注意', '开关打开前请先在钱包页自查一次（弹框 → 密码 → 提交）能走通；玩家忘记密码走客服重置，本键不提供跳过入口。'],
  ],
  'pay.withdrawEnabled': [
    ['作用', '提现开关。开 ⇒ 玩家端可提交提现申请；关 ⇒ 新建申请被拒（15003「提现暂不可用（原因）」——原因变体如「功能未开放」「低于门槛」等）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 false（默认关 —— 暗上线）。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '只挡新建申请：在途申请照常可审可确认、超时照常回滚。'],
  ],
  'pay.coinPerYuan': [
    ['作用', '金币/元比率 —— 充值按它折算到账金币（如 100 ⇒ 6 元 = 600 金币），提现按它把金币折算成元。'],
    ['取值', '整数金币/元，1 ≤ n ≤ 1000000。默认 100。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s。充值下单时取一次快照。'],
    ['注意', '改动只影响之后的新单；在途订单按旧快照入账 / 折算（不追溯）。'],
  ],
  'pay.rechargePackages': [
    ['作用', '充值档位表（单位：元）—— 玩家端充值区展示的档位；下单只接受表内档位。'],
    ['取值', '非空数组，每项为唯一正整数（元）且 ≤ 9999999；如 [6,30,68,128,328]。默认 6 / 30 / 68 / 128 / 328。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s；玩家端进充值区时取新表。'],
    ['注意', '下单携带的档位不在表内 ⇒ 被拒（10001）；已下订单不受影响（可继续支付）。'],
  ],
  'pay.withdrawMinCoins': [
    ['作用', '提现门槛金币 —— 单笔申请的金币数 ≥ 本值才可提交。'],
    ['取值', '整数，1 ≤ n ≤ 1000000。默认 1000。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '不足门槛 ⇒ 申请被拒（15003）；本值是下限，单笔 / 单日上限见下面两键。'],
  ],
  'pay.withdrawMaxCoinsPerOrder': [
    ['作用', '单笔提现上限金币。'],
    ['取值', '整数，1 ≤ n ≤ 1000000。默认 50000。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '超过 ⇒ 申请被拒（15004）。'],
  ],
  'pay.withdrawDailyMaxCoins': [
    ['作用', '单日/人提现上限金币 —— 按北京时间自然日累计（含在途申请）。'],
    ['取值', '整数，1 ≤ n ≤ 1000000。默认 100000。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '当日累计 + 本笔超上限 ⇒ 申请被拒（15004）；驳回 / 超时回滚 / 失败的单不计入当日累计。'],
  ],
  'pay.orderExpireMinutes': [
    ['作用', '充值订单有效期（分钟）—— 超时未支付的订单自动关闭、支付链接失效。'],
    ['取值', '整数，1 ≤ n ≤ 10080（一周）。默认 30。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s；下单时取一次快照。'],
    ['注意', '改小 = 链接更快失效（未付订单需重新下单）；在途订单按各自快照到期。'],
  ],
  'pay.withdrawTimeoutMinutes': [
    ['作用', '提现超时回滚（分钟）—— 申请提交后超过本时限仍未完成打款，服务端自动回滚（冻结金币退回玩家余额）。'],
    ['取值', '整数，1 ≤ n ≤ 10080（一周）。默认 4320（=72 小时）。'],
    ['生效', '保存后 payment-service 秒级生效（推送正常时）；最晚 ≤60s；提交申请时取一次快照（超时时刻随之下发）。'],
    ['注意', '超时窗口从提交申请起算（含审核期）；回滚后订单转「超时回滚」（管理页「提现审核」可见）——要打款须在超时前完成「登记打款」。'],
  ],
  // 节奏/清理旋钮管理化片 T16：六键（35–40）—— 内容源 = protocol/src/config.ts 键注释 + design.md §7.5 行；
  // 间隔类语义 = 排期处现读（已排定的一轮不撤，改动自下一轮排期起用新值）。
  'pay.scanIntervalMs': [
    ['作用', '支付扫描周期 —— 八条补偿循环（过期关闭 / 主动补单 / 入账重试 / 提现解冻与超时回滚 / 退款解冻回滚与未知结果重放）的统一节奏。'],
    ['取值', '整数毫秒，1 ≤ n ≤ 600000（上限 10 分钟）。默认 60000（60 秒）。'],
    ['生效', '保存后 payment-service 秒级读到新值（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮排期起用新值。'],
    ['注意', '改小 = 补偿更及时；改大 = 卡住的单收敛更迟。'],
  ],
  'pay.reconcileIntervalMs': [
    ['作用', '支付日自检周期 —— 入账勾稽 + 锚勾稽（钱的事故面第一道铃）。'],
    ['取值', '整数毫秒，1 ≤ n ≤ 864000000（上限 10 天）。默认 86400000（24 小时）。'],
    ['生效', '保存后 payment-service 秒级读到新值（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮排期起用新值。'],
    ['注意', '启动后 30s 照跑首轮。'],
  ],
  'currency.reconcileIntervalMs': [
    ['作用', '货币对账周期 —— 账实相符 / 缓存漂移自愈 / 孤儿诊断。'],
    ['取值', '整数毫秒，1 ≤ n ≤ 36000000（上限 10 小时）。默认 3600000（1 小时）。'],
    ['生效', '保存后 currency-service 秒级读到新值（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮排期起用新值。'],
    ['注意', '启动后 10s 首跑。'],
  ],
  'risk.scanIntervalMs': [
    ['作用', '风控扫描周期 —— 内置闸 + 双谓词判定。'],
    ['取值', '整数毫秒，1 ≤ n ≤ 36000000（上限 10 小时）。默认 3600000（1 小时）。'],
    ['生效', '保存后 user-service 秒级读到新值（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮排期起用新值。'],
    ['注意', '启动后 30s 首轮；多实例有锁。'],
  ],
  'risk.devicesCleanupIntervalMs': [
    ['作用', '风控设备记录清理周期 —— 按保留期批删过期的设备行。'],
    ['取值', '整数毫秒，1 ≤ n ≤ 36000000（上限 10 小时）。默认 3600000（1 小时）。'],
    ['生效', '保存后 user-service 秒级读到新值（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮排期起用新值。'],
    ['注意', '按 risk.deviceRetentionDays 保留期批删。'],
  ],
  'record.cleanupIntervalMs': [
    ['作用', '对局记录保留期清理周期 —— 按保留期批删过期对局记录。'],
    ['取值', '整数毫秒，1 ≤ n ≤ 36000000（上限 10 小时）。默认 3600000（1 小时）。'],
    ['生效', '保存后 user-service 秒级读到新值（推送正常时）；最晚 ≤60s。当前一轮按旧值跑完，下一轮排期起用新值。'],
    ['注意', '保留天数在 record.retentionDays 单独调。'],
  ],
  'ad.reliefAdpid': [
    ['作用', '救助广告位 ID（App 端激励视频）—— 填了它且救助开关（currency.reliefEnabled）打开时，「看广告领救助」才可用。'],
    ['取值', '字母数字字符串 ≤32 位；以带引号字符串输入（如 "abc123"）；空串（""）= 未配置 ⇒ 入口关闭。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '与 uni-ad 后台申请的广告位 ID 逐字一致；换广告位 = 改此键即生效（在途观看按旧凭证锚发放，不双发）。'],
  ],
  'client.appEnabled': [
    ['作用', 'App 端准入闸（整端拦截；拦新不踢旧）—— 关 ⇒ 带 App 端标识的请求被拒（10008「当前客户端已暂停服务，请稍后再试或更换客户端」）；HTTP 与实时连接同拦。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开 —— 暗上线全开）。'],
    ['生效', '保存后 api-gateway 秒级生效（推送正常时）；最晚 ≤60s（安全网兜底）。'],
    ['注意', '软开关（非安全边界）：未带端标识的请求永远放行 —— 存量 App（v1.13.7 及更早）无标识头 ⇒ 不受控，靠升级收敛。'],
  ],
  'client.h5Enabled': [
    ['作用', 'H5 端准入闸（整端拦截；拦新不踢旧）—— 关 ⇒ 带 H5 端标识的请求被拒（10008「当前客户端已暂停服务，请稍后再试或更换客户端」）；HTTP 与实时连接同拦。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开 —— 暗上线全开）。'],
    ['生效', '保存后 api-gateway 秒级生效（推送正常时）；最晚 ≤60s（安全网兜底）。'],
    ['注意', '软开关（非安全边界）：未带端标识的请求永远放行 —— 缓存/未刷新的旧 H5 页面（旧 bundle 无标识头）不受控 ⇒ 验证「关 h5 生效」须硬刷新或新开页。'],
  ],
  'game.doudizhu.enabled': [
    ['作用', '斗地主总开关 —— 关 ⇒ 新的匹配入队 / 新建房被拒（12012）；进行中的对局与已有房间不受影响。'],
    ['取值', '严格 true / false。默认 true（保持现状）。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '两个玩法都关闭时大厅没有可选玩法；关闭期间已入队的票保留，重新开放后继续匹配。'],
  ],
  'game.paodekuai.enabled': [
    ['作用', '跑得快总开关 —— 关 ⇒ 新的匹配入队 / 新建房被拒（12012）；进行中的对局与已有房间不受影响。'],
    ['取值', '严格 true / false。默认 false（暗上线）。'],
    ['生效', '保存后各服务秒级生效（推送正常时）；最晚 ≤60s。'],
    ['注意', '两个玩法都关闭时大厅没有可选玩法；关闭期间已入队的票保留，重新开放后继续匹配。'],
  ],
  'game.paodekuai.bareTrioEnabled': [
    ['作用', '裸三张（三张同点、不带牌）是否可作为合法牌型打出。关 ⇒ 三张同点只能带牌出（三带一；三带二另看开关）或拆开打。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（开）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '客户端「提示」与机器人使用同一份规则快照，关掉后不会再给出裸三张；四张 A 在跑得快牌堆里不存在（缺黑桃 A）⇒ 三张 A 只按本开关处理。'],
  ],
  'game.paodekuai.trioWithPairEnabled': [
    ['作用', '三带二（三张同点 + 一对）是否合法。'],
    ['取值', '严格 true / false。默认 false（关 —— 只允许三带一）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '三带一与三带二是不同牌型（长度不同），不能互相压；关掉后 3+2 只能拆成三张与对子分别处理。'],
  ],
  'game.paodekuai.bareAirplaneEnabled': [
    ['作用', '裸飞机（≥2 个连续三张、不带翅膀）是否合法。'],
    ['取值', '严格 true / false。默认 false（关 —— 飞机必须带翅膀）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '关裸飞机时，连续三张必须带翅膀（翅膀口径见「飞机翅膀」键）或拆开出；不能把相邻的第 4 个三张拆成翅膀来凑飞机。'],
  ],
  'game.paodekuai.fourWithTwoEnabled': [
    ['作用', '四带二（四张同点 + 2 张带牌）是否合法。'],
    ['取值', '严格 true / false。默认 true（开）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '带牌默认必须是不同点单牌（能否带对子另看「四带二允许对子」键）；四张同点当炸弹还是四带二由玩家选择，只有**裸四张**计入炸弹数与炸弹翻倍。'],
  ],
  'game.paodekuai.fourWithTwoPairKickerAllowed': [
    ['作用', '四带二的两张带牌是否允许同点成对。开 ⇒ 可带一对；关 ⇒ 必须两张不同点单牌。'],
    ['取值', '严格 true / false。默认 false（只允许不同点单牌）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '仅在「四带二」开放时有意义；开「四带二」本身不等于开本键。'],
  ],
  'game.paodekuai.airplaneWings': [
    ['作用', '飞机带翅膀的翅膀口径 —— 翅膀与主三张的搭配方式。'],
    ['取值', "'pairs' = 恰 n 个对子（默认）；'singles' = 恰 n 张不同点单牌；'both' = 先按对子解析、失败再按单牌解析。逐字填写（区分大小写），其它值会被拒绝。"],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '翅膀不能与三张同点、翅膀之间点数互不相同；飞机带单与飞机带对是不同形状，不能互压；both 模式下按实际解析出的形状比较。'],
  ],
  'game.paodekuai.bombMultiplierEnabled': [
    ['作用', '炸弹是否参与翻倍 —— 每打出一枚裸四张炸弹，结算倍数 ×2（多枚累乘）。'],
    ['取值', '严格 true / false。默认 true（开）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '只统计**裸四张**炸弹；四带二与三张同点不计；与关牌 / 春天叠乘后再由「倍数封顶」键夹住。'],
  ],
  'game.paodekuai.guanMultiplierEnabled': [
    ['作用', '关牌是否 ×2 —— 结算时只要有输家一张牌都没出（playedCount = 0）即成立。'],
    ['取值', '严格 true / false。默认 true（开）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '春天成立时关牌必然成立 ⇒ 两项会叠乘（春天合计 ×4）；不想叠乘可关本键或春天键之一。'],
  ],
  'game.paodekuai.springMultiplierEnabled': [
    ['作用', '春天是否 ×2 —— 3/4 人局里所有输家一张牌都没出。'],
    ['取值', '严格 true / false。默认 true（开）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '2 人局不适用；春天成立时关牌必然成立，两项叠乘（合计 ×4）。'],
  ],
  'game.paodekuai.multiplierCap': [
    ['作用', '结算倍数封顶 —— 炸弹 × 关牌 × 春天叠乘后的总倍数上限。'],
    ['取值', '整数 1 ≤ n ≤ 1024。默认 64。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '封顶只夹结算倍数，不影响能否出炸弹；调小可收紧爆分。'],
  ],
  'game.paodekuai.baobenEnabled': [
    ['作用', '保本 —— 输家中「手牌只剩 1 张」的人本局付 0。'],
    ['取值', '严格 true / false。默认 true（开）。'],
    ['生效', '保存后 room-service 秒级生效（推送正常时）；最晚 ≤60s。规则在**开局时**写入本局快照 ⇒ 只影响之后的新开局，进行中的对局不受影响。'],
    ['注意', '所有输家都保本时赢家本局所得为 0（对局记录照写）；与倍数无关（直接免单）。'],
  ],
  'game.paodekuai.nonThreePlayerEnabled': [
    ['作用', '是否对生产开放跑得快的 2/4 人匹配与建房。开 ⇒ 服务端按 2/3/4 人受理、客户端可选人数随之放开；关 ⇒ 只允许 3 人（其它人数 12012）。'],
    ['取值', '严格 true / false。默认 false（生产只开 3 人；引擎与测试始终支持 2/4 人）。'],
    ['生效', '保存后服务端秒级生效（推送正常时）；最晚 ≤60s。已有房间与进行中的对局不受影响。'],
    ['注意', '玩家端首版仍按 3 人发起匹配；开放前确认结算 / 记录 / 机器人的 2/4 人链路已上线。'],
  ],
  'game.paodekuai.freeRoomEnabled': [
    ['作用', '跑得快免费场开关。开 ⇒ 大厅的跑得快玩法显示「免费场」、可匹配；关 ⇒ 该场次隐藏、匹配被拒（12010）。'],
    ['取值', '严格 true / false（字符串 "true" 不算）。默认 true（保守灰度：先开放免费场）。'],
    ['生效', '保存后 room-service 下一轮扫描即生效；玩家端进大厅时取新值。'],
    ['注意', '与金币场、好友房开关各自独立；三个都关 ⇒ 大厅不显示跑得快玩法卡。'],
  ],
  'game.paodekuai.goldRoomEnabled': [
    ['作用', '跑得快金币场开关。开 ⇒ 显示「金币场」、可按门槛匹配；关 ⇒ 该场次隐藏、匹配被拒（12010）。'],
    ['取值', '严格 true / false。默认 false（保守灰度：先不碰真钱）。'],
    ['生效', '保存后 room-service 下一轮扫描即生效；玩家端进大厅时取新值。'],
    ['注意', '开放前先确认机器人资金池已种好；已在途的金币局不受影响。'],
  ],
  'game.paodekuai.friendRoomEnabled': [
    ['作用', '跑得快好友房开关。开 ⇒ 显示好友房入口、可创建/加入；关 ⇒ 入口隐藏、创建/加入被拒（12006）、列表为空。'],
    ['取值', '严格 true / false。默认 false。'],
    ['生效', '保存后 room-service 秒级生效；玩家端进大厅/玩法页时取新值。'],
    ['注意', '只影响跑得快；斗地主好友房用 game.doudizhu.friendRoomEnabled。'],
  ],
  'game.paodekuai.freeBotFillEnabled': [
    ['作用', '跑得快免费场缺人时是否补机器人。开 ⇒ 等待 30 秒后补位开局；关 ⇒ 只等真人，到上限 12007。'],
    ['取值', '严格 true / false。默认 true。'],
    ['生效', '保存后 room-service 下一轮扫描（≤5s）生效。'],
    ['注意', '跑得快机器人是规则机器人，不依赖 DouZero 模型。'],
  ],
  'game.paodekuai.goldBotFillEnabled': [
    ['作用', '跑得快金币场缺人时是否补机器人。语义同免费场补位。'],
    ['取值', '严格 true / false。默认 true。'],
    ['生效', '保存后 room-service 下一轮扫描（≤5s）生效。'],
    ['注意', '金币场开放前先确认机器人资金池；关掉后真人不足时金币局开不起来。'],
  ],
  'game.paodekuai.rakePercent': [
    ['作用', '跑得快金币场结算抽水：从赢家所得扣一笔销毁。'],
    ['取值', '整数百分比，0 ≤ n ≤ 50。默认 0。'],
    ['生效', '保存后 room-service 秒级生效；只影响之后结算的局。'],
    ['注意', '与斗地主抽水各自独立；抽水额可用 currency_flows 按局核对。'],
  ],
  'game.paodekuai.entryMultiplier': [
    ['作用', '跑得快金币场入场门槛倍率：余额 ≥ 所选底分 × 本值。'],
    ['取值', '整数，1 ≤ n ≤ 100。默认 10。'],
    ['生效', '保存后 room-service 秒级生效；玩家端进大厅时取新值。'],
    ['注意', '同时影响跑得快机器人水位（该玩法最高档 × 本值）；与斗地主门槛独立。'],
  ],
  'game.paodekuai.risk.winRateThreshold': [
    ['作用', '跑得快胜率阈值 —— 跑得快对局局数超过「扫描最少局数」且胜率严格高于本值的账号进 / 更新风控审核队列。'],
    ['取值', '数字，0.5 ≤ n ≤ 1.0，最多两位小数（如 0.8）。默认 0.8。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。当前一轮扫描按旧值跑完，下一轮起用新值。'],
    ['注意', '与斗地主阈值各自独立；两个玩法同时命中只记一项胜率分（25），不叠加；跑得快没有对局记录时不参与判定。自动限流仍看 50 分（胜率一项 + 设备一项才到 50）。2/4 人局胜率期望与 3 人不同，可按实际调整。'],
  ],
  'game.paodekuai.risk.minGames': [
    ['作用', '跑得快扫描最少局数 —— 跑得快对局局数必须「大于」本值才参与胜率命中判定（防小样本误判）。'],
    ['取值', '整数，1 ≤ n ≤ 100000。默认 100。'],
    ['生效', '保存后 user-service 秒级生效（推送正常时）；最晚 ≤60s。下一轮扫描起用新值。'],
    ['注意', '判定是严格「大于」（恰 100 局不算）；与跑得快胜率阈值同属一条命中项，两个条件同时满足才记分；与斗地主最少局数独立。'],
  ],
  'currency.reliefThresholdCoins': [
    ['作用', '每日广告救助的平台级绝对门槛：余额低于该金币数才能领取。'],
    ['取值', '整数金币，1 ≤ n ≤ 1,000,000。默认 150（迁移时按旧档位最低档 × 旧门槛倍率现算）。'],
    ['生效', '保存后 currency-service 秒级生效；最晚 ≤60s。'],
    ['注意', '不随任何玩法档位/倍率变化；缺失/坏值 ⇒ 救助端点 fail-closed（503），客户端回退旧算法。'],
  ],
};


/**
 * 配置中心 IA 归属表（1a 纯展示映射；键集合真源仍是 GET /api/admin/config 快照与
 * protocol CONFIG_KEYS，本表不参与校验/保存，只决定键出现在哪个域/页签）。
 * 归属原则：跟「怎么组局/打什么牌/对手是谁」绑定的归玩法；跟「钱/安全/留存/商业化」
 * 绑定的归通用设置。2026-10-24 配置平行化后，场次/好友房/补位/金币经济/风控胜率
 * 均已按玩法分域（斗地主、跑得快各读各的键）；旧平台键只读、不出现在本表。
 * 2026-10-25：跑得快风控两键（`game.paodekuai.risk.*`）进入 pdk 域「风控检测」页签。
 * `record.retentionDays` / `cleanupIntervalMs` 同时作用于两玩法记录表，保留在通用设置。
 * 快照中存在但本表未收录的键 ⇒ 自动落入「未分组」桶（见 ungroupedKeys）。
 */
const LEGACY_CONFIG_KEYS = [
  'room.freeRoomEnabled',
  'room.goldRoomEnabled',
  'room.friendRoomEnabled',
  'room.freeBotFillEnabled',
  'room.goldBotFillEnabled',
  'currency.rakePercent',
  'currency.entryMultiplier',
  'game.baseScoreLevels',
  'game.cardCounterEnabled',
  'game.cardCounterPricePerGameCoins',
  'game.cardCounterPricePerHourCoins',
  'robot.skillDistribution',
  'robot.ruleFallback',
  'robot.modelBySkill',
  'risk.winRateThreshold',
  'risk.minGames',
];
const LEGACY_KEY_SET = new Set(LEGACY_CONFIG_KEYS);

const CONFIG_IA = [
  {
    group: '玩法',
    domains: [
      {
        id: 'ddz',
        name: '斗地主',
        headerKeys: ['game.doudizhu.enabled'],
        tabs: [
          { id: 'rules', name: '玩法规则', keys: ['game.levels.doudizhu'] },
          {
            id: 'assist',
            name: '对局辅助',
            keys: [
              'game.doudizhu.cardCounterEnabled',
              'game.doudizhu.cardCounterPricePerGameCoins',
              'game.doudizhu.cardCounterPricePerHourCoins',
            ],
          },
          {
            id: 'rooms',
            name: '场次开关',
            keys: [
              'game.doudizhu.freeRoomEnabled',
              'game.doudizhu.goldRoomEnabled',
              'game.doudizhu.friendRoomEnabled',
              'game.doudizhu.freeBotFillEnabled',
              'game.doudizhu.goldBotFillEnabled',
            ],
          },
          {
            id: 'robots',
            name: 'AI 机器人',
            keys: [
              'game.doudizhu.robot.skillDistribution',
              'game.doudizhu.robot.ruleFallback',
              'game.doudizhu.robot.modelBySkill',
            ],
          },
          {
            id: 'goldEconomy',
            name: '金币场经济',
            keys: ['game.doudizhu.entryMultiplier', 'game.doudizhu.rakePercent'],
          },
          {
            id: 'ddzRisk',
            name: '风控检测',
            keys: ['game.doudizhu.risk.winRateThreshold', 'game.doudizhu.risk.minGames'],
          },
        ],
      },
      {
        id: 'pdk',
        name: '跑得快',
        headerKeys: ['game.paodekuai.enabled'],
        tabs: [
          {
            id: 'rules',
            name: '玩法规则',
            keys: [
              'game.levels.paodekuai',
              'game.paodekuai.bareTrioEnabled',
              'game.paodekuai.trioWithPairEnabled',
              'game.paodekuai.bareAirplaneEnabled',
              'game.paodekuai.fourWithTwoEnabled',
              'game.paodekuai.fourWithTwoPairKickerAllowed',
              'game.paodekuai.airplaneWings',
            ],
          },
          {
            id: 'scoring',
            name: '计分',
            keys: [
              'game.paodekuai.bombMultiplierEnabled',
              'game.paodekuai.guanMultiplierEnabled',
              'game.paodekuai.springMultiplierEnabled',
              'game.paodekuai.multiplierCap',
              'game.paodekuai.baobenEnabled',
            ],
          },
          {
            id: 'switches',
            name: '开关',
            keys: ['game.paodekuai.nonThreePlayerEnabled'],
          },
          {
            id: 'rooms',
            name: '场次开关',
            keys: [
              'game.paodekuai.freeRoomEnabled',
              'game.paodekuai.goldRoomEnabled',
              'game.paodekuai.friendRoomEnabled',
              'game.paodekuai.freeBotFillEnabled',
              'game.paodekuai.goldBotFillEnabled',
            ],
          },
          {
            id: 'goldEconomy',
            name: '金币场经济',
            keys: ['game.paodekuai.entryMultiplier', 'game.paodekuai.rakePercent'],
          },
          {
            id: 'risk',
            name: '风控检测',
            keys: [
              'game.paodekuai.risk.winRateThreshold',
              'game.paodekuai.risk.minGames',
            ],
          },
        ],
      },
    ],
  },
  {
    group: '通用设置',
    domains: [
      {
        id: 'currency',
        name: '货币经济',
        tabs: [
          {
            id: 'economy',
            name: '经济参数',
            keys: ['currency.signupGrant', 'currency.reconcileIntervalMs'],
          },
          {
            id: 'relief',
            name: '每日救助',
            keys: [
              'currency.reliefEnabled',
              'currency.reliefAmount',
              'currency.reliefThresholdCoins',
            ],
          },
        ],
      },
      {
        id: 'pay',
        name: '支付与提现',
        tabs: [
          {
            id: 'recharge',
            name: '充值',
            keys: ['pay.rechargeEnabled', 'pay.coinPerYuan', 'pay.rechargePackages'],
          },
          {
            id: 'withdraw',
            name: '提现',
            keys: [
              'risk.withdrawReAuthEnabled',
              'pay.withdrawEnabled',
              'pay.withdrawMinCoins',
              'pay.withdrawMaxCoinsPerOrder',
              'pay.withdrawDailyMaxCoins',
              'pay.withdrawTimeoutMinutes',
            ],
          },
          {
            id: 'orders',
            name: '订单与节奏',
            keys: ['pay.orderExpireMinutes', 'pay.scanIntervalMs', 'pay.reconcileIntervalMs'],
          },
        ],
      },
      {
        id: 'risk',
        name: '风控安全',
        tabs: [
          {
            id: 'detect',
            name: '检测规则',
            keys: ['risk.deviceLimit', 'risk.deviceWindowDays'],
          },
          {
            id: 'predicate',
            name: '谓词与处置',
            keys: ['risk.predicate.sameDevice', 'risk.predicate.sameIp', 'risk.autoThrottle'],
          },
          {
            id: 'binding',
            name: '设备绑定',
            keys: ['risk.deviceBindingEnabled'],
          },
          {
            id: 'data',
            name: '数据与扫描',
            keys: ['risk.deviceRetentionDays', 'risk.scanIntervalMs', 'risk.devicesCleanupIntervalMs'],
          },
          {
            id: 'clientGate',
            name: '客户端接入',
            keys: ['client.appEnabled', 'client.h5Enabled'],
          },
        ],
      },
      {
        id: 'dataAds',
        name: '广告',
        tabs: [
          {
            id: 'all',
            name: '广告位',
            keys: ['ad.reliefAdpid'],
          },
        ],
      },
      {
        id: 'roomOps',
        name: '房间与机器人',
        tabs: [
          {
            id: 'pace',
            name: '房间节奏',
            keys: [
              'room.matchScanIntervalMs',
              'room.autostartIntervalMs',
              'room.reapIntervalMs',
              'room.matchNoBotMaxWaitMs',
            ],
          },
          {
            id: 'reclaim',
            name: '机器人回收',
            keys: ['robot.reclaimIntervalMs'],
          },
        ],
      },
      {
        id: 'records',
        name: '对局记录',
        tabs: [
          {
            id: 'all',
            name: '保留与清理',
            keys: ['record.retentionDays', 'record.cleanupIntervalMs'],
          },
        ],
      },
    ],
  },
];

/** 展平后的域列表（带 group 名）。 */
const IA_DOMAINS = CONFIG_IA.flatMap((g) => g.domains.map((d) => ({ ...d, group: g.group })));

/**
 * 玩法开关键的**默认值**（缺键/未加载时按它显示；键集合必须与 IA 的 headerKeys 一致）。
 * 只此一份 —— 不要在 buildGameHeader 里另写三元表达式。
 */
const GAME_SWITCH_DEFAULTS = {
  'game.doudizhu.enabled': true,
  'game.paodekuai.enabled': false,
};

/** IA 中所有玩法域的 headerKeys（顶部开关键的全局清单）。 */
const GAME_SWITCH_KEYS = IA_DOMAINS.flatMap((d) => d.headerKeys ?? []);

/**
 * 关闭一个玩法后，是否已经**没有任何**开放玩法（用于确认文案的加强提示）。
 * 纯函数（全部输入走参数）—— 静态闸用 vm 执行它做行为自证。
 */
function lastEnabledGameWarning(currentConfig, targetKey, defaults, headerKeys) {
  return headerKeys
    .filter((k) => k !== targetKey)
    .every((k) => (k in currentConfig ? currentConfig[k].value : defaults[k]) === false);
}

/** IA 表收录的全部键（用于求未分组差集；含玩法域的顶部开关键）。 */
const IA_KEY_SET = new Set(
  IA_DOMAINS.flatMap((d) => [...(d.headerKeys ?? []), ...d.tabs.flatMap((t) => t.keys)]),
);
/** 快照表外键的虚拟域（计数 0 时不渲染）。 */
const UNGROUPED_DOMAIN_ID = '__ungrouped';
const DEFAULT_CFG_UI = () => ({ domainId: 'ddz', query: '' });

/**
 * 左树配置叶 id ⇄ IA 域 id（HTML 静态树用固定叶 id；IA 表保留源生域 id）。
 * 顺序 = 左树渲染序；末项 = 动态「未分组」叶（计数 0 时隐藏）。
 * 2026-10-21：客户端接入已并入 risk 域页签，独立叶删除（5+1 叶）。
 */
const CFG_NAV = [
  { leaf: 'nav-cfg-ddz-btn', count: 'nav-count-ddz', domain: 'ddz' },
  { leaf: 'nav-cfg-pdk-btn', count: 'nav-count-pdk', domain: 'pdk' },
  { leaf: 'nav-cfg-economy-btn', count: 'nav-count-economy', domain: 'currency' },
  { leaf: 'nav-cfg-paycfg-btn', count: 'nav-count-paycfg', domain: 'pay' },
  { leaf: 'nav-cfg-riskcfg-btn', count: 'nav-count-riskcfg', domain: 'risk' },
  { leaf: 'nav-cfg-dataad-btn', count: 'nav-count-dataad', domain: 'dataAds' },
  { leaf: 'nav-cfg-ungrouped-btn', count: 'nav-count-ungrouped', domain: UNGROUPED_DOMAIN_ID },
];

/**
 * v2.1 简单键控件定稿表（71 键；其余 5 键由结构化编辑器承接，见 STRUCT_KEYS）。
 * type：'bool' 开关 | 'number' 数字行 | 'text' 文本行；suffix 仅当 CONFIG_NOTES
 * 「取值」原文有量词时出现（无量词不给后缀，范围由详情行展示，勿臆造）。
 * label = 行卡片中文短名（效果图评审基线，改名须同步改方案与探针）。
 */
const CONFIG_CONTROLS = {
  // 斗地主（13 简单键；档位/机器人三键是结构化键）
  'game.doudizhu.freeRoomEnabled': { label: '免费场', type: 'bool' },
  'game.doudizhu.goldRoomEnabled': { label: '金币场', type: 'bool' },
  'game.doudizhu.friendRoomEnabled': { label: '好友房', type: 'bool' },
  'game.doudizhu.freeBotFillEnabled': { label: '免费场缺人补机器人', type: 'bool' },
  'game.doudizhu.goldBotFillEnabled': { label: '金币场缺人补机器人', type: 'bool' },
  'game.doudizhu.cardCounterEnabled': { label: '记牌器', type: 'bool' },
  'game.doudizhu.robot.ruleFallback': { label: '模型故障兜底补人', type: 'bool' },
  'game.doudizhu.entryMultiplier': { label: '入场门槛倍率', type: 'number', suffix: '倍' },
  'game.doudizhu.rakePercent': { label: '抽水比例', type: 'number', suffix: '%' },
  'game.doudizhu.cardCounterPricePerGameCoins': { label: '记牌器单局价', type: 'number', suffix: '金币/局' },
  'game.doudizhu.cardCounterPricePerHourCoins': { label: '记牌器包时价', type: 'number', suffix: '金币/小时' },
  'game.doudizhu.risk.winRateThreshold': { label: '胜率阈值', type: 'number', step: 0.01 },
  'game.doudizhu.risk.minGames': { label: '扫描最少局数', type: 'number' },
  // 跑得快（22 简单键；档位表是结构化键）
  'game.paodekuai.freeRoomEnabled': { label: '免费场', type: 'bool' },
  'game.paodekuai.goldRoomEnabled': { label: '金币场', type: 'bool' },
  'game.paodekuai.friendRoomEnabled': { label: '好友房', type: 'bool' },
  'game.paodekuai.freeBotFillEnabled': { label: '免费场缺人补机器人', type: 'bool' },
  'game.paodekuai.goldBotFillEnabled': { label: '金币场缺人补机器人', type: 'bool' },
  'game.paodekuai.entryMultiplier': { label: '入场门槛倍率', type: 'number', suffix: '倍' },
  'game.paodekuai.rakePercent': { label: '抽水比例', type: 'number', suffix: '%' },
  'game.paodekuai.risk.winRateThreshold': { label: '胜率阈值', type: 'number', step: 0.01 },
  'game.paodekuai.risk.minGames': { label: '扫描最少局数', type: 'number' },
  'game.paodekuai.enabled': { label: '跑得快总开关', type: 'bool' },
  'game.paodekuai.nonThreePlayerEnabled': { label: '开放 2/4 人', type: 'bool' },
  'game.paodekuai.bareTrioEnabled': { label: '裸三张', type: 'bool' },
  'game.paodekuai.trioWithPairEnabled': { label: '三带二', type: 'bool' },
  'game.paodekuai.bareAirplaneEnabled': { label: '裸飞机', type: 'bool' },
  'game.paodekuai.fourWithTwoEnabled': { label: '四带二', type: 'bool' },
  'game.paodekuai.fourWithTwoPairKickerAllowed': { label: '四带二允许对子', type: 'bool' },
  'game.paodekuai.airplaneWings': { label: '飞机翅膀', type: 'text' },
  'game.paodekuai.bombMultiplierEnabled': { label: '炸弹翻倍', type: 'bool' },
  'game.paodekuai.guanMultiplierEnabled': { label: '关牌翻倍', type: 'bool' },
  'game.paodekuai.springMultiplierEnabled': { label: '春天翻倍', type: 'bool' },
  'game.paodekuai.multiplierCap': { label: '倍数封顶', type: 'number', suffix: '倍' },
  'game.paodekuai.baobenEnabled': { label: '保本', type: 'bool' },
  // 平台级
  'room.matchNoBotMaxWaitMs': { label: '无机器人匹配等待上限', type: 'number', suffix: '毫秒' },
  'room.matchScanIntervalMs': { label: '匹配扫描周期', type: 'number', suffix: '毫秒' },
  'room.autostartIntervalMs': { label: '自动开局扫描周期', type: 'number', suffix: '毫秒' },
  'room.reapIntervalMs': { label: '房间回收周期', type: 'number', suffix: '毫秒' },
  'robot.reclaimIntervalMs': { label: '机器人回收周期', type: 'number', suffix: '毫秒' },
  'currency.signupGrant': { label: '注册赠送金币', type: 'number', suffix: '金币' },
  'currency.reconcileIntervalMs': { label: '货币对账周期', type: 'number', suffix: '毫秒' },
  'currency.reliefEnabled': { label: '每日救助开关', type: 'bool' },
  'currency.reliefAmount': { label: '每日救助金额', type: 'number', suffix: '金币' },
  'currency.reliefThresholdCoins': { label: '救助门槛', type: 'number', suffix: '金币' },
  'pay.rechargeEnabled': { label: '充值开关', type: 'bool' },
  'pay.coinPerYuan': { label: '金币/元比率', type: 'number', suffix: '金币/元' },
  'pay.withdrawEnabled': { label: '提现开关', type: 'bool' },
  'risk.withdrawReAuthEnabled': { label: '提现再认证', type: 'bool' },
  'pay.withdrawMinCoins': { label: '提现门槛', type: 'number', suffix: '金币' },
  'pay.withdrawMaxCoinsPerOrder': { label: '单笔提现上限', type: 'number', suffix: '金币' },
  'pay.withdrawDailyMaxCoins': { label: '单日提现上限', type: 'number', suffix: '金币' },
  'pay.withdrawTimeoutMinutes': { label: '提现超时回滚', type: 'number', suffix: '分钟' },
  'pay.orderExpireMinutes': { label: '充值订单有效期', type: 'number', suffix: '分钟' },
  'pay.scanIntervalMs': { label: '支付扫描周期', type: 'number', suffix: '毫秒' },
  'pay.reconcileIntervalMs': { label: '支付日自检周期', type: 'number', suffix: '毫秒' },
  'risk.deviceLimit': { label: '单账号设备数上限', type: 'number' },
  'risk.deviceWindowDays': { label: '设备计数窗口', type: 'number', suffix: '天' },
  'risk.predicate.sameDevice': { label: '同设备防同桌', type: 'bool' },
  'risk.predicate.sameIp': { label: '同 IP 防同桌', type: 'bool' },
  'risk.autoThrottle': { label: '命中自动限流', type: 'bool' },
  'risk.deviceBindingEnabled': { label: '账号设备绑定', type: 'bool' },
  'risk.deviceRetentionDays': { label: '设备记录保留期', type: 'number', suffix: '天' },
  'risk.scanIntervalMs': { label: '风控扫描周期', type: 'number', suffix: '毫秒' },
  'risk.devicesCleanupIntervalMs': { label: '设备清理周期', type: 'number', suffix: '毫秒' },
  'record.retentionDays': { label: '对局记录保留天数', type: 'number', suffix: '天' },
  'record.cleanupIntervalMs': { label: '记录清理周期', type: 'number', suffix: '毫秒' },
  'ad.reliefAdpid': { label: '救助广告位 ID', type: 'text' },
  'client.appEnabled': { label: 'App 端', type: 'bool' },
  'client.h5Enabled': { label: 'H5 端', type: 'bool' },
  'game.doudizhu.enabled': { label: '斗地主总开关', type: 'bool' },
};

/** 5 个结构化键（专属编辑器；不进 CONFIG_CONTROLS）。 */
const STRUCT_KEYS = new Set([
  'game.levels.doudizhu',
  'game.levels.paodekuai',
  'pay.rechargePackages',
  'game.doudizhu.robot.skillDistribution',
  'game.doudizhu.robot.modelBySkill',
]);
/** 结构化键标题（其余展示信息仍取自 CONFIG_NOTES）。 */
const STRUCT_META = {
  'game.levels.doudizhu': { label: '斗地主档位表' },
  'game.levels.paodekuai': { label: '跑得快档位表' },
  'pay.rechargePackages': { label: '充值档位表' },
  'game.doudizhu.robot.skillDistribution': { label: '机器人技能分布' },
  'game.doudizhu.robot.modelBySkill': { label: '各档模型' },
};

/** 当前全量快照（登录后 loadAll 填充）：key -> {value, version}。 */
let currentConfig = {};
/** 简单键未保存草稿（切域/重渲染不丢；保存成功或点还原后删除）。 */
const drafts = new Map();
/** 配置中心 UI 状态：当前域 / 搜索词（v2.1 无页签、无选中键概念）。 */
let cfgUI = DEFAULT_CFG_UI();

/** 当前视图：'config' | 'payChannel' | 'notifyChannel' | 'wallet' | 'finance' | 'payOrders' | 'payRefunds' | 'payWithdrawals' | 'risk' | 'audit' | 'accounts'（③ T10 / 风控片 T9 / 支付片 T12 / 支付配置管理化片 T10 / 通知通道管理化片 T9；顶栏切换）。 */
let activeView = 'config';
/** 钱包调整：当前定位到的玩家（lookup 成功前为 null；无目标时禁止提交调整）。 */
let walletUserId = null;
/** 钱包调整：**在途**调整的 actionId —— 每次填一次表生成一次、重试原样复用（§2.14 ④）。 */
let adjustActionId = null;

/**
 * 十一视图元表（③ T10 立五、风控片 T9 加 `risk`、支付片 T12 加
 * `payOrders/payRefunds/payWithdrawals`、支付配置管理化片 T10 加 `payChannel`、
 * 通知通道管理化片 T9 加 `notifyChannel`；
 * 规格 §2.12/§2.10/§5/§2.8/§2.3）：元素 id / 导航按钮 id / 允许角色（**仅 UI 门面** —— 角色矩阵的真闸在
 * 网关 policy，服务端 403 才是权威；这里只决定眼睛能看到什么）。支付三视图读面全角色
 * （policy P-p1..P-p4），审核动作按钮另以 `canPayWrite()` 门面。
 * 2026-10-21：广告回调并入「广告」配置页（`syncAdSection`），独立 `adChannel` 视图删除。
 */
const VIEWS = {
  // v2.1：config 与凭据两页共用 #settings-host（内部分流见 renderSettings）；
  // nav-config-btn 无叶可挂，作为 hidden 锚点保留（openCfgDomain 驱动 5 个域叶）。
  config: { el: 'settings-host', nav: 'nav-config-btn', roles: ['super_admin', 'operator'] },
  /** 支付配置管理化片 T10（⚙️11 / 规格 §2.8）：读面**有意扩 finance**（写控件仅 super_admin 渲染）。 */
  payChannel: {
    el: 'settings-host',
    nav: 'nav-pay-channel-btn',
    roles: ['super_admin', 'operator', 'finance'],
  },
  /** 通知通道管理化片 T9（⚙️11 / 规格 §2.8）：读面照支付渠道（有意含 finance）；写控件仅 super_admin 渲染。 */
  notifyChannel: {
    el: 'settings-host',
    nav: 'nav-notify-channel-btn',
    roles: ['super_admin', 'operator', 'finance'],
  },
  /** 玩家管理页（2026-10-22）：仅超管/运营。 */
  players: { el: 'players-view', nav: 'nav-players-btn', roles: ['super_admin', 'operator'] },
  wallet: { el: 'wallet-view', nav: 'nav-wallet-btn', roles: ['super_admin', 'finance'] },
  finance: {
    el: 'finance-view',
    nav: 'nav-finance-btn',
    roles: ['super_admin', 'finance', 'operator', 'viewer'],
  },
  /** 支付片 T12：订单/退款/提现三视图（读面全角色；写动作按钮 = super_admin/finance 门面）。 */
  payOrders: {
    el: 'pay-orders-view',
    nav: 'nav-pay-orders-btn',
    roles: ['super_admin', 'finance', 'operator', 'viewer'],
  },
  payRefunds: {
    el: 'pay-refunds-view',
    nav: 'nav-pay-refunds-btn',
    roles: ['super_admin', 'finance', 'operator', 'viewer'],
  },
  payWithdrawals: {
    el: 'pay-withdrawals-view',
    nav: 'nav-pay-withdrawals-btn',
    roles: ['super_admin', 'finance', 'operator', 'viewer'],
  },
  /** 风控片 T9：审核队列 + 五动作（网关 policy P-r1..r4 = super_admin | operator，两边一致）。 */
  risk: { el: 'risk-view', nav: 'nav-risk-btn', roles: ['super_admin', 'operator'] },
  audit: {
    el: 'audit-view',
    nav: 'nav-audit-btn',
    roles: ['super_admin', 'finance', 'operator', 'viewer'],
  },
  accounts: { el: 'accounts-view', nav: 'nav-accounts-btn', roles: ['super_admin'] },
};
const VIEW_ORDER = ['config', 'payChannel', 'notifyChannel', 'players', 'wallet', 'finance', 'payOrders', 'payRefunds', 'payWithdrawals', 'risk', 'audit', 'accounts'];

/** 财务视图状态（③ T10）。 */
const fin = {
  /** 已生效的过滤（epoch ms 边界缺省 = 不传该参数）。 */
  filter: { source: '', gameType: '', actor: '', ownerId: '', from: undefined, to: undefined },
  /** 已累计的流水行（新 → 旧；keyset 追加）。 */
  rows: [],
  nextCursor: null,
  loading: false,
  loaded: false,
  summaryGroupBy: 'source',
};

/** 审计视图状态（③ T10 / 风控片 T9 / 支付片 T12）：六个页签各自的 keyset 列表 + 资金操作页签共用过滤。 */
const audit = {
  tab: 'config',
  config: { rows: [], nextCursor: null, loading: false, loaded: false },
  adjust: { rows: [], nextCursor: null, loading: false, loaded: false },
  reverse: { rows: [], nextCursor: null, loading: false, loaded: false },
  login: { rows: [], nextCursor: null, loading: false, loaded: false },
  account: { rows: [], nextCursor: null, loading: false, loaded: false },
  /** 风控片 T9 第五页签「风控处置」（/api/admin/risk/actions；过滤控件直读，无需共享过滤态）。 */
  risk: { rows: [], nextCursor: null, loading: false, loaded: false },
  /** 支付片 T12 第六页签「支付处置」（/api/admin/pay/actions；无分页——规格 §2.4.2 #8 键集 = from/to/actor）。 */
  pay: { rows: [], nextCursor: null, loading: false, loaded: false },
  walletFilter: { actor: '', ownerId: '', from: undefined, to: undefined },
};

/** 账号视图状态（③ T10）。 */
const accState = { rows: [], loaded: false, loading: false };

/** 风控视图状态（风控片 T9）：已生效的过滤（status 单选）+ keyset 累计的队列行。 */
/** 玩家管理页状态（2026-10-22）。 */
const playersState = {
  filter: { q: '', status: '', online: '', activity: '' },
  page: 1, pageSize: 20, rows: [], total: 0, summary: null,
  balances: new Map(), recharges: new Map(), loading: false, loaded: false,
};

const riskState = {
  filter: { status: '' },
  rows: [],
  nextCursor: null,
  loading: false,
  loaded: false,
};

/** 风控处置动作的中文名（按钮 / 提示文案共用；键 = wire 原值，5 值 = 管理面合法集）。 */
const RISK_ACTION_LABELS = {
  dismiss: '驳回',
  throttle: '限流',
  unthrottle: '解除限流',
  ban: '封禁',
  unban: '解封',
};

/**
 * 支付片 T12：三视图状态（订单 = keyset 累计；退款/提现 = 无分页整列表）。
 * 过滤值 = 已生效的查询条件（控件直读发生在搜索动作里，照 ③ 财务视图口径）。
 */
const payOrders = {
  filter: { status: '', userId: '', from: undefined, to: undefined },
  rows: [],
  nextCursor: null,
  loading: false,
  loaded: false,
};
const payRefunds = {
  filter: { status: '', userId: '' },
  rows: [],
  loading: false,
  loaded: false,
};
const payWithdrawals = {
  filter: { status: '', userId: '' },
  rows: [],
  loading: false,
  loaded: false,
};

/**
 * 支付渠道视图状态（支付配置管理化片 T10）：六行 = `GET /api/admin/pay-channel` 的
 * `data.keys`（顺序即响应序）；首次激活懒加载后缓存。
 */
const payChannelState = { rows: [], loaded: false, loading: false };

/**
 * 通知通道视图状态（通知通道管理化片 T9）：九行 = `GET /api/admin/notify-channel` 的
 * `data.keys`（顺序即响应序 = ⚙️1 序；两组划分按 `notify.webhook.` 前缀）；首次激活懒加载后缓存。
 */
const notifyChannelState = { rows: [], loaded: false, loading: false };

/**
 * 广告回调面板状态（广告片 T9；2026-10-21 并入「广告」配置页）：
 * 单行 = `GET /api/admin/ad-channel` 的 `data.keys`（顺序即响应序 = `AD_CHANNEL_KEYS`；本空间恰 1 键）；
 * 首次进入广告域懒加载后缓存。`attempted` = 本次进入广告域已发过请求（失败后防重渲染重试风暴；
 * 显式再点「广告」叶会清零重试）。
 */
const adChannelState = { rows: [], loaded: false, loading: false, attempted: false };

/** 支付处置事件的中文映射（审计第六页签展示；键 = wire kind，未知值原样回显——不静默吞）。 */
const PAY_ACTION_LABELS = {
  applied: '申请',
  approved: '审通过',
  rejected: '驳回',
  confirmed: '打款确认',
  rolled_back: '超时回滚',
};

/** 条目态动作（随行 `reviewId` 陈旧断言的前端半边；ban/unban 不消费 —— 服务端 F6 口径）。 */
const RISK_ENTRY_ACTIONS = ['dismiss', 'throttle', 'unthrottle'];

const $ = (id) => document.getElementById(id);

/** 当前登录身份（登出/未登录 ⇒ 空串）。 */
const roleOf = () => sessionStorage.getItem(ROLE_KEY) ?? '';
const usernameOf = () => sessionStorage.getItem(USERNAME_KEY) ?? '';
/** 角色门面：该视图对当前角色可见？（**仅 UI**——服务端 policy 才是闸。） */
const canView = (view) => VIEWS[view]?.roles.includes(roleOf()) ?? false;
/** 概览/写操作门面：super_admin | finance（policy P5–P7；冲正与手动对账）。 */
const canWalletWrite = () => roleOf() === 'super_admin' || roleOf() === 'finance';
/** 支付写面门面：super_admin | finance（policy P-p5..P-p7；退款审 / 提现审 / 登记打款）。 */
const canPayWrite = () => roleOf() === 'super_admin' || roleOf() === 'finance';

/** 顶栏状态条（登录错误 / 保存反馈共用）。kind ∈ info|ok|warn|err。 */
function showMsg(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = !text;
}

/** 北京时间展示（规格 §2.12 逐字口径；⚙️1：库里存 UTC，页面按北京呈现）。 */
function fmtTime(ms) {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** JSON 值 → 单行文本（null/undefined ⇒ 占位「—」；对象/数组 ⇒ JSON 串）。 */
function jsonText(value) {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 带管理令牌的 fetch 薄封装：`{status, body}`；网络层失败 ⇒ `status: 0`（如实成档）。 */
async function api(path, opts = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(opts.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    return { status: 0, body: null };
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 401 的统一处置：回登录视图并提示。返回 true = 已被处理（调用方直接 return）。 */
function handleAuth(status) {
  if (status !== 401) return false;
  backToLogin();
  showMsg('令牌过期，请重新登录', 'err');
  return true;
}

/** 令牌失效/退出的统一处置（401 与登出共用）：清令牌/身份 → 回登录视图
 *  （主视图 DOM 清零在 showLoginView —— 单一处置点）。文案由调用方给。 */
function backToLogin() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USERNAME_KEY);
  sessionStorage.removeItem(ROLE_KEY);
  showLoginView();
}

async function login(username, password) {
  const { status, body } = await api('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  // 🔴 只按 status 分流（M1）—— 404 的 body.code=10001 是借码，读它会把「未启用」与
  //    「路不存在」混同、并跟着码表漂移。分支文案逐字（brief/规格 §2.12）：
  //    404 改版 + 403 新增「账号已停用」。
  if (status === 404) return showMsg('管理面未启用（未创建任何管理员账号）', 'err');
  if (status === 401) return showMsg('用户名或口令错误', 'err');
  if (status === 403) return showMsg('账号已停用，请联系超级管理员', 'err');
  if (status === 429) return showMsg('尝试过于频繁，请稍后再试', 'err');
  if (status === 400) return showMsg(`登录失败：${body?.message ?? '参数非法'}`, 'err');
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status !== 200 || !body?.data?.token) {
    return showMsg(`登录失败（HTTP ${status}）`, 'err');
  }
  sessionStorage.setItem(TOKEN_KEY, body.data.token);
  sessionStorage.setItem(USERNAME_KEY, String(body.data.username ?? username));
  sessionStorage.setItem(ROLE_KEY, String(body.data.role ?? ''));
  showMsg('');
  showMainView();
}

/** 拉全量九十二键 ⇒ 更新左树计数并重渲染当前域设置行（401 ⇒ 回登录视图）。 */
async function loadAll() {
  const { status, body } = await api('/api/admin/config');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status !== 200 || !body?.data?.config) {
    return showMsg(`加载失败（HTTP ${status}）`, 'err');
  }
  currentConfig = body.data.config;
  updateCfgNav();
  if (activeView === 'config') renderConfigRows({ preserve: true });
}

/* ── v2.1 配置中心：左树计数/域切换 + 整页内联设置行（无中列、无独立编辑器）──── */

/** 快照全部键（字母序）。 */
function snapshotKeys() {
  return Object.keys(currentConfig).sort();
}

/** 快照中存在但 IA 表未收录的键（未来新增键的兜底桶；字母序）。 */
function ungroupedKeys() {
  return snapshotKeys().filter((k) => !IA_KEY_SET.has(k) && !LEGACY_KEY_SET.has(k));
}

/** 某域在当前快照中的键数（= 其各页签已下发键的并集计数）。 */
function domainSnapshotCount(domain) {
  const keys = new Set([
    ...(domain.headerKeys ?? []),
    ...(domain.tabs ?? []).flatMap((t) => t.keys),
  ]);
  return [...keys].filter((k) => k in currentConfig).length;
}

/** 搜索匹配面：键名 + 该键 CONFIG_NOTES 备注全文（不区分大小写；无备注键只匹配键名）。 */
function notesHaystack(key) {
  return (CONFIG_NOTES[key] ? JSON.stringify(CONFIG_NOTES[key]) : '').toLowerCase();
}

/** 当前域对象；未分组为虚拟域（其唯一 tab 的键集动态生成）。 */
function domainById(id) {
  if (id === UNGROUPED_DOMAIN_ID) {
    return { id, name: '未分组', tabs: [{ id: 'all', name: '未分组', keys: ungroupedKeys() }] };
  }
  return IA_DOMAINS.find((d) => d.id === id) ?? null;
}

/** 左树 5+1 配置叶：计数徽标 + 角色/空数显隐（其余 10 叶由 applyRoleNav 按 VIEW_ORDER 处理）。 */
function updateCfgNav() {
  const canCfg = canView('config');
  const extra = ungroupedKeys();
  for (const m of CFG_NAV) {
    const n =
      m.domain === UNGROUPED_DOMAIN_ID
        ? extra.length
        : domainSnapshotCount(IA_DOMAINS.find((d) => d.id === m.domain));
    $(m.count).textContent = n > 0 ? String(n) : '';
    $(m.leaf).hidden = !canCfg || n === 0;
  }
}

/** 配置叶高亮：config 视图下只亮当前域叶（其余 10 叶的 active 由 switchView 管）。 */
function syncCfgLeafActive() {
  for (const m of CFG_NAV) {
    $(m.leaf).classList.toggle('active', activeView === 'config' && cfgUI.domainId === m.domain);
  }
}

/** 快照增删键导致当前域落空 ⇒ 回退第一个有键域（再退未分组）；搜索态不干预。 */
function normalizeCfgDomain() {
  if (cfgUI.query.trim()) return;
  const cur =
    cfgUI.domainId === UNGROUPED_DOMAIN_ID
      ? ungroupedKeys().length
      : domainSnapshotCount(IA_DOMAINS.find((d) => d.id === cfgUI.domainId) ?? { tabs: [] });
  if (cur > 0) return;
  const first = CFG_NAV.find(
    (m) =>
      m.domain !== UNGROUPED_DOMAIN_ID &&
      domainSnapshotCount(IA_DOMAINS.find((d) => d.id === m.domain)) > 0,
  );
  cfgUI.domainId = first ? first.domain : UNGROUPED_DOMAIN_ID;
}

/** 点左树配置叶：切域（已在 config 视图只重渲染，避免重复懒加载与状态复位）。 */
function openCfgDomain(domainId) {
  cfgUI.domainId = domainId;
  cfgUI.query = '';
  $('settings-search').value = '';
  if (domainId === 'dataAds') adChannelState.attempted = false; // 显式点叶 = 允许失败重试
  if (activeView !== 'config') switchView('config');
  else {
    renderConfigRows();
    syncCfgLeafActive();
  }
  $('settings-host').scrollTop = 0;
}

/**
 * #settings-host 内部分流：config ⇒ 工具栏 + 设置行（广告域再追加广告回调面板）；
 * 凭据两视图 ⇒ 各自 section。host 整体显隐归 switchView 的 el 循环；内部显隐归本函数。
 */
function renderSettings(view = activeView) {
  const toolbar = $('settings-host').querySelector('.settings-toolbar');
  toolbar.hidden = view !== 'config';
  $('settings-rows').hidden = view !== 'config';
  $('pay-channel-view').hidden = view !== 'payChannel';
  $('notify-channel-view').hidden = view !== 'notifyChannel';
  if (view === 'config') renderConfigRows();
  else $('ad-channel-view').hidden = true;
}

/** 设置行整页渲染：搜索态扁平「搜索结果（N）」；否则按当前域 tabs 顺序出分区标题。 */
function renderConfigRows({ preserve = false } = {}) {
  const host = $('settings-rows');
  const scrollEl = $('settings-host');
  const focusedKey = preserve
    ? document.activeElement?.closest?.('[data-key]')?.dataset.key
    : null;
  const scrollTop = preserve ? scrollEl.scrollTop : 0;

  host.textContent = '';
  const q = cfgUI.query.trim().toLowerCase();
  let sections;
  let headerDomain = null;
  if (q) {
    const keys = snapshotKeys().filter(
      (k) =>
        !LEGACY_KEY_SET.has(k) &&
        (k.toLowerCase().includes(q) || notesHaystack(k).includes(q)),
    );
    sections = [{ name: `搜索结果（${keys.length}）`, keys }];
  } else {
    normalizeCfgDomain();
    const domain = domainById(cfgUI.domainId);
    headerDomain = domain;
    sections = domain
      ? domain.tabs
          .map((t) => ({
            name: t.name,
            keys: t.keys.filter((k) => k in currentConfig),
          }))
          .filter((s) => s.keys.length > 0)
      : [];
  }

  let rendered = 0;
  // 玩法域顶部开关卡（搜索态不渲染；搜索态里该键作为普通布尔行走 buildKeyCard）。
  for (const key of headerDomain?.headerKeys ?? []) {
    host.append(buildGameHeader(headerDomain, key));
    rendered += 1;
  }
  for (const sec of sections) {
    if (sec.keys.length === 0) continue;
    const title = document.createElement('h3');
    title.className = 'settings-section';
    title.textContent = sec.name;
    host.append(title);
    for (const key of sec.keys) {
      host.append(buildKeyCard(key));
      rendered += 1;
    }
  }
  if (rendered === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-empty';
    empty.textContent = q ? '没有匹配的配置键' : '（暂无可展示的配置键）';
    host.append(empty);
  }

  syncAdSection(q);

  scrollEl.scrollTop = scrollTop;
  if (focusedKey) {
    const card = host.querySelector(`[data-key="${cssEscape(focusedKey)}"]`);
    card?.querySelector('input, textarea, select')?.focus();
  }
}

/**
 * 「广告」配置页的广告回调面板显隐/懒加载（2026-10-21 合并）。
 * 仅在 config 视图 + dataAds 域 + 非搜索态显示；面板是 #settings-rows 的兄弟节点，
 * 重渲染不清空它，故只在 rows 为空时从状态重放，避免清掉未保存的密钥输入。
 */
function syncAdSection(q) {
  const show = activeView === 'config' && cfgUI.domainId === 'dataAds' && !q;
  $('ad-channel-view').hidden = !show;
  if (!show) return;
  if (adChannelState.loaded) {
    if (!$('ad-channel-rows').firstChild) renderAdChannel();
    return;
  }
  if (!adChannelState.loading && !adChannelState.attempted) loadAdChannel();
}

/** 键名进 CSS 属性选择器前转义（键仅 ASCII 点分字母，CSS.escape 为双保险）。 */
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/* ── 行卡片构建（全部 createElement + textContent；禁 HTML 串赋值纪律）────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(text, className) {
  const b = el('button', className ?? 'btn', text);
  b.type = 'button';
  return b;
}

function buildKeyCard(key) {
  if (STRUCT_KEYS.has(key)) return buildStructCard(key);
  if (Object.hasOwn(CONFIG_CONTROLS, key)) return buildSimpleRow(key);
  return buildJsonRow(key);
}

/** 作用行 + 「更多」详情（取值/生效/注意）；未收录键只给兜底说明、不给「更多」。 */
function buildEffectAndDetail(card, key) {
  const effect = el('div', 'row-effect');
  const detail = el('div', 'row-detail');
  const notes = Object.hasOwn(CONFIG_NOTES, key) ? CONFIG_NOTES[key] : null;
  if (!notes) {
    effect.textContent = '（暂无该键的说明文案：按快照原值以 JSON 编辑，保存时由服务端校验合法性。）';
    return { effect, detail };
  }
  effect.textContent = `${notes[0][1]} `;
  const more = btn('更多', 'row-more');
  more.addEventListener('click', () => card.classList.toggle('expanded'));
  effect.append(more);
  for (const [label, text] of notes.slice(1)) {
    const p = el('p', 'note-line');
    p.append(el('span', 'note-label', label), document.createTextNode(`：${text}`));
    detail.append(p);
  }
  return { effect, detail };
}

/**
 * 玩法域顶部「开放该玩法」卡：立即 PUT（关闭前 confirm）；缺键/未加载按默认值显示并禁用。
 * 复用行卡片/开关样式；`data-key` 供渲染后的焦点恢复。
 */
function buildGameHeader(domain, key) {
  const loaded = key in currentConfig;
  const enabled = loaded
    ? currentConfig[key].value === true
    : GAME_SWITCH_DEFAULTS[key] === true;
  const card = el('div', 'row-card game-switch-card');
  card.dataset.key = key;

  const main = el('div', 'row-main');
  const titleLine = el('div');
  titleLine.append(
    el('span', 'row-title', `开放「${domain.name}」`),
    el('span', 'row-key', key),
    el('span', 'row-ver', loaded ? `v${currentConfig[key]?.version ?? '?'}` : '未加载'),
  );
  main.append(
    titleLine,
    el(
      'div',
      'row-effect',
      '关闭后：新的匹配/建房会被拒绝（12012），进行中的对局与已有房间不受影响。配置通常秒级生效，最坏 ≤60s。',
    ),
  );

  const ctl = el('div', 'row-ctl');
  const label = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = enabled;
  input.disabled = !loaded;
  const track = el('span', 'switch-track');
  const val = el('span', 'switch-val', enabled ? '已开放' : '已关闭');
  label.append(input, track, val);
  ctl.append(label);
  card.append(main, ctl);
  if (!loaded) {
    card.append(el('div', 'row-state', '配置未加载：按默认值显示，暂不可修改。'));
  }

  input.addEventListener('change', async () => {
    const next = input.checked;
    if (!next) {
      const last = lastEnabledGameWarning(
        currentConfig,
        key,
        GAME_SWITCH_DEFAULTS,
        GAME_SWITCH_KEYS,
      );
      const tail = last ? '\n这是最后一个开放的玩法，关闭后大厅将没有可选玩法。' : '';
      if (
        !confirm(
          `关闭「${domain.name}」？\n新的匹配/建房将被拒绝（12012），进行中的对局与已有房间不受影响。${tail}`,
        )
      ) {
        input.checked = !next;
        return;
      }
    }
    input.disabled = true;
    const res = await putConfigKey(key, next);
    if (res.ok) {
      await loadAll();
    } else {
      input.checked = !next;
      input.disabled = false;
      val.textContent = input.checked ? '已开放' : '已关闭';
    }
  });
  return card;
}

/** 47 简单键行：标题/作用在左、控件在右、脏状态出保存/还原；草稿跨重渲染保留。 */
function buildSimpleRow(key) {
  const ctrl = CONFIG_CONTROLS[key];
  const snap = currentConfig[key]?.value;
  const card = el('div', 'row-card');
  card.dataset.key = key;

  const main = el('div', 'row-main');
  const titleLine = el('div');
  titleLine.append(
    el('span', 'row-title', ctrl.label),
    el('span', 'row-key', key),
    el('span', 'row-ver', `v${currentConfig[key]?.version ?? '?'}`),
  );
  const { effect, detail } = buildEffectAndDetail(card, key);
  main.append(titleLine, effect, detail);

  const ctl = el('div', 'row-ctl');
  const actions = el('div', 'row-actions');
  const state = el('span', 'row-state');
  const revertBtn = btn('还原');
  const saveBtn = btn('保存', 'btn primary');
  actions.append(state, revertBtn, saveBtn);

  let read = () => undefined;
  let reset = () => {};

  if (ctrl.type === 'bool') {
    const label = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    const track = el('span', 'switch-track');
    const val = el('span', 'switch-val');
    const sync = () => {
      val.textContent = input.checked ? '已启用（true）' : '已停用（false）';
    };
    input.checked = Boolean(drafts.has(key) ? drafts.get(key) : snap);
    sync();
    input.addEventListener('change', () => onInput(input.checked));
    label.append(input, track, val);
    ctl.append(label);
    read = () => input.checked;
    reset = () => {
      input.checked = Boolean(snap);
      sync();
    };
  } else if (ctrl.type === 'number') {
    const wrap = el('span', 'num-wrap');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'num-input';
    input.step = ctrl.step ?? 1;
    input.value = String(drafts.has(key) ? drafts.get(key) : snap ?? '');
    wrap.append(input);
    if (ctrl.suffix) wrap.append(el('span', 'num-suffix', ctrl.suffix));
    input.addEventListener('input', () => onInput(Number(input.value)));
    ctl.append(wrap);
    read = () => {
      const n = Number(input.value);
      if (!Number.isFinite(n)) throw new Error('请输入数字');
      return n;
    };
    reset = () => {
      input.value = String(snap ?? '');
    };
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.spellcheck = false;
    input.value = String(drafts.has(key) ? drafts.get(key) : snap ?? '');
    input.addEventListener('input', () => onInput(input.value));
    ctl.append(input);
    read = () => input.value;
    reset = () => {
      input.value = String(snap ?? '');
    };
  }

  if (drafts.has(key)) card.classList.add('dirty');
  function onInput(v) {
    if (v === snap) {
      drafts.delete(key);
      card.classList.remove('dirty');
    } else {
      drafts.set(key, v);
      card.classList.add('dirty');
    }
    state.textContent = '';
    state.className = 'row-state';
  }
  revertBtn.addEventListener('click', () => {
    drafts.delete(key);
    reset();
    card.classList.remove('dirty');
    state.textContent = '';
    state.className = 'row-state';
  });
  saveBtn.addEventListener('click', () => saveRow(key, card, read));

  card.append(main, ctl, actions);
  return card;
}

/**
 * 4 结构化键整卡编辑器：头部（标题/键名/版本/作用/更多）+ 专属编辑件 + 同款行内保存协议。
 * ctx.bind(getter, resetter)：getter 读 UI 值（不合法抛 Error ⇒ 行内拦截）；resetter 一键还原。
 */
function buildStructCard(key) {
  const card = el('div', 'struct-card');
  card.dataset.key = key;
  const head = el('div', 'struct-head');
  head.append(
    el('span', 'struct-title', STRUCT_META[key]?.label ?? key),
    el('span', 'struct-key', key),
    el('span', 'struct-ver', `v${currentConfig[key]?.version ?? '?'}`),
  );
  const { effect, detail } = buildEffectAndDetail(card, key);
  const body = el('div', 'struct-body');
  const foot = el('div', 'struct-foot');
  const state = el('span', 'row-state');
  const revertBtn = btn('还原');
  const saveBtn = btn('保存', 'btn primary');
  foot.append(state, revertBtn, saveBtn);

  const ctx = {
    snap: currentConfig[key]?.value,
    state(msg, kind) {
      state.textContent = msg;
      state.className = kind ? `row-state ${kind}` : 'row-state';
    },
    dirty() {
      card.classList.add('dirty');
    },
  };
  let read = () => {
    throw new Error('编辑器未初始化');
  };
  let reset = () => {};
  ctx.bind = (getter, resetter) => {
    read = getter;
    reset = resetter;
  };

  if (key === 'game.levels.doudizhu' || key === 'game.levels.paodekuai') buildLevelsEditor(body, ctx);
  else if (key === 'pay.rechargePackages') buildPackagesEditor(body, ctx);
  else if (key === 'game.doudizhu.robot.skillDistribution') buildDistributionEditor(body, ctx);
  else if (key === 'game.doudizhu.robot.modelBySkill') buildModelEditor(body, ctx);

  revertBtn.addEventListener('click', () => {
    reset();
    card.classList.remove('dirty');
    ctx.state('', '');
  });
  saveBtn.addEventListener('click', () => saveRow(key, card, read));

  card.append(head, effect, detail, body, foot);
  return card;
}

/** 未分组键：全站唯一保留 JSON 原值编辑（快照里有什么就编什么）。 */
function buildJsonRow(key) {
  const card = el('div', 'struct-card');
  card.dataset.key = key;
  const head = el('div', 'struct-head');
  head.append(
    el('span', 'struct-title', key),
    el('span', 'struct-ver', `v${currentConfig[key]?.version ?? '?'}`),
  );
  const { effect, detail } = buildEffectAndDetail(card, key);
  const box = document.createElement('textarea');
  box.className = 'json-box';
  box.rows = 4;
  box.spellcheck = false;
  const stringify = () => JSON.stringify(currentConfig[key]?.value, null, 2);
  box.value = stringify();
  box.addEventListener('input', () => {
    card.classList.add('dirty');
    ctxState('', '');
  });
  const foot = el('div', 'struct-foot');
  const state = el('span', 'row-state');
  const revertBtn = btn('还原');
  const saveBtn = btn('保存', 'btn primary');
  foot.append(state, revertBtn, saveBtn);
  const ctxState = (msg, kind) => {
    state.textContent = msg;
    state.className = kind ? `row-state ${kind}` : 'row-state';
  };
  revertBtn.addEventListener('click', () => {
    box.value = stringify();
    card.classList.remove('dirty');
    ctxState('', '');
  });
  saveBtn.addEventListener('click', () =>
    saveRow(key, card, () => {
      try {
        return JSON.parse(box.value);
      } catch (err) {
        throw new Error(`JSON 解析失败：${err.message}`);
      }
    }),
  );
  card.append(head, effect, detail, box, foot);
  return card;
}

/* ── 4 个结构化编辑器 ───────────────────────────────────────── */

/** 底分档位表：{name, baseScore, entryFeePercent} 行增删；缺省底分 = 表内数值最低档。 */
function buildLevelsEditor(box, ctx) {
  const rowsWrap = el('div', 'struct-rows');
  const refs = [];
  function addRow(name, baseScore, entryFeePercent) {
    const row = el('div', 'struct-row');
    const nameEl = document.createElement('input');
    nameEl.type = 'text';
    nameEl.className = 'field-name';
    nameEl.value = name ?? '';
    const numEl = document.createElement('input');
    numEl.type = 'number';
    numEl.className = 'field-num';
    numEl.min = '1';
    numEl.max = '8191';
    numEl.value = baseScore === undefined || baseScore === null ? '' : String(baseScore);
    const pctEl = document.createElement('input');
    pctEl.type = 'number';
    pctEl.className = 'field-num';
    pctEl.min = '0';
    pctEl.max = '100';
    pctEl.value =
      entryFeePercent === undefined || entryFeePercent === null ? '0' : String(entryFeePercent);
    const del = btn('删除', 'struct-remove');
    const ref = { nameEl, numEl, pctEl, row };
    const onChange = () => {
      ctx.dirty();
      ctx.state('', '');
    };
    nameEl.addEventListener('input', onChange);
    numEl.addEventListener('input', onChange);
    pctEl.addEventListener('input', onChange);
    del.addEventListener('click', () => {
      row.remove();
      const i = refs.indexOf(ref);
      if (i >= 0) refs.splice(i, 1);
      ctx.dirty();
    });
    row.append(nameEl, numEl, pctEl, del);
    rowsWrap.append(row);
    refs.push(ref);
  }
  for (const item of Array.isArray(ctx.snap) ? ctx.snap : []) {
    addRow(item?.name, item?.baseScore, item?.entryFeePercent);
  }
  const add = btn('+ 添加档位', 'struct-add');
  add.addEventListener('click', () => {
    addRow('', '', 0);
    ctx.dirty();
  });
  // 表头：明确每一列的含义（场次名 / 底分 / 台费% / 操作）
  const header = el('div', 'struct-row struct-row--head');
  header.append(
    el('span', 'head-name', '场次名'),
    el('span', 'head-num', '底分'),
    el('span', 'head-num', '台费 %'),
    el('span', 'head-action', '操作'),
  );
  box.append(
    header,
    rowsWrap,
    add,
    el('p', 'struct-note', '底分须为正整数、唯一、≤ 8191；台费为 0–100 的整数百分比（0 = 不收，100 = 入场费等于底分）；省略底分时取表内最低档。'),
  );
  ctx.bind(
    () => {
      const out = [];
      for (const r of refs) {
        const name = r.nameEl.value.trim();
        const score = Number(r.numEl.value);
        const pctRaw = r.pctEl.value.trim();
        const percent = pctRaw === '' ? 0 : Number(pctRaw);
        if (!name) throw new Error('每一档的场名不能为空');
        if (!Number.isInteger(score) || score <= 0 || score > 8191) {
          throw new Error('底分须为 1–8191 的正整数');
        }
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
          throw new Error('台费须为 0–100 的整数百分比（0 = 不收，100 = 入场费等于底分）');
        }
        if (out.some((o) => o.baseScore === score)) throw new Error('底分档位值不得重复');
        out.push({ name, baseScore: score, entryFeePercent: percent });
      }
      if (out.length === 0) throw new Error('至少保留一个档位');
      return out;
    },
    () => {
      rowsWrap.textContent = '';
      refs.length = 0;
      for (const item of Array.isArray(ctx.snap) ? ctx.snap : []) {
        addRow(item?.name, item?.baseScore, item?.entryFeePercent);
      }
      ctx.state('', '');
    },
  );
}

/** 充值档位：唯一正整数（元）数组，行增删。 */
function buildPackagesEditor(box, ctx) {
  const rowsWrap = el('div', 'struct-rows');
  const refs = [];
  function addRow(v) {
    const row = el('div', 'struct-row');
    const numEl = document.createElement('input');
    numEl.type = 'number';
    numEl.className = 'field-num';
    numEl.min = '1';
    numEl.max = '9999999';
    numEl.value = v === undefined || v === null ? '' : String(v);
    const del = btn('删除', 'struct-remove');
    const ref = { numEl, row };
    numEl.addEventListener('input', () => {
      ctx.dirty();
      ctx.state('', '');
    });
    del.addEventListener('click', () => {
      row.remove();
      const i = refs.indexOf(ref);
      if (i >= 0) refs.splice(i, 1);
      ctx.dirty();
    });
    row.append(numEl, el('span', 'num-suffix', '元'), del);
    rowsWrap.append(row);
    refs.push(ref);
  }
  for (const v of Array.isArray(ctx.snap) ? ctx.snap : []) addRow(v);
  const add = btn('+ 添加档位', 'struct-add');
  add.addEventListener('click', () => {
    addRow('');
    ctx.dirty();
  });
  box.append(
    rowsWrap,
    add,
    el('p', 'struct-note', '档位为唯一正整数（元）、≤ 9999999；下单只接受表内档位。'),
  );
  ctx.bind(
    () => {
      const out = [];
      for (const r of refs) {
        const v = Number(r.numEl.value);
        if (!Number.isInteger(v) || v <= 0 || v > 9999999) {
          throw new Error('每档须为 1–9999999 的正整数');
        }
        if (out.includes(v)) throw new Error('档位不得重复');
        out.push(v);
      }
      if (out.length === 0) throw new Error('至少保留一个档位');
      return out;
    },
    () => {
      rowsWrap.textContent = '';
      refs.length = 0;
      for (const v of Array.isArray(ctx.snap) ? ctx.snap : []) addRow(v);
      ctx.state('', '');
    },
  );
}

/** 机器人技能分布：百分比 UI（快照小数 ×100 显示 / 100 回写）；全 0 拦截，合计≠100 服务端归一。 */
const SKILL_TIERS = [
  ['beginner', '弱'],
  ['intermediate', '中'],
  ['advanced', '高'],
];
function pctToInput(v) {
  return String(Math.round((Number(v) || 0) * 10000) / 100);
}
function buildDistributionEditor(box, ctx) {
  const snap = ctx.snap ?? {};
  const inputs = new Map();
  const sumLine = el('p', 'dist-sum');
  function refresh() {
    let total = 0;
    let bad = false;
    for (const input of inputs.values()) {
      const n = Number(input.value);
      if (!Number.isFinite(n) || n < 0 || n > 100) bad = true;
      else total += n;
    }
    total = Math.round(total * 100) / 100;
    sumLine.textContent =
      total === 100
        ? '合计 100%'
        : `合计 ${total}%（≠100%：保存时服务端按合计归一化）`;
    sumLine.className = 'dist-sum' + (bad || total !== 100 ? ' bad' : '');
  }
  const rowsWrap = el('div', 'struct-rows');
  for (const [id, cn] of SKILL_TIERS) {
    const row = el('div', 'dist-row');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'dist-pct';
    input.min = '0';
    input.max = '100';
    input.step = '0.01';
    input.value = pctToInput(snap[id]);
    input.addEventListener('input', () => {
      refresh();
      ctx.dirty();
      ctx.state('', '');
    });
    row.append(el('span', 'dist-name', `${cn}（${id}）`), input, el('span', 'dist-suffix', '%'));
    rowsWrap.append(row);
    inputs.set(id, input);
  }
  box.append(
    rowsWrap,
    sumLine,
    el('p', 'struct-note', '三档各 ≥ 0、合计须 > 0（全 0 会被拒绝）；合计不必恰为 100，服务端按合计归一。'),
  );
  refresh();
  ctx.bind(
    () => {
      const out = {};
      let total = 0;
      for (const [id, input] of inputs) {
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('各档比例须为 0–100 的数字');
        out[id] = n / 100;
        total += n;
      }
      if (total <= 0) throw new Error('三档合计必须大于 0（全 0 会被拒绝）');
      return out;
    },
    () => {
      for (const [id, input] of inputs) input.value = pctToInput(snap[id]);
      refresh();
      ctx.state('', '');
    },
  );
}

/** 各档模型：弱/中/高三行下拉（sl / douzero_WP / douzero_ADP）。 */
const MODEL_OPTIONS = ['sl', 'douzero_WP', 'douzero_ADP'];
function buildModelEditor(box, ctx) {
  const snap = ctx.snap ?? {};
  const selects = new Map();
  const wrap = el('div', 'model-block');
  for (const [id, cn] of SKILL_TIERS) {
    const row = el('div', 'model-row');
    const select = document.createElement('select');
    for (const opt of MODEL_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.append(o);
    }
    select.value = MODEL_OPTIONS.includes(snap[id]) ? snap[id] : MODEL_OPTIONS[0];
    select.addEventListener('change', () => {
      ctx.dirty();
      ctx.state('', '');
    });
    row.append(el('span', 'model-name', `${cn}（${id}）`), select);
    wrap.append(row);
    selects.set(id, select);
  }
  box.append(wrap, el('p', 'struct-note', '模型名区分大小写与下划线；改动只影响之后的补位机器人。'));
  ctx.bind(
    () => {
      const out = {};
      for (const [id, select] of selects) out[id] = select.value;
      return out;
    },
    () => {
      for (const [id, select] of selects) {
        select.value = MODEL_OPTIONS.includes(snap[id]) ? snap[id] : MODEL_OPTIONS[0];
      }
      ctx.state('', '');
    },
  );
}

/* ── 保存链路（v2.1）：putConfigKey = 单键 PUT + status 分流 + announced 双文案逐字；
   saveRow = 行内 UI 协议（本地校验错走行内 state；服务端消息走顶栏 #status）。──── */

/**
 * 单键保存契约：PUT /api/admin/config/{encodeURIComponent(key)}，body {value}。
 * 只按 HTTP status 分流（M1，不读 body.code）；成功返回 {ok:true,data}，其余 {ok:false}。
 */
async function putConfigKey(key, value) {
  const { status, body } = await api(
    `/api/admin/config/${encodeURIComponent(key)}`,
    { method: 'PUT', body: JSON.stringify({ value }) },
  );
  if (status === 400) {
    showMsg(`未保存：${body?.message ?? ''}`, 'err');
    return { ok: false };
  }
  if (status === 401) {
    backToLogin();
    showMsg('令牌过期，请重新登录', 'err');
    return { ok: false };
  }
  if (status === 0) {
    showMsg('无法连接服务端', 'err');
    return { ok: false };
  }
  if (status !== 200 || !body?.data) {
    showMsg(`保存失败（HTTP ${status}）`, 'err');
    return { ok: false };
  }
  // 文案逐字（规格 §2.5 / 设计 D6；「读到新值」口径 = 节奏/清理旋钮管理化片设计 r1 🟡10 裁决）：
  // announced 如实透传 —— publish 失败不拦写；「读到新值」≠「已生效」——节奏类键最坏等一个旧间隔。
  showMsg(
    body.data.announced
      ? `已保存（版本 ${body.data.version}）；各服务 ≤60s 内读到新值（节奏类键自下一轮排期起生效）`
      : `已保存（版本 ${body.data.version}）；推送失败，安全网将在 ≤60s 内拉到新值（节奏类键自下一轮排期起生效）`,
    body.data.announced ? 'ok' : 'warn',
  );
  return { ok: true, data: body.data };
}

/** 行内保存：read() 抛错（本地拦截）⇒ 行内红字不发请求；请求失败保脏；成功清草稿并 loadAll 重渲染。 */
async function saveRow(key, card, read) {
  let value;
  try {
    value = read();
  } catch (err) {
    setRowState(card, err.message, 'err');
    return;
  }
  card.classList.add('saving');
  const res = await putConfigKey(key, value);
  card.classList.remove('saving');
  if (res.ok) {
    drafts.delete(key);
    await loadAll();
  } else {
    card.classList.add('dirty');
  }
}

function setRowState(card, msg, kind) {
  const state = card.querySelector('.row-state');
  if (!state) return;
  state.textContent = msg;
  state.className = kind ? `row-state ${kind}` : 'row-state';
}

function showLoginView() {
  $('login-view').hidden = false;
  // 十一视图全隐（含 ③ T10 三新视图、风控片 T9 的风控视图、支付片 T12 的三支付视图、
  // 支付配置管理化片 T10 的支付渠道视图、通知通道管理化片 T9 的通知通道视图）。
  for (const name of VIEW_ORDER) $(VIEWS[name].el).hidden = true;
  // v2.1：壳（左树 + content-host）整体隐藏；#settings-host 内的凭据两 section 同步隐，
  // 广告回调面板（广告页内）也显式隐藏。
  $('main-view').hidden = true;
  $('pay-channel-view').hidden = true;
  $('notify-channel-view').hidden = true;
  $('ad-channel-view').hidden = true;
  $('logout-btn').hidden = true;
  $('whoami').hidden = true;
  $('whoami').textContent = '';
  // 回登录态 = **主视图 DOM 清零**（登出/令牌过期后不在 DOM 里残留配置值与
  // 钱包目标；也是修复轮探针「回登录态」的断言面）。
  currentConfig = {};
  // v2.1 IA 组件同步清零：设置行/草稿/搜索词不跨会话残留，UI 状态回默认域。
  drafts.clear();
  cfgUI = DEFAULT_CFG_UI();
  $('settings-rows').textContent = '';
  $('settings-search').value = '';
  // 钱包面清零：目标、在途 actionId 与三个输入框都不跨会话残留（下次登录从空表单开始；
  // clearWalletTarget 收在目标行与按钮上）。
  clearWalletTarget();
  $('wallet-phone').value = '';
  $('wallet-delta').value = '';
  $('wallet-reason').value = '';
  // ③ T10：财务/审计/账号三视图同样清零（数据显示面与过滤控件都不跨会话残留）；
  // 风控片 T9：风控视图同款；支付片 T12：三支付视图同款；支付配置管理化片 T10：支付渠道视图同款
  //（渠道状态行与私钥输入框都不跨会话残留）；通知通道管理化片 T9：通知通道视图同款
  //（两组九行与九个输入框都不跨会话残留）；广告片 T9：广告回调面板同款（单行与单个输入框都不跨会话残留）。
  resetPlayers();
  resetFinance();
  resetPayViews();
  resetPayChannel();
  resetNotifyChannel();
  resetAdChannel();
  resetRisk();
  resetAudit();
  resetAccounts();
  closeModal(null);
  activeView = 'config';
  $('login-username').value = '';
  $('password').value = '';
  $('login-username').focus();
}

/** 角色默认落点：能看配置 ⇒ 配置；否则财务（全角色可见）。 */
function defaultViewFor() {
  return canView('config') ? 'config' : 'finance';
}

/** 左树按角色显隐 + 身份回显（nav-config-btn 为 hidden 锚点，跳过角色翻转，恒隐）。 */
function applyRoleNav() {
  for (const name of VIEW_ORDER) {
    if (name === 'config') continue;
    $(VIEWS[name].nav).hidden = !canView(name);
  }
  // G12 app.js 针脚：广告回调已并入「广告」配置页，独立入口恒隐（同时兜底防误显）。
  $('nav-ad-channel-btn').hidden = true;
  updateCfgNav();
  $('whoami').textContent = usernameOf() ? `${usernameOf()}（${roleOf()}）` : '';
  $('whoami').hidden = !usernameOf();
}

function showMainView() {
  $('login-view').hidden = true;
  $('main-view').hidden = false;
  $('logout-btn').hidden = false;
  applyRoleNav();
  switchView(canView(activeView) ? activeView : defaultViewFor());
}

/** 共用 #settings-host 的三视图（config / 支付渠道 / 通知通道）。 */
const SETTINGS_VIEWS = new Set(['config', 'payChannel', 'notifyChannel']);

/** 左树视图切换（十一视图）：切 content-host 内 hidden 与叶高亮；各视图**首次**激活时懒加载。 */
function switchView(view) {
  if (!canView(view)) view = defaultViewFor();
  activeView = view;
  for (const name of VIEW_ORDER) {
    // settings-host 被三视图共用：其 hidden 只能按「当前视图是否属于三视图」算一次，
    // 不能在循环里逐名翻转（否则同 el 的末位视图恒赢，config 激活时 host 也被隐藏）。
    if (!SETTINGS_VIEWS.has(name)) $(VIEWS[name].el).hidden = name !== view;
    // config 的 nav 是 hidden 锚点：永不挂 active，配置域高亮落到 5+1 个 nav-cfg-* 叶。
    if (name !== 'config') $(VIEWS[name].nav).classList.toggle('active', name === view);
  }
  $('settings-host').hidden = !SETTINGS_VIEWS.has(view);
  syncCfgLeafActive();
  // #settings-host 内部（设置行 / 凭据两 section）分流。
  if (view === 'config' || view === 'payChannel' || view === 'notifyChannel') {
    renderSettings(view);
  }
  if (view === 'config' && Object.keys(currentConfig).length === 0) loadAll();
  if (view === 'payChannel' && !payChannelState.loaded) loadPayChannel();
  if (view === 'notifyChannel' && !notifyChannelState.loaded) loadNotifyChannel();
  if (view === 'players' && !playersState.loaded) loadPlayers();
  if (view === 'finance' && !fin.loaded) loadFinance();
  if (view === 'payOrders' && !payOrders.loaded) loadPayOrders(true);
  if (view === 'payRefunds' && !payRefunds.loaded) loadPayRefunds(true);
  if (view === 'payWithdrawals' && !payWithdrawals.loaded) loadPayWithdrawals(true);
  if (view === 'risk' && !riskState.loaded) loadRiskQueue(true);
  if (view === 'audit') loadAuditTab(audit.tab);
  if (view === 'accounts' && !accState.loaded) loadAccounts();
}

// ─── 时间范围预设与过滤（③ T10；财务视图与审计「资金操作」页签共用）──────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** 某时刻所在的北京时区自然日 00:00（epoch ms）。北京无夏令时 ⇒ 固定 +08:00 偏移安全。 */
function beijingDayStart(ms) {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    8 * 60 * 60 * 1000
  );
}

/**
 * 时间预设 → `{from?, to?}`（epoch ms；缺省 = 不传该边界）。
 * 「今日」= 北京时间当日 00:00 起 · 近 7/30 天 = 现在回推 · 自定义 = 本机时区解析
 * （datetime-local 值按浏览器本地时区解读，再换算 epoch —— wire 一律 epoch ms）。
 */
function rangeBounds(range, fromEl, toEl) {
  const now = Date.now();
  if (range === 'today') return { from: beijingDayStart(now), to: now + 1 };
  if (range === '7d') return { from: now - 7 * DAY_MS, to: now + 1 };
  if (range === '30d') return { from: now - 30 * DAY_MS, to: now + 1 };
  if (range === 'custom') {
    const out = {};
    const f = fromEl.value ? new Date(fromEl.value).getTime() : NaN;
    const t = toEl.value ? new Date(toEl.value).getTime() : NaN;
    if (Number.isFinite(f) && f >= 0) out.from = f;
    if (Number.isFinite(t) && t >= 0) out.to = t;
    return out;
  }
  return {};
}

/**
 * 账户筛选输入：11+ 位纯数字视为手机号 ⇒ 经 `GET /api/admin/users/lookup` 换算 userId；
 * 其余原样作 ownerId（服务端 `ownerId` 过滤键 = `owner_id` 列）。
 * @returns {Promise<string|null|undefined>} null = 已提示且不应继续；undefined = 空；string = 过滤值。
 */
async function resolveOwnerId(raw) {
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^\d{11,}$/.test(value)) return value;
  const { status, body } = await api(`/api/admin/users/lookup?phone=${encodeURIComponent(value)}`);
  if (handleAuth(status)) return null;
  if (status === 404) {
    showMsg('未找到该手机号', 'warn');
    return null;
  }
  if (status === 0) {
    showMsg('无法连接服务端', 'err');
    return null;
  }
  const userId = body?.data?.userId;
  if (status !== 200 || typeof userId !== 'string' || userId === '') {
    showMsg(`按手机号查询失败（HTTP ${status}）`, 'err');
    return null;
  }
  return userId;
}

/**
 * 账户身份行（③ T9/T10；设计 §「财务/审计视图展示用户身份用」）：`GET /api/admin/users/:userId`
 * ⇒ 在筛选条下方就地显示昵称 / 手机 / 状态。**只按 status 分流**（404 ⇒ 未找到，11004 不读码）。
 */
async function showOwnerIdentity(userId, elId) {
  const el = $(elId);
  el.textContent = '';
  if (!userId) return;
  const { status, body } = await api(`/api/admin/users/${encodeURIComponent(userId)}`);
  if (handleAuth(status)) return;
  if (status === 404) {
    el.textContent = '（未找到该用户）';
    return;
  }
  if (status !== 200 || !body?.data) {
    if (status !== 0) el.textContent = `（身份读取失败 HTTP ${status}）`;
    return;
  }
  const d = body.data;
  el.textContent = `身份：${d.nickname ?? '（无昵称）'} · ${d.phone ?? '—'} · ${d.status}`;
}

/** 流水查询串（keyset：cursor/limit 只在 JSON 路径带；CSV 路径不带 —— 带上即 400）。 */
function opsQuery(filter, cursor, limit) {
  const p = new URLSearchParams();
  if (filter.source) p.set('source', filter.source);
  if (filter.gameType) p.set('gameType', filter.gameType);
  if (filter.actor) p.set('actor', filter.actor);
  if (filter.ownerId) p.set('ownerId', filter.ownerId);
  if (filter.from !== undefined) p.set('from', String(filter.from));
  if (filter.to !== undefined) p.set('to', String(filter.to));
  if (cursor !== null && cursor !== undefined) p.set('cursor', String(cursor));
  if (limit !== null && limit !== undefined) p.set('limit', String(limit));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

// ─── 通用弹窗（冲正原因 / 重置口令共用；③ T10）────────────────────────────────

/** 当前弹窗的 resolve（null = 无弹窗在开）。 */
let modalResolve = null;

/**
 * Promise 形态的单输入弹窗：确定 ⇒ resolve(输入原值)；取消/关闭 ⇒ resolve(null)。
 * 必填/长度只做第一道（DOM 属性 + 调用方兜底），真校验点在服务端。
 */
function modalPrompt({ title, desc = '', placeholder = '', type = 'text', confirmLabel = '确定', maxlength = 0, minlength = 0 }) {
  return new Promise((resolve) => {
    if (modalResolve) modalResolve(null); // 理论上不可达（按钮在途禁用）；防御旧弹窗悬挂。
    modalResolve = resolve;
    $('modal-title').textContent = title;
    $('modal-desc').textContent = desc;
    const input = $('modal-input');
    input.type = type;
    input.placeholder = placeholder;
    input.value = '';
    if (maxlength > 0) input.maxLength = maxlength;
    else input.removeAttribute('maxlength');
    if (minlength > 0) input.minLength = minlength;
    else input.removeAttribute('minlength');
    $('modal-ok').textContent = confirmLabel;
    $('modal').hidden = false;
    input.focus();
  });
}

function closeModal(value) {
  if (modalResolve === null) return;
  const resolve = modalResolve;
  modalResolve = null;
  $('modal').hidden = true;
  $('modal-input').value = '';
  resolve(value);
}

// ─── CSV 下载（③ T10；规格 §2.12：fetch + blob 带 Bearer —— 不能裸 <a>）────────

/** 经 fetch（带 Authorization）取 CSV ⇒ blob ⇒ 临时 `<a download>` 触发保存。 */
async function downloadCsv(path) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  let res;
  try {
    res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    return showMsg('无法连接服务端', 'err');
  }
  if (handleAuth(res.status)) return;
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return showMsg(`导出失败：${body?.message ?? `HTTP ${res.status}`}`, 'err');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : 'export.csv';
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showMsg('已导出 CSV', 'ok');
}

// ─── 钱包调整（货币核心 T9 / 规格 §2.14 六点）────────────────────────────

/**
 * `admin:<uuid>`（§2.14 ④ 的 id 形状）。
 *
 * `crypto.randomUUID` 只在**安全上下文**（https / localhost）可用；管理员偶经明文 IP
 * 打开本页时退回 `getRandomValues` 手拼 v4（该方法无安全上下文限制）。两者都无第三方依赖
 * ——「无构建静态页」的纪律。
 */
function newAdjustActionId() {
  let uuid;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    uuid = crypto.randomUUID();
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `admin:${uuid}`;
}

/** 清空「当前定位的玩家」（目标行隐藏、显示位清空、调整按钮禁用）；不碰输入框。 */
function clearWalletTarget() {
  walletUserId = null;
  adjustActionId = null;
  $('wallet-target').hidden = true;
  $('wallet-user-id').textContent = '';
  $('wallet-balance').textContent = '';
  $('wallet-adjust-btn').disabled = true;
}

/**
 * §2.14 ①：手机号 → userId。**只按 HTTP status 分流**（M1，不读 body.code）：
 * 404 ⇒ 未找到（= 下游 11004 的 HTTP 面；管理面未启用之类的 404 不存在于本端点，
 * 该分支由既有 login 契约把守）· 400 ⇒ 回显原因 · 401 ⇒ 回登录 · 其余 ⇒ 带状态码的通用文案。
 * 成功后显示 userId 并**接着拉当前余额（②）**——「查询手机号 → 显示余额」是一条动作。
 */
async function walletLookup(phone) {
  clearWalletTarget(); // 换目标先清（查询期间与失败后都不允许误调上一个玩家）
  const { status, body } = await api(`/api/admin/users/lookup?phone=${encodeURIComponent(phone)}`);
  if (status === 404) return showMsg('未找到该手机号', 'warn');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status === 401) {
    backToLogin();
    return showMsg('令牌过期，请重新登录', 'err');
  }
  if (status === 0) return showMsg('无法连接服务端', 'err');
  const userId = body?.data?.userId;
  if (status !== 200 || typeof userId !== 'string' || userId === '') {
    return showMsg(`查询失败（HTTP ${status}）`, 'err');
  }
  walletUserId = userId;
  $('wallet-user-id').textContent = userId;
  $('wallet-target').hidden = false;
  $('wallet-adjust-btn').disabled = false;
  showMsg('');
  await walletRefreshBalance(); // ②：显示当前余额（未开户 ⇒ 服务端回 0 的空态）
}

/**
 * §2.14 ②（与 ⑥ 的「刷新 ②」同一函数）：`GET /api/admin/wallet/accounts/:userId`
 * ⇒ 把当前余额写进目标行。只按 status 分流；无目标时 no-op。
 */
async function walletRefreshBalance() {
  if (!walletUserId) return;
  const { status, body } = await api(`/api/admin/wallet/accounts/${encodeURIComponent(walletUserId)}`);
  if (status === 401) {
    backToLogin();
    return showMsg('令牌过期，请重新登录', 'err');
  }
  if (status === 0) return showMsg('无法连接服务端', 'err');
  const balance = body?.data?.balance;
  if (status !== 200 || typeof balance !== 'number') {
    return showMsg(`读取余额失败（HTTP ${status}）`, 'err');
  }
  $('wallet-balance').textContent = String(balance);
}

/**
 * §2.14 ③④⑤⑥：提交调整。分支纪律：
 *
 *  - ④ **actionId 只在没有在途 id 时生成**（= 每次填一次表生成一次）；重试（含网络失败后
 *    重复点击）**原样复用** —— 服务端按 `uk_action_id` 幂等，不会重复发放。
 *    **成功或明确失败**（400/409/401，= 服务端给了裁决）⇒ 清空 ⇒ 下次填表换新；
 *    传输失败 / 未知状态（无裁决）⇒ **保留 id**，原样重试即安全。
 *  - ⑤ 只按 HTTP status 分流（M1 —— 绝不读 body.code）；409 回显服务端 message
 *    （14001 余额不足 / 14002 同 id 异载荷）。
 *  - ⑥ 成功 ⇒ 显示「调整后余额」+ `walletRefreshBalance()` 刷新 ②。
 */
async function walletAdjust(delta, reason) {
  if (!walletUserId) return;
  if (adjustActionId === null) adjustActionId = newAdjustActionId();
  const { status, body } = await api('/api/admin/wallet/adjust', {
    method: 'POST',
    body: JSON.stringify({ userId: walletUserId, delta, reason, actionId: adjustActionId }),
  });
  if (status === 200 && typeof body?.data?.balanceAfter === 'number') {
    adjustActionId = null; // 成功 ⇒ 下一笔换新 id（④）
    showMsg(`调整后余额：${body.data.balanceAfter}`, 'ok');
    await walletRefreshBalance(); // ⑥：刷新 ②
    return;
  }
  if (status === 400) {
    adjustActionId = null; // 明确失败（校验拒绝，必未落账）⇒ 换新 id
    return showMsg(`调整失败：${body?.message ?? ''}`, 'err');
  }
  if (status === 409) {
    adjustActionId = null; // 明确失败（14001/14002）⇒ 换新 id（改金额重来不会撞旧载荷）
    return showMsg(`调整未执行：${body?.message ?? ''}`, 'err');
  }
  if (status === 401) {
    adjustActionId = null;
    backToLogin();
    return showMsg('令牌过期，请重新登录', 'err');
  }
  if (status === 0) {
    return showMsg('无法连接服务端；可原样重试（同一笔不会重复调整）', 'err');
  }
  return showMsg(`调整结果未知（HTTP ${status}）；可原样重试（同一笔不会重复调整）`, 'err');
}

// ─── 财务视图（③ T10；规格 §2.12）────────────────────────────────────────

/** 首次进入财务视图：流水 + 汇总 + 池余额 + 对账面板一起拉。 */
function loadFinance() {
  fin.loaded = true;
  $('rec-run-btn').hidden = !canWalletWrite(); // 角色门面（policy P7；服务端 403 才是闸）
  loadFinFlows(true);
  loadFinSummary();
  loadFinPool();
  loadFinReconcile();
}

/** 点「查询」：解析过滤（含手机号换算）⇒ 重拉流水与汇总。 */
async function financeSearch() {
  const owner = await resolveOwnerId($('fin-owner').value);
  if (owner === null) return;
  const bounds = rangeBounds($('fin-range').value, $('fin-from'), $('fin-to'));
  fin.filter = {
    source: $('fin-source').value,
    gameType: $('fin-game-type').value,
    actor: $('fin-actor').value.trim(),
    ownerId: owner ?? '',
    from: bounds.from,
    to: bounds.to,
  };
  showOwnerIdentity(fin.filter.ownerId, 'fin-owner-info');
  await loadFinFlows(true);
  await loadFinSummary();
}

/** 过滤控件复位（不含数据面；登出与「重置」共用）。 */
function resetFinControls() {
  $('fin-source').value = '';
  $('fin-game-type').value = '';
  $('fin-actor').value = '';
  $('fin-owner').value = '';
  $('fin-owner-info').textContent = '';
  $('fin-range').value = '';
  $('fin-custom').hidden = true;
  $('fin-from').value = '';
  $('fin-to').value = '';
}

/** 流水列表：reset ⇒ 清空重拉第一页；否则按 nextCursor 追加（keyset 加载更多）。 */
async function loadFinFlows(reset) {
  if (fin.loading) return;
  fin.loading = true;
  const cursor = reset ? null : fin.nextCursor;
  const { status, body } = await api(`/api/admin/wallet/ops${opsQuery(fin.filter, cursor, PAGE_LIMIT)}`);
  fin.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.rows)) {
    return showMsg(`加载流水失败（HTTP ${status}）`, 'err');
  }
  if (reset) {
    fin.rows = [];
    $('fin-flows-body').textContent = '';
  }
  for (const row of body.data.rows) {
    fin.rows.push(row);
    $('fin-flows-body').append(buildFinFlowRow(row));
  }
  fin.nextCursor = body.data.nextCursor ?? null;
  $('fin-more-btn').hidden = fin.nextCursor === null;
  $('fin-flows-empty').textContent = fin.rows.length === 0 ? '（无流水）' : '';
}

/** 时间单元格（北京时间口径的展示面）。
 *  ⚠️ 「（北京）」是**页面时区口径**的说明文案，不是数据 —— 值本身由 fmtTime 定。 */
function timeCell(ms) {
  const td = document.createElement('td');
  td.textContent = fmtTime(ms);
  return td;
}

function textCell(value, { num = false } = {}) {
  const td = document.createElement('td');
  td.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
  if (num) td.className = 'num';
  return td;
}

/** A2：玩法中文标签（null/undefined = 未标注/非游戏流水）。 */
function gameLabelText(gameType) {
  if (gameType === 'doudizhu') return '斗地主';
  if (gameType === 'paodekuai') return '跑得快';
  return '—';
}

/** 流水行（财务视图：12 列，末列 = 操作）行内「冲正」仅 admin_adjust 且未冲正且角色可写时显示。 */
function buildFinFlowRow(row) {
  const tr = document.createElement('tr');
  tr.append(
    textCell(row.flowId),
    timeCell(row.createdAt),
    textCell(row.source),
    textCell(gameLabelText(row.gameType)),
    textCell(row.actor),
    textCell(row.ownerId),
    textCell(row.nickname),
    textCell(row.phone),
    textCell(row.delta, { num: true }),
    textCell(row.balanceAfter, { num: true }),
    textCell(row.reason),
  );
  const ops = document.createElement('td');
  const detailBtn = document.createElement('button');
  detailBtn.type = 'button';
  detailBtn.className = 'btn mini';
  detailBtn.textContent = '详情';
  detailBtn.addEventListener('click', () => toggleFinDetail(tr, row));
  ops.append(detailBtn);
  if (row.source === 'admin_adjust' && row.reversed !== true && canWalletWrite()) {
    const revBtn = document.createElement('button');
    revBtn.type = 'button';
    revBtn.className = 'btn mini';
    revBtn.textContent = '冲正';
    revBtn.addEventListener('click', () => reverseOp(row.opId));
    ops.append(revBtn);
  }
  if (row.reversed === true) {
    const tag = document.createElement('span');
    tag.className = 'tag-reversed';
    tag.textContent = '已冲正';
    ops.append(tag);
  }
  tr.append(ops);
  return tr;
}

/** 详情展开/收起（消费 `GET /api/admin/wallet/ops/:opId` 的 **`data.rows`** —— T6 裁定形状）。 */
async function toggleFinDetail(tr, row) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) {
    next.remove();
    return;
  }
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 12;
  td.textContent = '详情加载中…';
  detail.append(td);
  tr.after(detail);
  const { status, body } = await api(`/api/admin/wallet/ops/${row.opId}`);
  if (handleAuth(status)) return;
  if (status === 404) {
    td.textContent = '操作不存在';
    return;
  }
  if (status === 0) {
    td.textContent = '无法连接服务端';
    return;
  }
  const rows = body?.data?.rows;
  if (status !== 200 || !Array.isArray(rows) || rows.length === 0) {
    td.textContent = `加载详情失败（HTTP ${status}）`;
    return;
  }
  renderFinDetail(td, rows);
}

/** 详情面：op 级锚点（actionId/refId/traceId）+ 该 op 全部 flows（含 traceId 列）。 */
function renderFinDetail(td, rows) {
  td.textContent = '';
  const first = rows[0];
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent =
    `op #${first.opId} · actionId=${first.actionId} · 玩法=${gameLabelText(first.gameType)} · ` +
    `refId=${first.refId ?? '—'} · traceId=${first.traceId ?? '—'} · 原因=${first.reason ?? '—'}`;
  td.append(info);
  if (
    first.burnedResidue !== null &&
    first.burnedResidue !== undefined &&
    first.burnedRake !== null &&
    first.burnedRake !== undefined
  ) {
    const burn = document.createElement('p');
    burn.className = 'hint';
    burn.textContent = `销毁：残差 ${first.burnedResidue} · 抽水 ${first.burnedRake}`;
    td.append(burn);
  }
  const table = document.createElement('table');
  table.className = 'data-table nested';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['流水ID', '时间（北京）', '账户ID', '类型', '金额', '操作后余额', 'traceId']) {
    const th = document.createElement('th');
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.append(
      textCell(r.flowId),
      timeCell(r.createdAt),
      textCell(r.ownerId),
      textCell(r.ownerType),
      textCell(r.delta, { num: true }),
      textCell(r.balanceAfter, { num: true }),
      textCell(r.traceId),
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  td.append(table);
}

/** 行内「冲正」（policy P6：super_admin/finance；弹窗必填原因 1..200）。 */
async function reverseOp(opId) {
  const reason = await modalPrompt({
    title: `冲正操作 #${opId}`,
    desc: '按原操作整笔取负回滚（不可撤销）。原因必填：1–200 字。',
    placeholder: '冲正原因（如：误发）',
    confirmLabel: '确认冲正',
    maxlength: 200,
  });
  if (reason === null) return;
  const trimmed = reason.trim();
  if (trimmed === '') return showMsg('请填写冲正原因', 'err');
  const { status, body } = await api('/api/admin/wallet/reverse', {
    method: 'POST',
    body: JSON.stringify({ opId, reason: trimmed }),
  });
  if (status === 200 && body?.data) {
    showMsg(
      body.data.replayed
        ? '该操作此前已按同一原因冲正过（本次为重放，不重复回转）'
        : `冲正完成（冲正操作 #${body.data.opId}）`,
      'ok',
    );
  } else if (status === 409) {
    showMsg(`冲正未执行：${body?.message ?? '该操作已冲正'}`, 'err');
  } else if (status === 400) {
    return showMsg(`冲正失败：${body?.message ?? ''}`, 'err');
  } else if (status === 403) {
    return showMsg('当前角色不允许冲正', 'err');
  } else if (status === 404) {
    return showMsg('操作不存在', 'err');
  } else if (!handleAuth(status)) {
    if (status === 0) return showMsg('无法连接服务端', 'err');
    return showMsg(`冲正结果未知（HTTP ${status}）—— 可刷新流水核实`, 'err');
  } else {
    return;
  }
  await financeSearch(); // 刷新列表（reversed 旗 / 余额联动）
}

/** 汇总卡（按来源/按日切换 + totals；窗口沿用筛选条的时间边界，缺省 = 服务端 30 天）。 */
async function loadFinSummary() {
  const p = new URLSearchParams();
  p.set('groupBy', fin.summaryGroupBy);
  if (fin.filter.from !== undefined) p.set('from', String(fin.filter.from));
  if (fin.filter.to !== undefined) p.set('to', String(fin.filter.to));
  const { status, body } = await api(`/api/admin/wallet/summary?${p.toString()}`);
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status !== 200 || !body?.data) return showMsg(`加载汇总失败（HTTP ${status}）`, 'err');
  renderFinSummary(body.data);
}

function renderFinSummary(data) {
  const head = $('fin-summary-head');
  const body = $('fin-summary-body');
  head.textContent = '';
  body.textContent = '';
  const hr = document.createElement('tr');
  const labels =
    fin.summaryGroupBy === 'day'
      ? ['日期（北京）', '玩法', '金额合计', '流水笔数']
      : ['来源', '玩法', '金额合计', '流水笔数'];
  for (const label of labels) {
    const th = document.createElement('th');
    th.textContent = label;
    hr.append(th);
  }
  head.append(hr);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = '（无数据）';
    tr.append(td);
    body.append(tr);
  } else {
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.append(
        textCell(row.k),
        textCell(gameLabelText(row.gameType)),
        textCell(row.delta, { num: true }),
        textCell(row.flowCount, { num: true }),
      );
      body.append(tr);
    }
  }
  const totals = data.totals ?? { delta: 0, flowCount: 0 };
  $('fin-summary-totals').textContent = `合计：金额 ${totals.delta} · 笔数 ${totals.flowCount}`;
  const burn = data && typeof data.burn === 'object' && data.burn !== null ? data.burn : null;
  const burnLine = $('fin-burn-line');
  if (burn === null) {
    burnLine.textContent = '';
  } else {
    const note = burn.unrecordedOps > 0 ? `（含 ${burn.unrecordedOps} 条历史未记录）` : '';
    const byGame = Array.isArray(data?.burnByGame) ? data.burnByGame : [];
    const detail = byGame.length
      ? `｜按玩法：${byGame
          .map((b) => `${gameLabelText(b.gameType)} 残差 ${b.residue}/抽水 ${b.rake}`)
          .join(' · ')}`
      : '';
    burnLine.textContent = `销毁：残差 ${burn.residue} · 抽水 ${burn.rake}${note}${detail}`;
  }
  const skips =
    data && typeof data.entryFeeSkips === 'object' && data.entryFeeSkips !== null ? data.entryFeeSkips : null;
  const skipLine = $('fin-entryfee-skip-line');
  if (skips === null) {
    skipLine.textContent = '';
  } else {
    // 恒显（照 burn 行先例；0/0/0 也是有效读数——「本周零漏收」是运维要看的信息）。
    const byGame = Array.isArray(data?.entryFeeSkipsByGame) ? data.entryFeeSkipsByGame : [];
    const detail = byGame.length
      ? `｜按玩法：${byGame
          .map((s) => `${gameLabelText(s.gameType)} 笔数 ${s.cnt}/人数 ${s.players}/金额 ${s.amount}`)
          .join(' · ')}`
      : '';
    skipLine.textContent = `台费漏收：笔数 ${skips.cnt} · 人数 ${skips.players} · 金额 ${skips.amount}${detail}`;
  }
  // 记牌器收费片：购买（收入；正）/ 使用（含 none = 未开通局次）。
  const purchases = Array.isArray(data?.cardCounterPurchases) ? data.cardCounterPurchases : null;
  const purchaseLine = $('fin-cardcounter-purchases-line');
  if (purchases === null) {
    purchaseLine.textContent = '';
  } else {
    const pick = (kind) => purchases.find((p) => p?.kind === kind) ?? { count: 0, players: 0, amount: 0 };
    const game = pick('game');
    const hour = pick('hour');
    purchaseLine.textContent = `记牌器购买（收入）：单局卡 ${game.count} 笔 / ${game.players} 人 / ${game.amount} 金币 · 包时卡 ${hour.count} 笔 / ${hour.players} 人 / ${hour.amount} 金币`;
  }
  const consumptions = Array.isArray(data?.cardCounterConsumptions)
    ? data.cardCounterConsumptions
    : null;
  const consumptionLine = $('fin-cardcounter-consumptions-line');
  if (consumptions === null) {
    consumptionLine.textContent = '';
  } else {
    const pick = (kind) => consumptions.find((c) => c?.kind === kind) ?? { count: 0, players: 0 };
    const pass = pick('pass');
    const credit = pick('credit');
    const none = pick('none');
    consumptionLine.textContent = `记牌器使用：包时 ${pass.count} 局 · 单局卡 ${credit.count} 局 · 未开通 ${none.count} 局`;
  }
}

/** 机器人虚拟池卡：`GET /api/admin/wallet/accounts/robot-pool` 的余额。 */
async function loadFinPool() {
  const { status, body } = await api('/api/admin/wallet/accounts/robot-pool');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  const balance = body?.data?.balance;
  if (status !== 200 || typeof balance !== 'number') {
    $('fin-pool-balance').textContent = '（读取失败）';
    return;
  }
  $('fin-pool-balance').textContent = String(balance);
}

/** 对账面板状态四字段 + running（内存态；新进程前四项 null = 「未知」，如实呈现）。 */
async function loadFinReconcile() {
  const { status, body } = await api('/api/admin/wallet/reconcile');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status !== 200 || !body?.data) return showMsg(`加载对账状态失败（HTTP ${status}）`, 'err');
  const d = body.data;
  $('rec-last-attempt').textContent = fmtTime(d.lastAttemptAt);
  $('rec-last-success').textContent = fmtTime(d.lastSuccessAt);
  $('rec-last-result').textContent = d.lastResult ? formatReconcileResult(d.lastResult) : '—';
  $('rec-last-error').textContent = d.lastError ?? '—';
  $('rec-running').hidden = !d.running;
  $('rec-run-btn').disabled = Boolean(d.running) || !canWalletWrite();
}

/** 一轮读数 → 单行文本（字段名 = `CurrencyReconcileRoundResult`）。 */
function formatReconcileResult(r) {
  return (
    `账实不符 ${r.driftAccounts} · 缓存清理 ${r.cacheDriftDeleted} · 孤儿赠送 ${r.orphanSignupGrants}` +
    ` · 池余额 ${r.robotPoolBalance} · 机器人合计 ${r.robotAccountsBalanceSum}`
  );
}

/** 「立即对账」（policy P7：super_admin/finance；在跑 ⇒ 409 借 10001「对账正在运行」）。 */
async function runReconcile() {
  const btn = $('rec-run-btn');
  btn.disabled = true;
  const { status, body } = await api('/api/admin/wallet/reconcile/run', { method: 'POST' });
  if (status === 200 && body?.data) {
    showMsg(`对账完成：${formatReconcileResult(body.data)}`, 'ok');
  } else if (status === 409) {
    showMsg(body?.message ?? '对账正在运行', 'warn');
  } else if (status === 403) {
    showMsg('当前角色不允许手动对账', 'err');
  } else if (!handleAuth(status)) {
    if (status === 0) showMsg('无法连接服务端', 'err');
    else showMsg(`对账失败（HTTP ${status}）`, 'err');
  }
  await loadFinReconcile(); // 成败都刷新面板（失败也会刷 lastError/lastAttemptAt）
}

/** 登出/退出时清财务视图的数据面与控件（DOM 不残留）。 */
function resetFinance() {
  fin.rows = [];
  fin.nextCursor = null;
  fin.loading = false;
  fin.loaded = false;
  fin.filter = { source: '', actor: '', ownerId: '', from: undefined, to: undefined };
  fin.summaryGroupBy = 'source';
  resetFinControls();
  $('fin-flows-body').textContent = '';
  $('fin-flows-empty').textContent = '';
  $('fin-more-btn').hidden = true;
  $('fin-summary-head').textContent = '';
  $('fin-summary-body').textContent = '';
  $('fin-summary-totals').textContent = '';
  $('fin-burn-line').textContent = '';
  $('fin-entryfee-skip-line').textContent = '';
  $('fin-summary-source-btn').classList.add('active');
  $('fin-summary-day-btn').classList.remove('active');
  $('fin-pool-balance').textContent = '—';
  $('rec-last-attempt').textContent = '—';
  $('rec-last-success').textContent = '—';
  $('rec-last-result').textContent = '—';
  $('rec-last-error').textContent = '—';
  $('rec-running').hidden = true;
  $('rec-run-btn').disabled = false;
}

// ─── 支付三视图（支付片 T12；规格 §2.4.2 / §5；授权 = 网关 P-p1..P-p7）──────────────

/** 订单查询串（keyset：`cursor` 只在 JSON 路径带；CSV 路径不带 —— 带上即 400 未知键）。 */
function payOrdersQuery(filter, cursor) {
  const p = new URLSearchParams();
  if (filter.status) p.set('status', filter.status);
  if (filter.userId) p.set('userId', filter.userId);
  if (filter.from !== undefined) p.set('from', String(filter.from));
  if (filter.to !== undefined) p.set('to', String(filter.to));
  if (cursor !== null && cursor !== undefined) p.set('cursor', String(cursor));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** 退款/提现查询串（无分页：无 cursor/limit 概念）。 */
function payListQuery(filter) {
  const p = new URLSearchParams();
  if (filter.status) p.set('status', filter.status);
  if (filter.userId) p.set('userId', filter.userId);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** 订单视图：查询（解析时间预设 ⇒ 重拉第一页）。 */
async function payOrdersSearch() {
  const bounds = rangeBounds($('po-range').value, $('po-from'), $('po-to'));
  payOrders.filter = {
    status: $('po-status').value,
    userId: $('po-user').value.trim(),
    from: bounds.from,
    to: bounds.to,
  };
  await loadPayOrders(true);
}

/** 订单列表：reset ⇒ 清空重拉第一页（连带收掉行内详情）；否则按 nextCursor 追加。 */
async function loadPayOrders(reset) {
  if (payOrders.loading) return;
  payOrders.loading = true;
  const cursor = reset ? null : payOrders.nextCursor;
  const { status, body } = await api(`/api/admin/pay/orders${payOrdersQuery(payOrders.filter, cursor)}`);
  payOrders.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.items)) {
    return showMsg(`加载支付订单失败（HTTP ${status}）`, 'err');
  }
  if (reset) {
    payOrders.rows = [];
    $('po-body').textContent = '';
  }
  for (const row of body.data.items) {
    payOrders.rows.push(row);
    $('po-body').append(buildPayOrderRow(row));
  }
  payOrders.nextCursor = body.data.nextCursor ?? null;
  payOrders.loaded = true;
  $('po-more-btn').hidden = payOrders.nextCursor === null;
  $('po-empty').textContent = payOrders.rows.length === 0 ? '（无订单）' : '';
}

/** 订单行（13 列；末列「详情」展开 notify_log 尾 20——一切数据 textContent）。 */
function buildPayOrderRow(row) {
  const tr = document.createElement('tr');
  tr.append(
    textCell(row.orderNo),
    textCell(row.userId),
    textCell(row.packageYuan, { num: true }),
    textCell(row.amountFen, { num: true }),
    textCell(row.coins, { num: true }),
    textCell(row.status),
    textCell(row.channel),
    textCell(row.tradeNo),
    timeCell(row.paidAt),
    timeCell(row.creditedAt),
    timeCell(row.closedAt),
    timeCell(row.createdAt),
  );
  const ops = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn mini';
  btn.textContent = '详情';
  btn.addEventListener('click', () => togglePayOrderDetail(tr, row.orderNo));
  ops.append(btn);
  tr.append(ops);
  return tr;
}

/** 订单详情展开/收起：`GET /api/admin/pay/orders/:orderNo` ⇒ 通知日志尾 20 条子表。 */
async function togglePayOrderDetail(tr, orderNo) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) {
    next.remove();
    return;
  }
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 13;
  td.textContent = '详情加载中…';
  detail.append(td);
  tr.after(detail);
  const { status, body } = await api(`/api/admin/pay/orders/${encodeURIComponent(orderNo)}`);
  if (handleAuth(status)) return;
  if (status === 404) {
    td.textContent = '订单不存在';
    return;
  }
  if (status === 0) {
    td.textContent = '无法连接服务端';
    return;
  }
  if (status !== 200 || !body?.data) {
    td.textContent = `加载详情失败（HTTP ${status}）`;
    return;
  }
  renderPayOrderDetail(td, body.data);
}

/** 订单详情面：首行摘要 + notify_log 子表（result/tradeStatus/amountFen/clientIp/receivedAt）。 */
function renderPayOrderDetail(td, d) {
  td.textContent = '';
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent =
    `订单 ${d.orderNo} · 状态 ${d.status} · ${d.packageYuan} 元 = ${d.coins} 金币（${d.amountFen} 分）` +
    ` · 渠道 ${d.channel} · 渠道单号 ${d.tradeNo ?? '—'}`;
  td.append(info);
  const logs = Array.isArray(d.notifyLog) ? d.notifyLog : [];
  const title = document.createElement('p');
  title.className = 'hint risk-sub';
  title.textContent = `通知日志（最近 ${logs.length} 条；仅记验签通过件）`;
  td.append(title);
  const table = document.createElement('table');
  table.className = 'data-table nested';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['时间（北京）', '结果', '渠道状态', '金额（分）', '来源 IP']) {
    const th = document.createElement('th');
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  if (logs.length === 0) {
    const tr2 = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = '（无通知记录）';
    tr2.append(cell);
    tbody.append(tr2);
  }
  for (const log of logs) {
    const tr2 = document.createElement('tr');
    tr2.append(
      timeCell(log.receivedAt),
      textCell(log.result),
      textCell(log.tradeStatus),
      textCell(log.amountFen, { num: true }),
      textCell(log.clientIp),
    );
    tbody.append(tr2);
  }
  table.append(thead, tbody);
  td.append(table);
}

/** 退款视图：查询（控件直读 ⇒ 重拉）。 */
async function payRefundsSearch() {
  payRefunds.filter = { status: $('rf-status').value, userId: $('rf-user').value.trim() };
  await loadPayRefunds(true);
}

/** 退款列表（无分页；行内操作按钮 = canPayWrite 门面 + 状态前置条件）。 */
async function loadPayRefunds(reset) {
  if (payRefunds.loading) return;
  payRefunds.loading = true;
  const { status, body } = await api(`/api/admin/pay/refunds${payListQuery(payRefunds.filter)}`);
  payRefunds.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.items)) {
    return showMsg(`加载退款单失败（HTTP ${status}）`, 'err');
  }
  payRefunds.rows = body.data.items;
  payRefunds.loaded = true;
  const tbody = $('rf-body');
  tbody.textContent = '';
  for (const row of payRefunds.rows) {
    tbody.append(buildPayRefundRow(row));
  }
  $('rf-empty').textContent = payRefunds.rows.length === 0 ? '（无退款单）' : '';
}

/** 退款行（11 列；操作 = 通过[仅 pending] / 驳回[pending|approved]，角色门面之外全隐）。 */
function buildPayRefundRow(row) {
  const tr = document.createElement('tr');
  tr.append(
    textCell(row.refundNo),
    textCell(row.orderNo),
    textCell(row.userId),
    textCell(row.coins, { num: true }),
    textCell(row.status),
    textCell(row.reason),
    textCell(row.reviewedBy),
    timeCell(row.reviewedAt),
    timeCell(row.refundedAt),
    timeCell(row.createdAt),
  );
  const ops = document.createElement('td');
  if (canPayWrite()) {
    if (row.status === 'pending') {
      ops.append(payActionBtn('通过', () => reviewPayRefund(row.refundNo, 'approve')));
    }
    if (row.status === 'pending' || row.status === 'approved') {
      ops.append(payActionBtn('驳回', () => reviewPayRefund(row.refundNo, 'reject')));
    }
  }
  tr.append(ops);
  return tr;
}

/** 小按钮工厂（支付三视图共用；类名/禁用纪律照既有 btn mini）。 */
function payActionBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn mini';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    btn.disabled = true; // 在途禁用（双击保护；成败路径都会重拉列表）
    onClick().finally(() => {
      if (btn.isConnected) btn.disabled = false;
    });
  });
  return btn;
}

/**
 * 退款审（通过/驳回）。**只按 HTTP status 分流**（M1）；409 回显服务端 message（15009）。
 * ⚠️ 通过 = 服务端就地渠道退避（最长约 12.6 分钟）：网关 5 秒兜底超时可能先回 503/10007
 *（或网络层 0）——**服务端仍在继续**；提示按实际态稍后刷新（重复审批由 15009 兜底）。
 */
async function reviewPayRefund(refundNo, action) {
  let note;
  if (action === 'approve') {
    note = await modalPrompt({
      title: `通过退款 ${refundNo}`,
      desc: '通过后立即向支付渠道发起原路退款（真实资金）。渠道不可用时服务端会持续重试（最长约 12 分钟）——若页面提示超时/网关错误，服务端可能仍在处理：请稍后刷新列表看实际状态。附言可空。',
      placeholder: '审核附言（可空）',
      confirmLabel: '确认通过',
      maxlength: 255,
    });
  } else {
    note = await modalPrompt({
      title: `驳回退款 ${refundNo}`,
      desc: '驳回将回滚冻结（金币退回玩家余额）；附言可空。',
      placeholder: '审核附言（可空）',
      confirmLabel: '确认驳回',
      maxlength: 255,
    });
  }
  if (note === null) return; // 取消
  const trimmed = note.trim();
  const { status, body } = await api(`/api/admin/pay/refunds/${encodeURIComponent(refundNo)}/review`, {
    method: 'POST',
    body: JSON.stringify({ action, ...(trimmed !== '' ? { note: trimmed } : {}) }),
  });
  if (status === 200) {
    showMsg(`退款 ${refundNo}：${body?.data?.status ?? '已受理'}`, 'ok');
    await loadPayRefunds(true);
    return;
  }
  if (status === 409) {
    showMsg(`未执行：${body?.message ?? '状态已变更'}`, 'err');
    await loadPayRefunds(true); // 服务端态为准（15009 的 message 要求刷新后重试）
    return;
  }
  if (status === 400) return showMsg(`未执行：${body?.message ?? ''}`, 'err');
  if (status === 403) return showMsg('当前角色不允许该操作', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  // 503（网关 5s 兜底超时，10007）/ 其余未知：长挂面按「服务端可能仍在处理」提示。
  showMsg(`请求未在网关时限内返回（HTTP ${status}）——审批可能仍在服务端处理渠道退款，请稍后刷新核实`, 'warn');
}

/** 提现视图：查询。 */
async function payWithdrawalsSearch() {
  payWithdrawals.filter = { status: $('ws-status').value, userId: $('ws-user').value.trim() };
  await loadPayWithdrawals(true);
}

/** 提现列表（无分页；行内 = 详情[pending/approved/rolling_back 均有价值] + 通过/驳回/登记打款）。 */
async function loadPayWithdrawals(reset) {
  if (payWithdrawals.loading) return;
  payWithdrawals.loading = true;
  const { status, body } = await api(`/api/admin/pay/withdrawals${payListQuery(payWithdrawals.filter)}`);
  payWithdrawals.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.items)) {
    return showMsg(`加载提现单失败（HTTP ${status}）`, 'err');
  }
  payWithdrawals.rows = body.data.items;
  payWithdrawals.loaded = true;
  const tbody = $('ws-body');
  tbody.textContent = '';
  for (const row of payWithdrawals.rows) {
    tbody.append(buildPayWithdrawalRow(row));
  }
  $('ws-empty').textContent = payWithdrawals.rows.length === 0 ? '（无提现单）' : '';
}

/** 提现行（11 列；操作 = 详情 + 通过[pending] / 驳回[pending|approved] / 登记打款[approved]）。 */
function buildPayWithdrawalRow(row) {
  const tr = document.createElement('tr');
  tr.append(
    textCell(row.withdrawNo),
    textCell(row.userId),
    textCell(row.coins, { num: true }),
    textCell(row.status),
    timeCell(row.timeoutAt),
    textCell(row.reviewedBy),
    textCell(row.confirmedBy),
    textCell(row.voucher),
    timeCell(row.rolledBackAt),
    timeCell(row.createdAt),
  );
  const ops = document.createElement('td');
  ops.append(payActionBtn('详情', () => togglePayWithdrawalDetail(tr, row.withdrawNo)));
  if (canPayWrite()) {
    if (row.status === 'pending') {
      ops.append(payActionBtn('通过', () => reviewPayWithdrawal(row.withdrawNo, 'approve')));
    }
    if (row.status === 'pending' || row.status === 'approved') {
      ops.append(payActionBtn('驳回', () => reviewPayWithdrawal(row.withdrawNo, 'reject')));
    }
    if (row.status === 'approved') {
      ops.append(payActionBtn('登记打款', () => confirmPayWithdrawal(row.withdrawNo)));
    }
  }
  tr.append(ops);
  return tr;
}

/** 提现详情展开/收起：行 + 余额/可离场额度快照读（RPC 失败 ⇒ 409 文案回显——不伪造 0）。 */
async function togglePayWithdrawalDetail(tr, withdrawNo) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) {
    next.remove();
    return;
  }
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 11;
  td.textContent = '详情加载中…';
  detail.append(td);
  tr.after(detail);
  const { status, body } = await api(`/api/admin/pay/withdrawals/${encodeURIComponent(withdrawNo)}`);
  if (handleAuth(status)) return;
  if (status === 404) {
    td.textContent = '提现单不存在';
    return;
  }
  if (status === 0) {
    td.textContent = '无法连接服务端';
    return;
  }
  if (status !== 200 || !body?.data) {
    td.textContent = `加载详情失败（HTTP ${status}）：${body?.message ?? ''}`;
    return;
  }
  const d = body.data;
  td.textContent =
    `玩家 ${d.userId} · 当前余额 ${d.balance} 金币 · 可离场额度 ${d.withdrawable} 金币（快照读；非打款依据）`;
}

/** 提现审（通过/驳回；口径同退款审——只按 status 分流）。 */
async function reviewPayWithdrawal(withdrawNo, action) {
  let note;
  if (action === 'approve') {
    note = await modalPrompt({
      title: `通过提现 ${withdrawNo}`,
      desc: '通过后等待线下打款，完成后在本页「登记打款」填凭证号。附言可空。',
      placeholder: '审核附言（可空）',
      confirmLabel: '确认通过',
      maxlength: 255,
    });
  } else {
    note = await modalPrompt({
      title: `驳回提现 ${withdrawNo}`,
      desc: '驳回将回滚冻结（金币退回玩家余额）；附言可空。',
      placeholder: '审核附言（可空）',
      confirmLabel: '确认驳回',
      maxlength: 255,
    });
  }
  if (note === null) return;
  const trimmed = note.trim();
  const { status, body } = await api(`/api/admin/pay/withdrawals/${encodeURIComponent(withdrawNo)}/review`, {
    method: 'POST',
    body: JSON.stringify({ action, ...(trimmed !== '' ? { note: trimmed } : {}) }),
  });
  if (status === 200) {
    showMsg(`提现 ${withdrawNo}：${body?.data?.status ?? '已受理'}`, 'ok');
    await loadPayWithdrawals(true);
    return;
  }
  if (status === 409) {
    showMsg(`未执行：${body?.message ?? '状态已变更'}`, 'err');
    await loadPayWithdrawals(true);
    return;
  }
  if (status === 400) return showMsg(`未执行：${body?.message ?? ''}`, 'err');
  if (status === 403) return showMsg('当前角色不允许该操作', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`操作结果未知（HTTP ${status}）；请刷新列表核实`, 'err');
}

/** 登记打款（两步弹窗：凭证号必填 ≤64 ⇒ 附言可空）——`POST …/confirm`。 */
async function confirmPayWithdrawal(withdrawNo) {
  const voucherRaw = await modalPrompt({
    title: `登记打款 · ${withdrawNo}`,
    desc: '填线下打款凭证号（如银行流水号，≤64 字符）。未登记 = 未打款；登记后订单转「已打款」。',
    placeholder: '打款凭证号',
    confirmLabel: '下一步',
    maxlength: 64,
  });
  if (voucherRaw === null) return;
  const voucher = voucherRaw.trim();
  if (voucher === '') return showMsg('请填写打款凭证号', 'err');
  const noteRaw = await modalPrompt({
    title: `登记打款 · ${withdrawNo}`,
    desc: `凭证号：${voucher}。附言可空。`,
    placeholder: '打款附言（可空）',
    confirmLabel: '确认登记',
    maxlength: 255,
  });
  if (noteRaw === null) return;
  const note = noteRaw.trim();
  const { status, body } = await api(`/api/admin/pay/withdrawals/${encodeURIComponent(withdrawNo)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ voucher, ...(note !== '' ? { note } : {}) }),
  });
  if (status === 200) {
    showMsg(`提现 ${withdrawNo}：${body?.data?.status ?? '已登记'}`, 'ok');
    await loadPayWithdrawals(true);
    return;
  }
  if (status === 409) {
    showMsg(`未执行：${body?.message ?? '状态已变更'}`, 'err');
    await loadPayWithdrawals(true);
    return;
  }
  if (status === 400) return showMsg(`未执行：${body?.message ?? ''}`, 'err');
  if (status === 403) return showMsg('当前角色不允许该操作', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`操作结果未知（HTTP ${status}）；请刷新列表核实`, 'err');
}

/** 登出/退出时清三支付视图的数据面与控件（DOM 不残留）。 */
function resetPayViews() {
  payOrders.rows = [];
  payOrders.nextCursor = null;
  payOrders.loading = false;
  payOrders.loaded = false;
  payOrders.filter = { status: '', userId: '', from: undefined, to: undefined };
  payRefunds.rows = [];
  payRefunds.loading = false;
  payRefunds.loaded = false;
  payRefunds.filter = { status: '', userId: '' };
  payWithdrawals.rows = [];
  payWithdrawals.loading = false;
  payWithdrawals.loaded = false;
  payWithdrawals.filter = { status: '', userId: '' };
  $('po-status').value = '';
  $('po-user').value = '';
  $('po-range').value = '';
  $('po-custom').hidden = true;
  $('po-from').value = '';
  $('po-to').value = '';
  $('po-body').textContent = '';
  $('po-empty').textContent = '';
  $('po-more-btn').hidden = true;
  $('rf-status').value = '';
  $('rf-user').value = '';
  $('rf-body').textContent = '';
  $('rf-empty').textContent = '';
  $('ws-status').value = '';
  $('ws-user').value = '';
  $('ws-body').textContent = '';
  $('ws-empty').textContent = '';
}

// ─── 支付渠道视图（支付配置管理化片 T10；规格 §2.8）─────────────────────

/** 槽名 = 键的末段（规格 §2.8：键名含 `.`，**不得**整键拼进 class —— 选择器面只用槽名）。 */
function payChannelSlot(key) {
  return String(key).split('.').pop();
}

/**
 * 首次激活懒加载（照既有 switchView 机制）：`GET /api/admin/pay-channel` ⇒ 渲染六行。
 * 只按 HTTP status 分流（M1；绝不读 body.code）：401 ⇒ 回登录 · 503 ⇒ 缺主钥文案（⚙️18）。
 * 六行由响应驱动（顺序即响应序；不硬编码键表 —— §2.8）。
 */
async function loadPayChannel() {
  if (payChannelState.loading) return;
  payChannelState.loading = true;
  const { status, body } = await api('/api/admin/pay-channel');
  payChannelState.loading = false;
  if (handleAuth(status)) return;
  if (status === 503) return showMsg('渠道密钥存储未启用（缺主钥）', 'err');
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status !== 200 || !Array.isArray(body?.data?.keys)) {
    return showMsg(`加载支付渠道配置失败（HTTP ${status}）`, 'err');
  }
  payChannelState.rows = body.data.keys;
  payChannelState.loaded = true;
  renderPayChannel();
}

/** 渲染六行（顺序即响应序）。写控件（保存 / 清空）仅 super_admin 渲染 —— 门面；后端 policy 才是真门。 */
function renderPayChannel() {
  const box = $('pay-channel-rows');
  box.textContent = '';
  const canWrite = roleOf() === 'super_admin';
  for (const item of payChannelState.rows) {
    box.append(buildPayChannelRow(item, canWrite));
  }
}

/**
 * 单行：label / 状态文本 / 值显示位 / 输入框 / 保存 / 清空（规格 §2.8 逐字）。
 *  - 非密键：值明文进 `<code>`；输入框**留空**（不预填值，防误覆盖）；
 *  - 私钥：状态 = `已配置 ✓ · 指纹 <12hex>` 或 `未配置`（`value` 恒 null —— 只写不读）；
 *    输入 `type=password` + 粘贴友好 placeholder。
 *  - 稳定选择器（槽名 = 键末段）：`.pay-channel-row-{slot}` / `.pay-channel-save-{slot}` /
 *    `.pay-channel-clear-{slot}`。
 */
function buildPayChannelRow(item, canWrite) {
  const slot = payChannelSlot(item.key);
  const row = document.createElement('div');
  row.className = 'pay-channel-row pay-channel-row-' + slot;

  const label = document.createElement('span');
  label.className = 'pay-channel-label';
  label.textContent = item.label;

  const state = document.createElement('span');
  state.className = 'pay-channel-state';

  const valueBox = document.createElement('span');
  valueBox.className = 'pay-channel-value';

  // 密钥两键 = **多行材料**（PEM 的 BEGIN/END 各占一行）⇒ 必须 textarea：单行 <input> 在粘贴时
  // 会被浏览器按 HTML 值净化算法**吃掉换行**，头尾与正文粘成一行 ⇒ 服务端 PEM 解析必失败
  // （2026-10-07 沙箱联调现场缺陷：控制台复制的裸 base64 与"加头尾"两种粘法都因此过不去）。
  // 其余四键保持单行。私钥的点状遮蔽改由 CSS `-webkit-text-security: disc` 承担（见 style.css）。
  const isKeyMaterial = item.key === 'pay.channel.privateKey' || item.key === 'pay.channel.publicKey';
  const input = document.createElement(isKeyMaterial ? 'textarea' : 'input');
  input.className = 'pay-channel-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (isKeyMaterial) {
    input.rows = 4;
    input.classList.add('pay-channel-key-input');
  }

  if (item.secret) {
    state.textContent = item.configured ? `已配置 ✓ · 指纹 ${item.fingerprint}` : '未配置';
    input.placeholder = '粘贴应用私钥 PEM 全文，或 base64 单行';
  } else {
    state.textContent = item.configured ? '已配置' : '未配置';
    input.placeholder = item.key === 'pay.channel.publicKey'
      ? '粘贴支付宝公钥（控制台直接复制即可）或 PEM 全文'
      : '输入新值';
    const code = document.createElement('code');
    code.textContent = item.configured ? String(item.value ?? '') : '—';
    valueBox.append(code);
  }
  row.append(label, state, valueBox, input);

  if (canWrite) {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn mini pay-channel-save-' + slot;
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true; // 在途禁用（双击保护）；成败路径都会重拉渲染
      savePayChannelKey(item, input).finally(() => {
        if (saveBtn.isConnected) saveBtn.disabled = false;
      });
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn mini pay-channel-clear-' + slot;
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => {
      clearBtn.disabled = true;
      clearPayChannelKey(item).finally(() => {
        if (clearBtn.isConnected) clearBtn.disabled = false;
      });
    });
    row.append(saveBtn, clearBtn);
  }
  return row;
}

/**
 * 保存（掩码写）：`PUT /api/admin/pay-channel/:key {value}`（`:key` 照 R75 `encodeURIComponent`）。
 * 只按 HTTP status 分流（M1）：400 回显服务端 message（不含输入值）· 401 回登录 ·
 * 503 缺主钥 · 成功 ⇒ 文案逐字（⚙️12）+ 重拉渲染（指纹 / 状态随之刷新，输入框随重建清空）。
 */
async function savePayChannelKey(item, input) {
  const { status, body } = await api(`/api/admin/pay-channel/${encodeURIComponent(item.key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value: input.value }),
  });
  if (status === 200) {
    showMsg('已保存；下一次渠道调用即生效', 'ok');
    await loadPayChannel();
    return;
  }
  if (status === 400) return showMsg(`未保存：${body?.message ?? ''}`, 'err');
  if (status === 503) return showMsg('渠道密钥存储未启用（缺主钥）', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`保存失败（HTTP ${status}）`, 'err');
}

/**
 * 清空（`DELETE`；先 `confirm` —— 幂等，后端行不存在也 200）。
 * 成功 ⇒ 文案逐字（⚙️12）+ 重拉渲染；分支口径同保存。
 */
async function clearPayChannelKey(item) {
  if (!confirm(`确定清空「${item.label}」？清空后未配置时回默认 / 不可用语义。`)) return;
  const { status, body } = await api(`/api/admin/pay-channel/${encodeURIComponent(item.key)}`, {
    method: 'DELETE',
  });
  if (status === 200) {
    showMsg('已清空（未配置时回默认/不可用语义）', 'ok');
    await loadPayChannel();
    return;
  }
  if (status === 400) return showMsg(`未清空：${body?.message ?? ''}`, 'err');
  if (status === 503) return showMsg('渠道密钥存储未启用（缺主钥）', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`清空失败（HTTP ${status}）`, 'err');
}

/** 登出/退出时清支付渠道视图的数据面与控件（六行与私钥输入框都不跨会话残留）。 */
function resetPayChannel() {
  payChannelState.rows = [];
  payChannelState.loaded = false;
  payChannelState.loading = false;
  $('pay-channel-rows').textContent = '';
}

// ─── 通知通道视图（通知通道管理化片 T9；规格 §2.8）─────────────────────

/** 槽名 = 键的末段（照 pay 先例；九枚 = host,port,user,pass,to,feishuUrl,wecomUrl,dingtalkUrl,dingtalkSecret）。 */
function notifyChannelSlot(key) {
  return String(key).split('.').pop();
}

/** 组归属（§2.8 两组）：`notify.webhook.` 前缀 ⇒ IM 组（4 键）；其余 ⇒ 邮件组（smtp 4 + email.to = 5 键）。 */
function isImChannelKey(key) {
  return String(key).startsWith('notify.webhook.');
}

/**
 * 首次激活懒加载（照既有 switchView 机制）：`GET /api/admin/notify-channel` ⇒ 渲染两组九行。
 * 只按 HTTP status 分流（M1；绝不读 body.code）：401 ⇒ 回登录 · 503 ⇒ 显示服务端 message
 * （微审 v1.5：服务端区分「缺主钥」与「密文解密失败」两种 503 文案；无 message 时回落 §2.9 字面）。
 * 九行由响应驱动（顺序即响应序 = ⚙️1；不硬编码键表 —— §2.8）。
 */
async function loadNotifyChannel() {
  if (notifyChannelState.loading) return;
  notifyChannelState.loading = true;
  const { status, body } = await api('/api/admin/notify-channel');
  notifyChannelState.loading = false;
  if (handleAuth(status)) return;
  if (status === 503) return showMsg(body?.message ?? '通知通道密钥存储未启用（缺主钥）', 'err');
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status !== 200 || !Array.isArray(body?.data?.keys)) {
    return showMsg(`加载通知通道配置失败（HTTP ${status}）`, 'err');
  }
  notifyChannelState.rows = body.data.keys;
  notifyChannelState.loaded = true;
  renderNotifyChannel();
}

/**
 * 渲染两组（组归属按 `notify.webhook.` 前缀；组内顺序即响应序）+ 组尾完整性提示（§2.8 逐字，
 * 客户端算）。写控件（保存 / 清空）仅 super_admin 渲染 —— 门面；后端 policy 才是真门。
 * 提示口径：邮件组 = 五键全齐；钉钉组 = URL/加签密钥两键成对（飞书 / 企微单键即用，无成对约束）。
 */
function renderNotifyChannel() {
  const canWrite = roleOf() === 'super_admin';
  const emailBox = $('notify-channel-email-rows');
  const imBox = $('notify-channel-im-rows');
  emailBox.textContent = '';
  imBox.textContent = '';
  let emailTotal = 0;
  let emailDone = 0;
  let dingtalkDone = 0;
  for (const item of notifyChannelState.rows) {
    const im = isImChannelKey(item.key);
    (im ? imBox : emailBox).append(buildNotifyChannelRow(item, canWrite));
    if (!im) {
      emailTotal += 1;
      if (item.configured) emailDone += 1;
      continue;
    }
    if (
      (item.key === 'notify.webhook.dingtalkUrl' || item.key === 'notify.webhook.dingtalkSecret') &&
      item.configured
    ) {
      dingtalkDone += 1;
    }
  }
  // 组尾完整性提示（§2.8 冻结字面；微审 v1.7②：两组缺项数一律现算——钉钉双缺（全新安装）时不得再固定「缺 1 项」）。
  $('notify-channel-email-hint').textContent =
    emailDone === emailTotal ? '邮件通道：已就绪' : `邮件通道：未就绪（缺 ${emailTotal - emailDone} 项）`;
  $('notify-channel-im-hint').textContent =
    dingtalkDone === 2 ? '钉钉通道：已就绪' : `钉钉通道：未就绪（缺 ${2 - dingtalkDone} 项）`;
}

/**
 * 单行：label / 状态文本 / 值显示位 / 输入框 / 保存 / 清空（规格 §2.8 逐字）。
 *  - 非密键：值明文进 `<code>`；输入框**留空**（不预填值，防误覆盖）；
 *  - 密键：状态 = `已配置 ✓ · 指纹 <12hex>` 或 `未配置`（`value` 恒 null —— 只写不读）；
 *    URL 三键附 `hint`（`外部地址` 照显——hint 非 null 只可能是已配置的 URL 键）；
 *    `smtp.pass` 输入 `type=password` + `-webkit-text-security:disc`（照私钥先例）。
 *  - 稳定选择器（槽名 = 键末段）：`.notify-channel-row-{slot}` / `.notify-channel-save-{slot}` /
 *    `.notify-channel-clear-{slot}`。
 */
function buildNotifyChannelRow(item, canWrite) {
  const slot = notifyChannelSlot(item.key);
  const row = document.createElement('div');
  row.className = 'notify-channel-row notify-channel-row-' + slot;

  const label = document.createElement('span');
  label.className = 'notify-channel-label';
  label.textContent = item.label;

  const state = document.createElement('span');
  state.className = 'notify-channel-state';

  const valueBox = document.createElement('span');
  valueBox.className = 'notify-channel-value';

  const input = document.createElement('input');
  input.className = 'notify-channel-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '输入新值';

  if (item.secret) {
    state.textContent = item.configured ? `已配置 ✓ · 指纹 ${item.fingerprint}` : '未配置';
    if (item.key === 'notify.smtp.pass') {
      // §2.8：pass 输入 `type=password` + `-webkit-text-security:disc`（照私钥先例）。
      input.type = 'password';
      input.style.setProperty('-webkit-text-security', 'disc');
    }
    if (item.hint !== null && item.hint !== undefined) {
      const hint = document.createElement('code');
      hint.className = 'notify-channel-hint';
      hint.textContent = String(item.hint);
      valueBox.append(hint);
    }
  } else {
    state.textContent = item.configured ? '已配置' : '未配置';
    const code = document.createElement('code');
    code.textContent = item.configured ? String(item.value ?? '') : '—';
    valueBox.append(code);
  }
  row.append(label, state, valueBox, input);

  if (canWrite) {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn mini notify-channel-save-' + slot;
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true; // 在途禁用（双击保护）；成败路径都会重拉渲染
      saveNotifyChannelKey(item, input).finally(() => {
        if (saveBtn.isConnected) saveBtn.disabled = false;
      });
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn mini notify-channel-clear-' + slot;
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => {
      clearBtn.disabled = true;
      clearNotifyChannelKey(item).finally(() => {
        if (clearBtn.isConnected) clearBtn.disabled = false;
      });
    });
    row.append(saveBtn, clearBtn);
  }
  return row;
}

/**
 * 保存（掩码写）：`PUT /api/admin/notify-channel/:key {value}`（`:key` 照 R75 `encodeURIComponent`）。
 * 只按 HTTP status 分流（M1）：400 / 503 回显服务端 message（不含输入值；微审 v1.5：503 同 400 口径，
 * 无 message 时回落 §2.9 缺主钥字面）· 401 ⇒「请重新登录」· 成功 ⇒ 文案逐字 `已保存；30 秒内生效`（§2.8）
 * + 重拉渲染（指纹 / 状态随之刷新，输入框随重建清空）。
 */
async function saveNotifyChannelKey(item, input) {
  const { status, body } = await api(`/api/admin/notify-channel/${encodeURIComponent(item.key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value: input.value }),
  });
  if (status === 200) {
    showMsg('已保存；30 秒内生效', 'ok');
    await loadNotifyChannel();
    return;
  }
  if (status === 400) return showMsg(`未保存：${body?.message ?? ''}`, 'err');
  if (status === 503) return showMsg(`未保存：${body?.message ?? '通知通道密钥存储未启用（缺主钥）'}`, 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`保存失败（HTTP ${status}）`, 'err');
}

/**
 * 清空（`DELETE`；先 `confirm` —— 幂等，后端行不存在也 200）。
 * 成功 ⇒ 文案逐字 `已清空（未配置时该通道关闭）`（§2.8）+ 重拉渲染；分支口径同保存。
 */
async function clearNotifyChannelKey(item) {
  if (!confirm(`确定清空「${item.label}」？清空后未配置时该通道关闭。`)) return;
  const { status, body } = await api(`/api/admin/notify-channel/${encodeURIComponent(item.key)}`, {
    method: 'DELETE',
  });
  if (status === 200) {
    showMsg('已清空（未配置时该通道关闭）', 'ok');
    await loadNotifyChannel();
    return;
  }
  if (status === 400) return showMsg(`未清空：${body?.message ?? ''}`, 'err');
  if (status === 503) return showMsg(`未清空：${body?.message ?? '通知通道密钥存储未启用（缺主钥）'}`, 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`清空失败（HTTP ${status}）`, 'err');
}

/** 登出/退出时清通知通道视图的数据面与控件（两组九行与九个输入框都不跨会话残留）。 */
function resetNotifyChannel() {
  notifyChannelState.rows = [];
  notifyChannelState.loaded = false;
  notifyChannelState.loading = false;
  $('notify-channel-email-rows').textContent = '';
  $('notify-channel-im-rows').textContent = '';
  $('notify-channel-email-hint').textContent = '';
  $('notify-channel-im-hint').textContent = '';
}

// ─── 广告回调面板（广告片 T9；规格 §2.3；2026-10-21 并入「广告」配置页）──────────

/** 槽名 = 键的末段（照 pay/notify 先例；本空间恰 1 键 = callbackSecret）。 */
function adChannelSlot(key) {
  return String(key).split('.').pop();
}

/**
 * 进入「广告」配置域时懒加载（`syncAdSection` 触发）：`GET /api/admin/ad-channel` ⇒ 渲染单行。
 * `attempted` 防失败后同域重渲染重试风暴（显式再点叶会清零）。
 * 只按 HTTP status 分流（M1；绝不读 body.code）：401 ⇒ 回登录 · 503 ⇒ 显示服务端 message
 * （服务端区分「缺主钥」与「密文解密失败」两种 503 文案；无 message 时回落缺主钥字面）。
 * 单行由响应驱动（顺序即响应序 = `AD_CHANNEL_KEYS`；不硬编码键表 —— §2.3）。
 */
async function loadAdChannel() {
  if (adChannelState.loading) return;
  adChannelState.loading = true;
  adChannelState.attempted = true;
  const { status, body } = await api('/api/admin/ad-channel');
  adChannelState.loading = false;
  if (handleAuth(status)) return;
  if (status === 503) return showMsg(body?.message ?? '广告回调密钥存储未启用（缺主钥）', 'err');
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status !== 200 || !Array.isArray(body?.data?.keys)) {
    return showMsg(`加载广告回调配置失败（HTTP ${status}）`, 'err');
  }
  adChannelState.rows = body.data.keys;
  adChannelState.loaded = true;
  renderAdChannel();
}

/** 渲染单行（顺序即响应序）。写控件（保存 / 清空）仅 super_admin 渲染 —— 门面；后端 policy（P-a1/P-a2）才是真门。 */
function renderAdChannel() {
  const box = $('ad-channel-rows');
  box.textContent = '';
  const canWrite = roleOf() === 'super_admin';
  for (const item of adChannelState.rows) {
    box.append(buildAdChannelRow(item, canWrite));
  }
}

/**
 * 单行：label / 状态文本 / 值显示位 / 输入框 / 保存 / 清空（规格 §2.3 逐字）。
 *  - 本空间全密键（`AD_CHANNEL_SECRET_KEYS` = 全键）：状态 = `已配置 ✓ · 指纹 <12hex>` 或
 *    `未配置`（`value` 恒 null —— 只写不读）；输入框**留空**（不预填值，防误覆盖）+ 遮蔽
 *    （`type=password` + 行内 `-webkit-text-security:disc`，与 style.css 的 .ad-channel-* 规则双保险 ——
 *    照 `smtp.pass` 先例）；
 *  - 非密键分支照先例保留（本空间当前不可达——防御面）。
 *  - 稳定选择器（槽名 = 键末段）：`.ad-channel-row-{slot}` / `.ad-channel-save-{slot}` /
 *    `.ad-channel-clear-{slot}`。
 */
function buildAdChannelRow(item, canWrite) {
  const slot = adChannelSlot(item.key);
  const row = document.createElement('div');
  row.className = 'ad-channel-row ad-channel-row-' + slot;

  const label = document.createElement('span');
  label.className = 'ad-channel-label';
  label.textContent = item.label;

  const state = document.createElement('span');
  state.className = 'ad-channel-state';

  const valueBox = document.createElement('span');
  valueBox.className = 'ad-channel-value';

  const input = document.createElement('input');
  input.className = 'ad-channel-input';
  input.autocomplete = 'off';
  input.spellcheck = false;

  if (item.secret) {
    state.textContent = item.configured ? `已配置 ✓ · 指纹 ${item.fingerprint}` : '未配置';
    // §2.3：回调密钥 = 验签信任锚 ⇒ 输入遮蔽（照 smtp.pass/私钥先例）。
    input.type = 'password';
    input.style.setProperty('-webkit-text-security', 'disc');
    input.placeholder = '粘贴回调密钥';
  } else {
    state.textContent = item.configured ? '已配置' : '未配置';
    input.placeholder = '输入新值';
    const code = document.createElement('code');
    code.textContent = item.configured ? String(item.value ?? '') : '—';
    valueBox.append(code);
  }
  row.append(label, state, valueBox, input);

  if (canWrite) {
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn mini ad-channel-save-' + slot;
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () => {
      saveBtn.disabled = true; // 在途禁用（双击保护）；成败路径都会重拉渲染
      saveAdChannelKey(item, input).finally(() => {
        if (saveBtn.isConnected) saveBtn.disabled = false;
      });
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn mini ad-channel-clear-' + slot;
    clearBtn.textContent = '清空';
    clearBtn.addEventListener('click', () => {
      clearBtn.disabled = true;
      clearAdChannelKey(item).finally(() => {
        if (clearBtn.isConnected) clearBtn.disabled = false;
      });
    });
    row.append(saveBtn, clearBtn);
  }
  return row;
}

/**
 * 保存（掩码写）：`PUT /api/admin/ad-channel/:key {value}`（`:key` 照 R75 `encodeURIComponent`）。
 * 只按 HTTP status 分流（M1）：400 回显服务端 message（不含输入值）· 401 ⇒「请重新登录」·
 * 503 缺主钥 · 成功 ⇒ `已保存；下一次回调即生效`（消费侧现拉 —— 下一次回调即取新值）+ 重拉渲染
 * （指纹 / 状态随之刷新，输入框随重建清空）。
 */
async function saveAdChannelKey(item, input) {
  const { status, body } = await api(`/api/admin/ad-channel/${encodeURIComponent(item.key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value: input.value }),
  });
  if (status === 200) {
    showMsg('已保存；下一次回调即生效', 'ok');
    await loadAdChannel();
    return;
  }
  if (status === 400) return showMsg(`未保存：${body?.message ?? ''}`, 'err');
  if (status === 503) return showMsg(`未保存：${body?.message ?? '广告回调密钥存储未启用（缺主钥）'}`, 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`保存失败（HTTP ${status}）`, 'err');
}

/**
 * 清空（`DELETE`；先 `confirm` —— 幂等，后端行不存在也 200）。
 * 成功 ⇒ `已清空（未配置时回调验签不可用）` + 重拉渲染；分支口径同保存。
 */
async function clearAdChannelKey(item) {
  if (!confirm(`确定清空「${item.label}」？清空后未配置时回调验签不可用。`)) return;
  const { status, body } = await api(`/api/admin/ad-channel/${encodeURIComponent(item.key)}`, {
    method: 'DELETE',
  });
  if (status === 200) {
    showMsg('已清空（未配置时回调验签不可用）', 'ok');
    await loadAdChannel();
    return;
  }
  if (status === 400) return showMsg(`未清空：${body?.message ?? ''}`, 'err');
  if (status === 503) return showMsg(`未清空：${body?.message ?? '广告回调密钥存储未启用（缺主钥）'}`, 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`清空失败（HTTP ${status}）`, 'err');
}

/** 登出/退出时清广告回调面板的数据面与控件（单行与单个输入框都不跨会话残留）。 */
function resetAdChannel() {
  adChannelState.rows = [];
  adChannelState.loaded = false;
  adChannelState.loading = false;
  adChannelState.attempted = false;
  $('ad-channel-rows').textContent = '';
}

// ─── 风控视图（风控片 T9；规格 §2.10）───────────────────────────────────

/** 队列查询串（keyset：cursor/limit 由调用方决定是否带；`status` 过滤直读 riskState.filter）。 */
function riskQuery(filter, cursor, limit) {
  const p = new URLSearchParams();
  if (filter.status) p.set('status', filter.status);
  if (cursor !== null && cursor !== undefined) p.set('cursor', String(cursor));
  if (limit !== null && limit !== undefined) p.set('limit', String(limit));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** 队列列表：reset ⇒ 清空重拉第一页（连带收掉行内详情）；否则按 nextCursor 追加（keyset）。 */
async function loadRiskQueue(reset) {
  if (riskState.loading) return;
  riskState.loading = true;
  const cursor = reset ? null : riskState.nextCursor;
  const { status, body } = await api(
    `/api/admin/risk/reviews${riskQuery(riskState.filter, cursor, PAGE_LIMIT)}`,
  );
  riskState.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.items)) {
    return showMsg(`加载审核队列失败（HTTP ${status}）`, 'err');
  }
  if (reset) {
    riskState.rows = [];
    $('rk-body').textContent = '';
  }
  for (const row of body.data.items) {
    riskState.rows.push(row);
    $('rk-body').append(buildRiskRow(row));
  }
  riskState.nextCursor = body.data.nextCursor ?? null;
  riskState.loaded = true;
  $('rk-more-btn').hidden = riskState.nextCursor === null;
  $('rk-empty').textContent = riskState.rows.length === 0 ? '（无条目）' : '';
}

/** 队列行（9 列；末列「详情 / 处置」展开行内面板 —— 规格 §2.10 行内「详情/动作」的合并形态）。 */
function buildRiskRow(row) {
  const tr = document.createElement('tr');
  tr.append(
    textCell(row.id),
    textCell(row.userId),
    textCell(row.score, { num: true }),
    textCell(row.status),
    textCell(jsonText(row.reasons)),
    timeCell(row.createdAt),
    timeCell(row.updatedAt),
    textCell(row.handledBy),
  );
  const ops = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn mini';
  btn.textContent = '详情 / 处置';
  btn.addEventListener('click', () => toggleRiskDetail(tr, row));
  ops.append(btn);
  tr.append(ops);
  return tr;
}

/** 行内详情展开/收起：展开 = 拉 `GET /api/admin/risk/users/:userId`（详情聚合 + 动作条）。 */
async function toggleRiskDetail(tr, row) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) {
    next.remove();
    return;
  }
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 9;
  td.textContent = '详情加载中…';
  detail.append(td);
  tr.after(detail);
  const { status, body } = await api(`/api/admin/risk/users/${encodeURIComponent(row.userId)}`);
  if (handleAuth(status)) return;
  if (status === 404) {
    td.textContent = '用户不存在';
    return;
  }
  if (status === 0) {
    td.textContent = '无法连接服务端';
    return;
  }
  if (status !== 200 || !body?.data) {
    td.textContent = `加载详情失败（HTTP ${status}）`;
    return;
  }
  renderRiskDetail(td, row, body.data);
}

/** 详情面 + 动作条（一切数据 textContent；设备原文含关联账号、谓词拒绝计数、条目历史）。
 *  终审 F2：`bannedFlagPresent`（封禁旗在场性）驱动 unban 的孤儿态解锁，并在头部**极简标注**。 */
function renderRiskDetail(td, row, d) {
  td.textContent = '';
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent =
    `账号状态：${d.accountStatus} · 限流旗：${d.limitSource ?? '无'} · 用户：${d.userId}` +
    (d.bannedFlagPresent === true ? ' · 封禁旗：在' : '');
  td.append(info);

  const stats = document.createElement('p');
  stats.className = 'hint';
  const winRate = typeof d.stats?.winRate === 'number' ? d.stats.winRate.toFixed(3) : '—';
  stats.textContent =
    `总战绩：${d.stats?.games ?? 0} 局 / ${d.stats?.wins ?? 0} 胜 · 胜率 ${winRate} · ` +
    `窗口内设备 ${d.stats?.deviceCount ?? 0}`;
  td.append(stats);

  // 分玩法战绩（2026-10-25）：顶层是两玩法合计；旧 user-service 无 byGame 时按 0/— 渲染。
  const byGame = document.createElement('p');
  byGame.className = 'hint';
  const ddzGames = d.stats?.byGame?.doudizhu?.games ?? 0;
  const ddzWins = d.stats?.byGame?.doudizhu?.wins ?? 0;
  const ddzRate =
    typeof d.stats?.byGame?.doudizhu?.winRate === 'number' && ddzGames > 0
      ? d.stats.byGame.doudizhu.winRate.toFixed(3)
      : '—';
  const pdkGames = d.stats?.byGame?.paodekuai?.games ?? 0;
  const pdkWins = d.stats?.byGame?.paodekuai?.wins ?? 0;
  const pdkRate =
    typeof d.stats?.byGame?.paodekuai?.winRate === 'number' && pdkGames > 0
      ? d.stats.byGame.paodekuai.winRate.toFixed(3)
      : '—';
  byGame.textContent =
    `分玩法：斗地主 ${ddzGames} 局 / ${ddzWins} 胜 · 胜率 ${ddzRate}；` +
    `跑得快 ${pdkGames} 局 / ${pdkWins} 胜 · 胜率 ${pdkRate}`;
  td.append(byGame);

  const hits = document.createElement('p');
  hits.className = 'hint';
  hits.textContent = `谓词拒绝计数（累计）：同 IP ${d.hits?.sameIp ?? 0} · 同设备 ${d.hits?.sameDevice ?? 0}`;
  td.append(hits);

  // 设备绑定片：绑定卡片在设备原文**上方**（1:1 绑定是安全闸，1:N 原文是风控线索，勿混）。
  td.append(buildRiskBindingCard(td, row, d.binding));

  const devices = Array.isArray(d.devices) ? d.devices : [];
  const devTitle = document.createElement('p');
  devTitle.className = 'hint risk-sub';
  devTitle.textContent = `设备原文（${devices.length} 台；关联账号 = 同设备上的其他账号）`;
  td.append(devTitle);
  td.append(buildRiskDevicesTable(devices));

  const entries = Array.isArray(d.entries) ? d.entries : [];
  const entryTitle = document.createElement('p');
  entryTitle.className = 'hint risk-sub';
  entryTitle.textContent = `条目历史（最近 ${entries.length} 条）`;
  td.append(entryTitle);
  td.append(buildRiskEntriesTable(entries));

  td.append(buildRiskActionBar(row, d));
}

/**
 * 设备绑定卡片（设备绑定片）：展示 1:1 绑定（`binding = {deviceId, boundAt}` 或 null）。
 * 与下方 1:N「设备原文」子表是两个概念 —— 绑定是登录/握手安全闸，原文是风控线索。
 * 解绑 = `DELETE /api/admin/risk/users/:userId/device-binding`（网关 P-r5：仅超管/运营可写），
 * 先 confirm 二次确认，成功后就地重拉详情（服务端态为准；解绑写 risk_actions 审计）。
 */
function buildRiskBindingCard(td, row, binding) {
  const box = document.createElement('div');
  box.className = 'risk-binding-card';
  const title = document.createElement('p');
  title.className = 'hint risk-sub';
  title.textContent = '账号设备绑定（同一账号仅可在绑定的一台设备上使用；换设备 11005 拒绝）';
  box.append(title);

  const valid = binding !== null && typeof binding === 'object' && typeof binding.deviceId === 'string';
  if (!valid) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '未绑定 —— 设备绑定开关开启后，该账号首次登录将静默绑定当前设备。';
    box.append(empty);
    return box;
  }

  const line = document.createElement('p');
  line.className = 'hint';
  line.textContent = `已绑定设备：${binding.deviceId} · 绑定时间（北京）：${fmtTime(binding.boundAt)}`;
  box.append(line);

  const bar = document.createElement('div');
  bar.className = 'risk-action-bar';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn mini';
  btn.textContent = '解绑设备';
  btn.addEventListener('click', () => {
    btn.disabled = true; // 在途禁用（双击保护；成功路径整面板重绘，按钮随之脱离文档）
    unbindRiskDevice(td, row, binding).finally(() => {
      if (btn.isConnected) btn.disabled = false;
    });
  });
  bar.append(btn);
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '解绑后该账号在新设备首次登录将静默重新绑定；本操作写风控审计。';
  bar.append(hint);
  box.append(bar);
  return box;
}

/**
 * 解绑设备（二次确认 → DELETE）。只按 HTTP status 分流（M1 —— 绝不读 body.code；
 * 404 = 无绑定行/用户不存在，服务端 message 回显）；成功后**就地**重拉详情，
 * 不动队列（解绑不改变队列条目态）。
 */
async function unbindRiskDevice(td, row, binding) {
  if (
    !confirm(
      `确定解绑该账号的设备绑定？\n账号：${row.userId}\n已绑定设备：${binding.deviceId}\n` +
        '解绑后该账号可在任意设备登录，首次登录将静默绑定新设备。',
    )
  ) {
    return;
  }
  const { status, body } = await api(
    `/api/admin/risk/users/${encodeURIComponent(row.userId)}/device-binding`,
    { method: 'DELETE' },
  );
  if (status === 200) {
    showMsg(`已解绑设备（用户 ${row.userId}）`, 'ok');
    await refreshRiskDetailPanel(td, row);
    return;
  }
  if (status === 400) return showMsg(`操作未执行：${body?.message ?? ''}`, 'err');
  if (status === 404) return showMsg(body?.message ?? '该用户未绑定设备（可能已被其他管理员解绑）', 'err');
  if (status === 403) return showMsg('当前角色不允许该操作', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`操作结果未知（HTTP ${status}）；请重新展开详情核实`, 'err');
}

/** 就地重拉用户详情并重绘当前面板（解绑成功后调用；失败时保持旧态，不弹错打扰）。 */
async function refreshRiskDetailPanel(td, row) {
  const { status, body } = await api(`/api/admin/risk/users/${encodeURIComponent(row.userId)}`);
  if (handleAuth(status)) return;
  if (status !== 200 || !body?.data) return;
  renderRiskDetail(td, row, body.data);
}

/** 设备子表：设备ID / 首次出现 / 最近出现 / 关联账号（同设备其他账号 ≤20，`userId（状态）`）。 */
function buildRiskDevicesTable(devices) {
  const table = document.createElement('table');
  table.className = 'data-table nested';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['设备ID', '首次出现（北京）', '最近出现（北京）', '关联账号（同设备其他账号）']) {
    const th = document.createElement('th');
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  if (devices.length === 0) {
    const tr = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = '（无设备记录）';
    tr.append(cell);
    tbody.append(tr);
  }
  for (const dev of devices) {
    const others = Array.isArray(dev.others) ? dev.others : [];
    const othersText =
      others.length === 0 ? '—' : others.map((o) => `${o.userId}（${o.accountStatus}）`).join('、');
    const tr = document.createElement('tr');
    tr.append(
      textCell(dev.deviceId),
      timeCell(dev.firstSeenAt),
      timeCell(dev.lastSeenAt),
      textCell(othersText),
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

/** 条目历史子表：条目ID / 分数 / 状态 / 处置者 / 处置时间 / 创建时间。 */
function buildRiskEntriesTable(entries) {
  const table = document.createElement('table');
  table.className = 'data-table nested';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['条目ID', '分数', '状态', '处置者', '处置时间（北京）', '创建时间（北京）']) {
    const th = document.createElement('th');
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  if (entries.length === 0) {
    const tr = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = '（无条目）';
    tr.append(cell);
    tbody.append(tr);
  }
  for (const e of entries) {
    const tr = document.createElement('tr');
    tr.append(
      textCell(e.id),
      textCell(e.score, { num: true }),
      textCell(e.status),
      textCell(e.handledBy),
      timeCell(e.handledAt),
      timeCell(e.createdAt),
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

/**
 * 动作条：reason 输入 + 五按钮（dismiss/throttle/unthrottle/ban/unban）。
 * 可用性 = UI 门面（条目 status / accountStatus / limitSource / `bannedFlagPresent`）；
 * 服务端 409 才是权威：
 *  - dismiss/throttle 需条目 open；unthrottle 需限流旗在；ban 需未封禁；
 *    unban 需已封禁**或孤儿封禁旗在**（终审 F2：`bannedFlagPresent === true` —— 服务端
 *    孤儿分支本就 200 可清，此前仅按 accountStatus 解锁 ⇒ 该路径不可达）。
 */
function buildRiskActionBar(row, d) {
  const bar = document.createElement('div');
  bar.className = 'risk-action-bar';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'risk-reason';
  input.maxLength = 200;
  input.placeholder = '处置原因（必填，1–200 字）';
  input.setAttribute('aria-label', '处置原因');
  bar.append(input);

  const availability = {
    dismiss: row.status === 'open',
    throttle: row.status === 'open',
    unthrottle: d.limitSource === 'auto' || d.limitSource === 'manual',
    ban: d.accountStatus !== 'banned',
    unban: d.accountStatus === 'banned' || d.bannedFlagPresent === true, // 终审 F2：孤儿旗态解锁
  };
  const disabledTitle = {
    dismiss: '仅 open 条目可驳回',
    throttle: '仅 open 条目可限流',
    unthrottle: '该用户当前无限流旗',
    ban: '该用户已在封禁状态',
    unban: '该用户不在封禁状态',
  };
  for (const action of ['dismiss', 'throttle', 'unthrottle', 'ban', 'unban']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn mini';
    btn.textContent = RISK_ACTION_LABELS[action];
    btn.disabled = !availability[action];
    if (btn.disabled) btn.title = disabledTitle[action];
    btn.addEventListener('click', () => {
      btn.disabled = true; // 在途禁用（双击保护；成功路径会整表重拉，部件随之脱离文档）
      applyRiskAction(row, action, input).finally(() => {
        if (btn.isConnected) btn.disabled = !availability[action];
      });
    });
    bar.append(btn);
  }
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '提交结果以服务端裁决为准；成功 / 冲突后队列自动刷新。';
  bar.append(hint);
  return bar;
}

/**
 * 五动作提交（规格 §2.8/§2.10）：reason 必填（1..200）前端第一道 ⇒ `POST /api/admin/risk/actions`。
 * 只按 HTTP status 分流（M1 —— 绝不读 body.code；409 回显服务端 message）；
 * 条目态动作随行 `reviewId` = 提交者看到的条目（服务端陈旧断言；ban/unban 不消费）；
 * 成功 / 409 冲突 ⇒ 重拉队列（服务端态为准 —— 骨架的「动作后刷行」）。
 */
async function applyRiskAction(row, action, reasonInput) {
  const reason = reasonInput.value.trim();
  if (reason === '' || reason.length > 200) {
    return showMsg('请填写处置原因（1–200 字）', 'err');
  }
  const payload = { userId: row.userId, action, reason };
  if (RISK_ENTRY_ACTIONS.includes(action)) payload.reviewId = row.id;
  const { status, body } = await api('/api/admin/risk/actions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (status === 200) {
    showMsg(`已执行「${RISK_ACTION_LABELS[action]}」（用户 ${row.userId}）`, 'ok');
    await loadRiskQueue(true);
    return;
  }
  if (status === 400) return showMsg(`操作未执行：${body?.message ?? ''}`, 'err');
  if (status === 404) return showMsg('用户不存在', 'err');
  if (status === 409) {
    showMsg(`操作未执行：${body?.message ?? '状态冲突'}`, 'err');
    await loadRiskQueue(true); // 陈旧提交 / 状态已变 ⇒ 以服务端态刷新（提示语要求刷新后重试）
    return;
  }
  if (status === 403) return showMsg('当前角色不允许该操作', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`操作结果未知（HTTP ${status}）；请刷新队列核实`, 'err');
}

/** 登出/退出时清风控视图的数据面与控件（DOM 不残留）。 */
function resetRisk() {
  riskState.rows = [];
  riskState.nextCursor = null;
  riskState.loading = false;
  riskState.loaded = false;
  riskState.filter = { status: '' };
  $('rk-status').value = '';
  $('rk-body').textContent = '';
  $('rk-empty').textContent = '';
  $('rk-more-btn').hidden = true;
}

// ─── 审计视图（③ T10；风控片 T9 加第五页签「风控处置」；支付片 T12 加第六页签「支付处置」）──

const AUDIT_TABS = {
  config: { btn: 'audit-tab-config', panel: 'audit-panel-config' },
  wallet: { btn: 'audit-tab-wallet', panel: 'audit-panel-wallet' },
  login: { btn: 'audit-tab-login', panel: 'audit-panel-login' },
  account: { btn: 'audit-tab-account', panel: 'audit-panel-account' },
  /** 风控片 T9 第五页签（读 /api/admin/risk/actions + CSV）。 */
  risk: { btn: 'audit-tab-risk', panel: 'audit-panel-risk' },
  /** 支付片 T12 第六页签（读 /api/admin/pay/actions + CSV；审计第六源「支付处置」）。 */
  pay: { btn: 'audit-tab-pay', panel: 'audit-panel-pay' },
};

/** 页签可见性（不含加载——reset 路径只切可见性，避免登出时发请求）。 */
function auditTabVisibility(tab) {
  audit.tab = tab;
  for (const [name, t] of Object.entries(AUDIT_TABS)) {
    $(t.panel).hidden = name !== tab;
    $(t.btn).classList.toggle('active', name === tab);
  }
}

function switchAuditTab(tab) {
  auditTabVisibility(tab);
  loadAuditTab(tab);
}

/** 激活某页签即重拉（审计面 = 只增日志：每次进入都取最新；各页签 own 的 loading 旗防并发）。 */
function loadAuditTab(tab) {
  if (tab === 'config') auditLoadConfig(true);
  if (tab === 'wallet') auditSearchWallet();
  if (tab === 'login') auditLoadLogin(true);
  if (tab === 'account') auditLoadAccount(true);
  if (tab === 'risk') auditLoadRisk(true);
  if (tab === 'pay') auditLoadPay();
}

/** 配置变更过滤（查询与导出共用；导出不带 cursor/limit）。 */
function auditConfigParams() {
  const p = new URLSearchParams();
  const key = $('ac-key').value.trim();
  const actor = $('ac-actor').value.trim();
  if (key) p.set('key', key);
  if (actor) p.set('actor', actor);
  return p;
}

async function auditLoadConfig(reset) {
  const st = audit.config;
  if (st.loading) return;
  const p = auditConfigParams();
  p.set('limit', String(PAGE_LIMIT));
  if (!reset && st.nextCursor) p.set('cursor', String(st.nextCursor));
  st.loading = true;
  const { status, body } = await api(`/api/admin/config/changes?${p.toString()}`);
  st.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.rows)) {
    return showMsg(`加载配置变更失败（HTTP ${status}）`, 'err');
  }
  if (reset) {
    st.rows = [];
    $('ac-body').textContent = '';
  }
  for (const row of body.data.rows) {
    st.rows.push(row);
    const tr = document.createElement('tr');
    tr.append(
      textCell(row.id),
      timeCell(row.createdAt),
      textCell(row.key),
      textCell(jsonText(row.oldValue)),
      textCell(jsonText(row.newValue)),
      textCell(row.actor),
    );
    $('ac-body').append(tr);
  }
  st.nextCursor = body.data.nextCursor ?? null;
  st.loaded = true;
  $('ac-more-btn').hidden = st.nextCursor === null;
  $('ac-empty').textContent = st.rows.length === 0 ? '（无记录）' : '';
}

/** 资金操作页签：共享过滤（actor / 账户 / 时间）先解析，再并行拉两段（admin_adjust / admin_reverse）。 */
async function auditSearchWallet() {
  const owner = await resolveOwnerId($('aw-owner').value);
  if (owner === null) return;
  const bounds = rangeBounds($('aw-range').value, $('aw-from'), $('aw-to'));
  audit.walletFilter = {
    actor: $('aw-actor').value.trim(),
    ownerId: owner ?? '',
    from: bounds.from,
    to: bounds.to,
  };
  showOwnerIdentity(audit.walletFilter.ownerId, 'aw-owner-info');
  await Promise.all([auditLoadOps('adjust', true), auditLoadOps('reverse', true)]);
}

/** 资金操作两段（kind = 'adjust' | 'reverse'）共用的 ops 加载：固定 source + 共享过滤。 */
async function auditLoadOps(kind, reset) {
  const st = audit[kind];
  if (st.loading) return;
  const source = kind === 'adjust' ? 'admin_adjust' : 'admin_reverse';
  const filter = { source, ...audit.walletFilter };
  const cursor = reset ? null : st.nextCursor;
  st.loading = true;
  const { status, body } = await api(`/api/admin/wallet/ops${opsQuery(filter, cursor, PAGE_LIMIT)}`);
  st.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.rows)) {
    return showMsg(`加载资金流水失败（HTTP ${status}）`, 'err');
  }
  const bodyId = kind === 'adjust' ? 'aw-adjust-body' : 'aw-reverse-body';
  const moreId = kind === 'adjust' ? 'aw-adjust-more-btn' : 'aw-reverse-more-btn';
  const emptyId = kind === 'adjust' ? 'aw-adjust-empty' : 'aw-reverse-empty';
  if (reset) {
    st.rows = [];
    $(bodyId).textContent = '';
  }
  for (const row of body.data.rows) {
    st.rows.push(row);
    const tr = document.createElement('tr');
    tr.append(
      textCell(row.flowId),
      timeCell(row.createdAt),
      textCell(row.ownerId),
      textCell(row.nickname),
      textCell(row.phone),
      textCell(row.delta, { num: true }),
      textCell(row.balanceAfter, { num: true }),
      textCell(row.reason),
    );
    if (kind === 'adjust') {
      // 人工调整段：末列为「已冲正」状态标记（无行内动作——冲正在财务视图）。
      const tdc = document.createElement('td');
      if (row.reversed === true) {
        const tag = document.createElement('span');
        tag.className = 'tag-reversed';
        tag.textContent = '已冲正';
        tdc.append(tag);
      } else {
        tdc.textContent = '—';
      }
      tr.append(tdc);
    } else {
      // 冲正段：末列为「关联ID」（原操作 actionId）。
      tr.append(textCell(row.refId));
    }
    $(bodyId).append(tr);
  }
  st.nextCursor = body.data.nextCursor ?? null;
  st.loaded = true;
  $(moreId).hidden = st.nextCursor === null;
  $(emptyId).textContent = st.rows.length === 0 ? '（无记录）' : '';
}

/** 登录事件过滤（查询与导出共用）。 */
function auditLoginParams() {
  const p = new URLSearchParams();
  const username = $('al-username').value.trim();
  const success = $('al-success').value;
  if (username) p.set('username', username);
  if (success === '0' || success === '1') p.set('success', success);
  return p;
}

async function auditLoadLogin(reset) {
  const st = audit.login;
  if (st.loading) return;
  const p = auditLoginParams();
  p.set('limit', String(PAGE_LIMIT));
  if (!reset && st.nextCursor) p.set('cursor', String(st.nextCursor));
  st.loading = true;
  const { status, body } = await api(`/api/admin/login-events?${p.toString()}`);
  st.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.rows)) {
    return showMsg(`加载登录事件失败（HTTP ${status}）`, 'err');
  }
  if (reset) {
    st.rows = [];
    $('al-body').textContent = '';
  }
  for (const row of body.data.rows) {
    st.rows.push(row);
    const tr = document.createElement('tr');
    tr.append(
      textCell(row.id),
      timeCell(row.createdAt),
      textCell(row.username),
      textCell(row.accountId),
      textCell(row.ip),
      textCell(row.success ? '成功' : '失败'),
    );
    $('al-body').append(tr);
  }
  st.nextCursor = body.data.nextCursor ?? null;
  st.loaded = true;
  $('al-more-btn').hidden = st.nextCursor === null;
  $('al-empty').textContent = st.rows.length === 0 ? '（无记录）' : '';
}

/** 账号变更过滤（查询与导出共用）。 */
function auditAccountParams() {
  const p = new URLSearchParams();
  const target = $('aa-target').value.trim();
  const actor = $('aa-actor').value.trim();
  const action = $('aa-action').value;
  if (target) p.set('targetId', target);
  if (actor) p.set('actor', actor);
  if (action) p.set('action', action);
  return p;
}

async function auditLoadAccount(reset) {
  const st = audit.account;
  if (st.loading) return;
  const p = auditAccountParams();
  p.set('limit', String(PAGE_LIMIT));
  if (!reset && st.nextCursor) p.set('cursor', String(st.nextCursor));
  st.loading = true;
  const { status, body } = await api(`/api/admin/accounts/changes?${p.toString()}`);
  st.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.rows)) {
    return showMsg(`加载账号变更失败（HTTP ${status}）`, 'err');
  }
  if (reset) {
    st.rows = [];
    $('aa-body').textContent = '';
  }
  for (const row of body.data.rows) {
    st.rows.push(row);
    const tr = document.createElement('tr');
    tr.append(
      textCell(row.id),
      timeCell(row.createdAt),
      textCell(row.targetId),
      textCell(row.username),
      textCell(row.action),
      textCell(jsonText(row.detail)),
      textCell(row.actor),
    );
    $('aa-body').append(tr);
  }
  st.nextCursor = body.data.nextCursor ?? null;
  st.loaded = true;
  $('aa-more-btn').hidden = st.nextCursor === null;
  $('aa-empty').textContent = st.rows.length === 0 ? '（无记录）' : '';
}

/** 风控处置过滤（查询与导出共用；直读控件；导出不带 cursor/limit —— 带上即 400）。 */
function auditRiskParams() {
  const p = new URLSearchParams();
  const userId = $('ar-user').value.trim();
  const action = $('ar-action').value;
  const actor = $('ar-actor').value.trim();
  const bounds = rangeBounds($('ar-range').value, $('ar-from'), $('ar-to'));
  if (userId) p.set('userId', userId);
  if (action) p.set('action', action);
  if (actor) p.set('actor', actor);
  if (bounds.from !== undefined) p.set('from', String(bounds.from));
  if (bounds.to !== undefined) p.set('to', String(bounds.to));
  return p;
}

/** 审计第五页签「风控处置」：`GET /api/admin/risk/actions`（keyset；响应 `data.{items,nextCursor}`）。 */
async function auditLoadRisk(reset) {
  const st = audit.risk;
  if (st.loading) return;
  const p = auditRiskParams();
  p.set('limit', String(PAGE_LIMIT));
  if (!reset && st.nextCursor) p.set('cursor', String(st.nextCursor));
  st.loading = true;
  const { status, body } = await api(`/api/admin/risk/actions?${p.toString()}`);
  st.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.items)) {
    return showMsg(`加载风控处置失败（HTTP ${status}）`, 'err');
  }
  if (reset) {
    st.rows = [];
    $('ar-body').textContent = '';
  }
  for (const row of body.data.items) {
    st.rows.push(row);
    const tr = document.createElement('tr');
    tr.append(
      textCell(row.id),
      timeCell(row.createdAt),
      textCell(row.userId),
      textCell(row.action),
      textCell(row.actor),
      textCell(row.reviewId),
      textCell(row.reason),
      textCell(jsonText(row.detail)),
    );
    $('ar-body').append(tr);
  }
  st.nextCursor = body.data.nextCursor ?? null;
  st.loaded = true;
  $('ar-more-btn').hidden = st.nextCursor === null;
  $('ar-empty').textContent = st.rows.length === 0 ? '（无记录）' : '';
}

/** 支付处置过滤（查询与导出共用；直读控件；键集 = from/to/actor——无 cursor）。 */
function auditPayParams() {
  const p = new URLSearchParams();
  const actor = $('ap-actor').value.trim();
  const bounds = rangeBounds($('ap-range').value, $('ap-from'), $('ap-to'));
  if (actor) p.set('actor', actor);
  if (bounds.from !== undefined) p.set('from', String(bounds.from));
  if (bounds.to !== undefined) p.set('to', String(bounds.to));
  return p;
}

/**
 * 审计第六页签「支付处置」（支付片 T12）：`GET /api/admin/pay/actions` —— 三表处置事件流
 * （申请/审/驳回/确认/回滚；响应 `data.{items}`，**无分页**）。
 * `kind` 经 `PAY_ACTION_LABELS` 映射中文（未知值原样回显——不静默吞）。
 */
async function auditLoadPay() {
  const st = audit.pay;
  if (st.loading) return;
  st.loading = true;
  const { status, body } = await api(`/api/admin/pay/actions?${auditPayParams().toString()}`);
  st.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.items)) {
    return showMsg(`加载支付处置失败（HTTP ${status}）`, 'err');
  }
  st.rows = body.data.items;
  st.loaded = true;
  const tbody = $('ap-body');
  tbody.textContent = '';
  for (const row of st.rows) {
    const tr = document.createElement('tr');
    tr.append(
      timeCell(row.at),
      textCell(row.actor),
      textCell(PAY_ACTION_LABELS[row.kind] ?? row.kind),
      textCell(row.refNo),
      textCell(row.detail),
    );
    tbody.append(tr);
  }
  $('ap-empty').textContent = st.rows.length === 0 ? '（无记录）' : '';
}

/** 登出/退出时清审计视图的数据面与控件。 */
function resetAudit() {
  for (const key of ['config', 'adjust', 'reverse', 'login', 'account', 'risk', 'pay']) {
    const st = audit[key];
    st.rows = [];
    st.nextCursor = null;
    st.loading = false;
    st.loaded = false;
  }
  audit.walletFilter = { actor: '', ownerId: '', from: undefined, to: undefined };
  $('ac-key').value = '';
  $('ac-actor').value = '';
  $('ac-body').textContent = '';
  $('ac-empty').textContent = '';
  $('ac-more-btn').hidden = true;
  $('aw-actor').value = '';
  $('aw-owner').value = '';
  $('aw-owner-info').textContent = '';
  $('aw-range').value = '';
  $('aw-custom').hidden = true;
  $('aw-from').value = '';
  $('aw-to').value = '';
  $('aw-adjust-body').textContent = '';
  $('aw-adjust-empty').textContent = '';
  $('aw-adjust-more-btn').hidden = true;
  $('aw-reverse-body').textContent = '';
  $('aw-reverse-empty').textContent = '';
  $('aw-reverse-more-btn').hidden = true;
  $('al-username').value = '';
  $('al-success').value = '';
  $('al-body').textContent = '';
  $('al-empty').textContent = '';
  $('al-more-btn').hidden = true;
  $('aa-target').value = '';
  $('aa-actor').value = '';
  $('aa-action').value = '';
  $('aa-body').textContent = '';
  $('aa-empty').textContent = '';
  $('aa-more-btn').hidden = true;
  $('ar-user').value = '';
  $('ar-action').value = '';
  $('ar-actor').value = '';
  $('ar-range').value = '';
  $('ar-custom').hidden = true;
  $('ar-from').value = '';
  $('ar-to').value = '';
  $('ar-body').textContent = '';
  $('ar-empty').textContent = '';
  $('ar-more-btn').hidden = true;
  $('ap-actor').value = '';
  $('ap-range').value = '';
  $('ap-custom').hidden = true;
  $('ap-from').value = '';
  $('ap-to').value = '';
  $('ap-body').textContent = '';
  $('ap-empty').textContent = '';
  auditTabVisibility('config');
}

// ─── 账号视图（③ T10；规格 §2.12，仅 super_admin）────────────────────────

/** 角色展示名（下拉用；表格保持 wire 原值）。 */
const ROLE_LABELS = {
  super_admin: '超级管理员',
  finance: '财务',
  operator: '运维',
  viewer: '只读',
};

async function loadAccounts() {
  if (accState.loading) return;
  accState.loading = true;
  const { status, body } = await api('/api/admin/accounts');
  accState.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 403) return showMsg('当前角色不允许查看账号列表', 'err');
  if (status !== 200 || !Array.isArray(body?.data?.accounts)) {
    return showMsg(`加载账号失败（HTTP ${status}）`, 'err');
  }
  accState.rows = body.data.accounts;
  accState.loaded = true;
  renderAccounts();
}

function renderAccounts() {
  const body = $('acc-body');
  body.textContent = '';
  const self = usernameOf();
  for (const account of accState.rows) {
    const tr = document.createElement('tr');
    tr.append(textCell(account.username));

    // 角色（行内下拉；自己的行禁用 —— 服务端自锁闸 1 的 UI 门面）。
    const roleTd = document.createElement('td');
    const roleSel = document.createElement('select');
    for (const role of ['super_admin', 'finance', 'operator', 'viewer']) {
      const opt = document.createElement('option');
      opt.value = role;
      opt.textContent = `${role}（${ROLE_LABELS[role]}）`;
      if (role === account.role) opt.selected = true;
      roleSel.append(opt);
    }
    if (account.username === self) {
      roleSel.disabled = true;
      roleSel.title = '不能变更自己的角色（服务端自锁闸）';
    } else {
      roleSel.addEventListener('change', () =>
        patchAccount(account.id, { role: roleSel.value }, `已更新「${account.username}」的角色`),
      );
    }
    roleTd.append(roleSel);
    tr.append(roleTd);

    const statusText = account.status === 'active' ? '启用中' : '已停用';
    tr.append(textCell(statusText), timeCell(account.lastLoginAt), timeCell(account.createdAt));

    const ops = document.createElement('td');
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn mini';
    toggleBtn.textContent = account.status === 'active' ? '停用' : '启用';
    if (account.username === self) {
      toggleBtn.disabled = true;
      toggleBtn.title = '不能停用自己的账号（服务端自锁闸）';
    } else {
      toggleBtn.addEventListener('click', () =>
        patchAccount(
          account.id,
          { status: account.status === 'active' ? 'disabled' : 'active' },
          account.status === 'active' ? `已停用「${account.username}」` : `已启用「${account.username}」`,
        ),
      );
    }
    const pwBtn = document.createElement('button');
    pwBtn.type = 'button';
    pwBtn.className = 'btn mini';
    pwBtn.textContent = '重置口令';
    pwBtn.addEventListener('click', () => resetPassword(account));
    ops.append(toggleBtn, pwBtn);
    tr.append(ops);
    body.append(tr);
  }
  $('acc-empty').textContent = accState.rows.length === 0 ? '（无账号）' : '';
}

/** PATCH 单账号（role/status/password 子集）；成功与「明确失败」都重拉列表（展示态以服务端为准）。 */
async function patchAccount(id, patch, okText) {
  const { status, body } = await api(`/api/admin/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (status === 200) {
    showMsg(okText, 'ok');
    await loadAccounts();
    return;
  }
  if (status === 400 || status === 404 || status === 409) {
    showMsg(`操作未执行：${body?.message ?? ''}`, 'err');
    await loadAccounts(); // 回滚展示态（下拉可能已被用户改动）
    return;
  }
  if (status === 403) return showMsg('当前角色不允许该操作', 'err');
  if (!handleAuth(status)) {
    if (status === 0) showMsg('无法连接服务端', 'err');
    else showMsg(`操作结果未知（HTTP ${status}）`, 'err');
  }
}

/** 重置口令（弹窗输入；10–72 字第一道，服务端是唯一校验点）。 */
async function resetPassword(account) {
  const pw = await modalPrompt({
    title: `重置口令 · ${account.username}`,
    desc: '新口令 10–72 字符（服务端校验；改自己口令是被允许的）。',
    placeholder: '新口令',
    type: 'password',
    confirmLabel: '重置',
    maxlength: 72,
    minlength: 10,
  });
  if (pw === null) return;
  if (pw.length < 10 || pw.length > 72) return showMsg('口令长度须为 10–72 字符', 'err');
  await patchAccount(account.id, { password: pw }, `已重置「${account.username}」的口令`);
}

/** 建号（username/password/role；400/409 回显服务端原因）。 */
async function createAccount(ev) {
  ev.preventDefault();
  const username = $('acc-username').value.trim();
  const password = $('acc-password').value;
  const role = $('acc-role').value;
  if (!username || !password) return showMsg('请填写用户名与口令', 'err');
  const btn = $('acc-create-btn');
  btn.disabled = true;
  const { status, body } = await api('/api/admin/accounts', {
    method: 'POST',
    body: JSON.stringify({ username, password, role }),
  });
  btn.disabled = false;
  if (status === 200) {
    showMsg(`已创建账号「${body?.data?.username ?? username}」`, 'ok');
    $('acc-username').value = '';
    $('acc-password').value = '';
    await loadAccounts();
    return;
  }
  if (status === 400 || status === 409) return showMsg(`建号失败：${body?.message ?? ''}`, 'err');
  if (status === 403) return showMsg('当前角色不允许建号', 'err');
  if (!handleAuth(status)) {
    if (status === 0) showMsg('无法连接服务端', 'err');
    else showMsg(`建号失败（HTTP ${status}）`, 'err');
  }
}

/** 登出/退出时清账号视图的数据面与控件。 */
function resetAccounts() {
  accState.rows = [];
  accState.loaded = false;
  accState.loading = false;
  $('acc-body').textContent = '';
  $('acc-empty').textContent = '';
  $('acc-username').value = '';
  $('acc-password').value = '';
  $('acc-role').value = 'operator';
}

// ─── 事件接线与启动 ──────────────────────────────────────────────────────

function wire() {
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('login-username').value.trim();
    const pw = $('password').value;
    if (!username || !pw) return;
    $('login-btn').disabled = true;
    login(username, pw).finally(() => {
      $('login-btn').disabled = false;
    });
  });
  // v2.1 配置中心：跨域搜索（整页设置行重渲染，scrollTop/焦点在渲染器内保留）；Esc 清空回域视图。
  $('settings-search').addEventListener('input', (e) => {
    cfgUI.query = e.target.value;
    renderConfigRows({ preserve: true });
  });
  $('settings-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !cfgUI.query) return;
    e.target.value = '';
    cfgUI.query = '';
    renderConfigRows();
  });
  // 左树 5+1 配置域叶（10 个凭据/运营/审计叶在下方按既有 id 逐个绑定）。
  for (const m of CFG_NAV) {
    $(m.leaf).addEventListener('click', () => openCfgDomain(m.domain));
  }
  $('logout-btn').addEventListener('click', () => {
    backToLogin(); // 状态复位与主视图 DOM 清零都在里面（单一处置点）
    showMsg('已退出');
  });
  // 顶栏视图切换（十一视图；显隐 = 角色门面）。
  $('nav-config-btn').addEventListener('click', () => switchView('config'));
  $('nav-pay-channel-btn').addEventListener('click', () => switchView('payChannel'));
  $('nav-notify-channel-btn').addEventListener('click', () => switchView('notifyChannel'));
  $('nav-players-btn').addEventListener('click', () => switchView('players'));
  $('nav-wallet-btn').addEventListener('click', () => switchView('wallet'));
  $('nav-finance-btn').addEventListener('click', () => switchView('finance'));
  $('nav-pay-orders-btn').addEventListener('click', () => switchView('payOrders'));
  $('nav-pay-refunds-btn').addEventListener('click', () => switchView('payRefunds'));
  $('nav-pay-withdrawals-btn').addEventListener('click', () => switchView('payWithdrawals'));
  $('nav-risk-btn').addEventListener('click', () => switchView('risk'));
  $('nav-audit-btn').addEventListener('click', () => switchView('audit'));
  $('nav-accounts-btn').addEventListener('click', () => switchView('accounts'));

  // 钱包调整：查询（① + ②；空输入不发请求 —— 与登录表单的 `if (!pw) return` 同式）。
  $('wallet-lookup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const phone = $('wallet-phone').value.trim();
    if (!phone) return;
    const btn = $('wallet-lookup-btn');
    btn.disabled = true;
    walletLookup(phone).finally(() => {
      btn.disabled = false;
    });
  });
  // 钱包调整：提交（③–⑥；在途禁用 = 双击保护的第一道，第二道在服务端幂等）。
  // 页面不做金额/原因校验（服务端是唯一校验点）；只拦「空栏提交」这一种无谓往返。
  $('wallet-adjust-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const deltaRaw = $('wallet-delta').value.trim();
    const reason = $('wallet-reason').value.trim();
    if (deltaRaw === '' || reason === '') {
      return showMsg('请先填写金额与原因', 'err');
    }
    const btn = $('wallet-adjust-btn');
    btn.disabled = true;
    walletAdjust(Number(deltaRaw), reason).finally(() => {
      btn.disabled = !walletUserId;
    });
  });

  // ── 财务视图 ──
  $('fin-range').addEventListener('change', () => {
    $('fin-custom').hidden = $('fin-range').value !== 'custom';
  });
  $('fin-search-btn').addEventListener('click', () => financeSearch());
  $('fin-reset-btn').addEventListener('click', () => {
    resetFinControls();
    financeSearch();
  });
  $('fin-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/wallet/ops.csv${opsQuery(fin.filter, null, null)}`),
  );
  $('fin-more-btn').addEventListener('click', () => loadFinFlows(false));
  $('fin-summary-source-btn').addEventListener('click', () => {
    fin.summaryGroupBy = 'source';
    $('fin-summary-source-btn').classList.add('active');
    $('fin-summary-day-btn').classList.remove('active');
    loadFinSummary();
  });
  $('fin-summary-day-btn').addEventListener('click', () => {
    fin.summaryGroupBy = 'day';
    $('fin-summary-day-btn').classList.add('active');
    $('fin-summary-source-btn').classList.remove('active');
    loadFinSummary();
  });
  $('fin-summary-export-btn').addEventListener('click', () => {
    const p = new URLSearchParams();
    p.set('groupBy', fin.summaryGroupBy);
    if (fin.filter.from !== undefined) p.set('from', String(fin.filter.from));
    if (fin.filter.to !== undefined) p.set('to', String(fin.filter.to));
    downloadCsv(`/api/admin/wallet/summary.csv?${p.toString()}`);
  });
  $('fin-pool-flows-btn').addEventListener('click', () => {
    // 「查看池流水」= 跳转 source=robot_pool（规格 §2.12）。
    $('fin-source').value = 'robot_pool';
    financeSearch();
  });
  $('rec-run-btn').addEventListener('click', () => runReconcile());

  // ── 支付三视图（支付片 T12）──
  $('po-range').addEventListener('change', () => {
    $('po-custom').hidden = $('po-range').value !== 'custom';
  });
  $('po-search-btn').addEventListener('click', () => payOrdersSearch());
  $('po-reset-btn').addEventListener('click', () => {
    $('po-status').value = '';
    $('po-user').value = '';
    $('po-range').value = '';
    $('po-custom').hidden = true;
    $('po-from').value = '';
    $('po-to').value = '';
    payOrdersSearch();
  });
  $('po-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/pay/orders.csv${payOrdersQuery(payOrders.filter, null)}`),
  );
  $('po-more-btn').addEventListener('click', () => loadPayOrders(false));
  $('rf-search-btn').addEventListener('click', () => payRefundsSearch());
  $('rf-reset-btn').addEventListener('click', () => {
    $('rf-status').value = '';
    $('rf-user').value = '';
    payRefundsSearch();
  });
  $('rf-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/pay/refunds.csv${payListQuery(payRefunds.filter)}`),
  );
  $('ws-search-btn').addEventListener('click', () => payWithdrawalsSearch());
  $('ws-reset-btn').addEventListener('click', () => {
    $('ws-status').value = '';
    $('ws-user').value = '';
    payWithdrawalsSearch();
  });
  $('ws-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/pay/withdrawals.csv${payListQuery(payWithdrawals.filter)}`),
  );

  // ── 风控视图 ──
  $('rk-search-btn').addEventListener('click', () => {
    riskState.filter = { status: $('rk-status').value };
    loadRiskQueue(true);
  });
  $('rk-reset-btn').addEventListener('click', () => {
    $('rk-status').value = '';
    riskState.filter = { status: '' };
    loadRiskQueue(true);
  });
  $('rk-more-btn').addEventListener('click', () => loadRiskQueue(false));

  // ── 审计视图（六页签）──
  $('audit-tab-config').addEventListener('click', () => switchAuditTab('config'));
  $('audit-tab-wallet').addEventListener('click', () => switchAuditTab('wallet'));
  $('audit-tab-login').addEventListener('click', () => switchAuditTab('login'));
  $('audit-tab-account').addEventListener('click', () => switchAuditTab('account'));
  $('audit-tab-risk').addEventListener('click', () => switchAuditTab('risk'));
  $('audit-tab-pay').addEventListener('click', () => switchAuditTab('pay'));
  // 配置变更页签
  $('ac-search-btn').addEventListener('click', () => auditLoadConfig(true));
  $('ac-reset-btn').addEventListener('click', () => {
    $('ac-key').value = '';
    $('ac-actor').value = '';
    auditLoadConfig(true);
  });
  $('ac-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/config/changes.csv?${auditConfigParams().toString()}`),
  );
  $('ac-more-btn').addEventListener('click', () => auditLoadConfig(false));
  // 资金操作页签
  $('aw-range').addEventListener('change', () => {
    $('aw-custom').hidden = $('aw-range').value !== 'custom';
  });
  $('aw-search-btn').addEventListener('click', () => auditSearchWallet());
  $('aw-reset-btn').addEventListener('click', () => {
    $('aw-actor').value = '';
    $('aw-owner').value = '';
    $('aw-range').value = '';
    $('aw-custom').hidden = true;
    $('aw-from').value = '';
    $('aw-to').value = '';
    auditSearchWallet();
  });
  $('aw-adjust-export-btn').addEventListener('click', () =>
    downloadCsv(
      `/api/admin/wallet/ops.csv${opsQuery({ source: 'admin_adjust', ...audit.walletFilter }, null, null)}`,
    ),
  );
  $('aw-reverse-export-btn').addEventListener('click', () =>
    downloadCsv(
      `/api/admin/wallet/ops.csv${opsQuery({ source: 'admin_reverse', ...audit.walletFilter }, null, null)}`,
    ),
  );
  $('aw-adjust-more-btn').addEventListener('click', () => auditLoadOps('adjust', false));
  $('aw-reverse-more-btn').addEventListener('click', () => auditLoadOps('reverse', false));
  // 登录事件页签
  $('al-search-btn').addEventListener('click', () => auditLoadLogin(true));
  $('al-reset-btn').addEventListener('click', () => {
    $('al-username').value = '';
    $('al-success').value = '';
    auditLoadLogin(true);
  });
  $('al-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/login-events.csv?${auditLoginParams().toString()}`),
  );
  $('al-more-btn').addEventListener('click', () => auditLoadLogin(false));
  // 账号变更页签
  $('aa-search-btn').addEventListener('click', () => auditLoadAccount(true));
  $('aa-reset-btn').addEventListener('click', () => {
    $('aa-target').value = '';
    $('aa-actor').value = '';
    $('aa-action').value = '';
    auditLoadAccount(true);
  });
  $('aa-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/accounts/changes.csv?${auditAccountParams().toString()}`),
  );
  $('aa-more-btn').addEventListener('click', () => auditLoadAccount(false));
  // 风控处置页签（风控片 T9）
  $('ar-range').addEventListener('change', () => {
    $('ar-custom').hidden = $('ar-range').value !== 'custom';
  });
  $('ar-search-btn').addEventListener('click', () => auditLoadRisk(true));
  $('ar-reset-btn').addEventListener('click', () => {
    $('ar-user').value = '';
    $('ar-action').value = '';
    $('ar-actor').value = '';
    $('ar-range').value = '';
    $('ar-custom').hidden = true;
    $('ar-from').value = '';
    $('ar-to').value = '';
    auditLoadRisk(true);
  });
  $('ar-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/risk/actions.csv?${auditRiskParams().toString()}`),
  );
  $('ar-more-btn').addEventListener('click', () => auditLoadRisk(false));
  // 支付处置页签（支付片 T12）
  $('ap-range').addEventListener('change', () => {
    $('ap-custom').hidden = $('ap-range').value !== 'custom';
  });
  $('ap-search-btn').addEventListener('click', () => auditLoadPay());
  $('ap-reset-btn').addEventListener('click', () => {
    $('ap-actor').value = '';
    $('ap-range').value = '';
    $('ap-custom').hidden = true;
    $('ap-from').value = '';
    $('ap-to').value = '';
    auditLoadPay();
  });
  $('ap-export-btn').addEventListener('click', () =>
    downloadCsv(`/api/admin/pay/actions.csv?${auditPayParams().toString()}`),
  );

  // ── 账号视图 ──
  $('acc-create-form').addEventListener('submit', createAccount);
  $('acc-refresh-btn').addEventListener('click', () => loadAccounts());

  // 玩家管理页
  wirePlayers();

  // ── 通用弹窗 ──
  $('modal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    closeModal($('modal-input').value);
  });
  $('modal-cancel').addEventListener('click', () => closeModal(null));
}

// ─── 玩家管理页（2026-10-22）────────────────────────────────────────────────

function playersQuery() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(playersState.filter)) if (v) p.set(k, v);
  p.set('page', String(playersState.page));
  p.set('pageSize', String(playersState.pageSize));
  return `?${p.toString()}`;
}

/** 列表 + 当前页批量余额/充值；批量失败只降级列，不阻塞列表。 */
async function loadPlayers() {
  if (playersState.loading) return;
  playersState.loading = true;
  const { status, body } = await api(`/api/admin/players${playersQuery()}`);
  playersState.loading = false;
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  if (status === 400) return showMsg(`查询失败：${body?.message ?? ''}`, 'err');
  if (status !== 200 || !Array.isArray(body?.data?.items)) {
    return showMsg(`加载玩家失败（HTTP ${status}）`, 'err');
  }
  playersState.rows = body.data.items;
  playersState.total = Number(body.data.total ?? 0);
  playersState.summary = body.data.summary ?? null;
  playersState.loaded = true;
  if (body.data.onlineDegraded) showMsg('在线状态暂不可用：在线筛选已降级', 'warn');
  const pages = Math.max(1, Math.ceil(playersState.total / playersState.pageSize));
  if (playersState.page > pages) {
    playersState.page = pages;
    return loadPlayers();
  }
  await mergePlayerStats();
  renderPlayers();
}

async function mergePlayerStats() {
  playersState.balances = new Map();
  playersState.recharges = new Map();
  const ids = playersState.rows.map((r) => r.userId);
  if (ids.length === 0) return;
  const payload = JSON.stringify({ userIds: ids });
  const [bal, pay] = await Promise.all([
    api('/api/admin/wallet/accounts/batch', { method: 'POST', body: payload }),
    api('/api/admin/pay/players/summary', { method: 'POST', body: payload }),
  ]);
  if (bal.status === 200 && Array.isArray(bal.body?.data?.accounts)) {
    for (const a of bal.body.data.accounts) playersState.balances.set(a.userId, a);
  }
  if (pay.status === 200 && Array.isArray(pay.body?.data?.players)) {
    for (const p of pay.body.data.players) playersState.recharges.set(p.userId, p);
  }
}

function renderPlayers() {
  const sum = playersState.summary ?? {};
  const cards = [
    ['总玩家', sum.totalPlayers], ['当前在线', sum.onlineNow], ['今日新增', sum.newToday],
    ['7 日新增', sum.new7d], ['7 日活跃', sum.active7d], ['30 日活跃', sum.active30d],
    ['14 日流失', sum.inactive14d], ['30 日流失', sum.inactive30d],
  ];
  const box = $('pl-summary');
  box.textContent = '';
  for (const [label, value] of cards) {
    const card = el('div', 'players-card');
    card.append(
      el('div', 'players-card-value', value === undefined || value === null ? '—' : String(value)),
      el('div', 'players-card-label', label),
    );
    box.append(card);
  }
  const body = $('pl-body');
  body.textContent = '';
  for (const row of playersState.rows) body.append(buildPlayerRow(row));
  $('pl-empty').textContent = playersState.rows.length === 0 ? '（没有匹配的玩家）' : '';
  const pages = Math.max(1, Math.ceil(playersState.total / playersState.pageSize));
  $('pl-page-info').textContent = `第 ${playersState.page} / ${pages} 页 · 共 ${playersState.total} 人`;
  $('pl-prev-btn').disabled = playersState.page <= 1;
  $('pl-next-btn').disabled = playersState.page >= pages;
}

function buildPlayerRow(row) {
  const tr = document.createElement('tr');
  const bal = playersState.balances.get(row.userId);
  const pay = playersState.recharges.get(row.userId);
  const ops = document.createElement('td');
  const detail = btn('详情', 'btn mini');
  detail.addEventListener('click', () => showPlayerDetail(row));
  ops.append(detail);
  tr.append(
    textCell(row.phone),
    textCell(row.nickname),
    textCell(row.status),
    textCell(row.online ? '在线' : '离线'),
    timeCell(row.createdAt),
    timeCell(row.lastActiveAt),
    textCell(row.deviceCount, { num: true }),
    textCell(`${row.games} / ${row.wins}`, { num: true }),
    textCell(bal ? bal.balance : '—', { num: true }),
    textCell(pay ? (pay.rechargeFen / 100).toFixed(2) : '—', { num: true }),
    ops,
  );
  return tr;
}

/** 详情：并行取用户/风控/钱包/订单/最近对局；任何单端点失败只降级对应区块。 */
async function showPlayerDetail(row) {
  $('pl-detail').hidden = false;
  const box = $('pl-detail-body');
  box.textContent = '加载中…';
  const id = encodeURIComponent(row.userId);
  const [profile, risk, wallet, orders, games] = await Promise.all([
    api(`/api/admin/users/${id}`),
    api(`/api/admin/risk/users/${id}`),
    api(`/api/admin/wallet/accounts/${id}`),
    api(`/api/admin/pay/orders?userId=${id}`),
    api(`/api/admin/players/${id}/games?limit=20`),
  ]);
  if (handleAuth(profile.status)) return;
  box.textContent = '';
  const p = profile.body?.data ?? {};
  const d = risk.body?.data ?? {};
  const w = wallet.body?.data ?? {};
  const orderRows = Array.isArray(orders.body?.data?.items) ? orders.body.data.items.slice(0, 20) : [];
  const gameRows = Array.isArray(games.body?.data?.items) ? games.body.data.items : [];

  const section = (title) => box.append(el('h3', 'panel-title sub', title));
  const line = (text) => box.append(el('p', 'hint', text));

  section('基本资料');
  line(`用户ID：${p.userId ?? row.userId}`);
  line(`手机号：${p.phone ?? row.phone}　昵称：${p.nickname ?? '—'}`);
  line(`状态：${p.status ?? row.status}　在线：${(p.online ?? row.online) ? '是' : '否'}　注册：${fmtTime(p.createdAt)}`);
  line(`最后活跃：${fmtTime(row.lastActiveAt)}　设备数（窗口）：${d.stats?.deviceCount ?? row.deviceCount}　对局/胜场（两玩法合计）：${d.stats?.games ?? row.games} / ${d.stats?.wins ?? row.wins}`);

  section('余额与充值');
  const recharge = playersState.recharges.get(row.userId);
  line(`余额：${w.balance ?? '—'} 金币　累计充值（未扣退款）：${recharge ? (recharge.rechargeFen / 100).toFixed(2) + ' 元' : '—'}`);
  box.append(simpleTable(
    ['订单号', '金额（分）', '状态', '入账时间'],
    orderRows.map((o) => [o.orderNo, o.amountFen, o.status, fmtTime(o.creditedAt)]),
    '（无充值记录）',
  ));

  section('最近对局');
  box.append(simpleTable(
    ['玩法', '模式', '底分', '身份', '结果', '积分变化', '时间'],
    gameRows.map((g) => [
      gameLabelText(g.gameType),
      g.mode,
      g.baseScore,
      g.role ?? '—',
      g.won ? '胜' : '负',
      g.scoreChange,
      fmtTime(g.endedAt),
    ]),
    '（无对局记录）',
  ));

  section('设备与风控');
  const devices = Array.isArray(d.devices) ? d.devices : [];
  box.append(simpleTable(
    ['设备号', '首次出现', '最后出现'],
    devices.map((x) => [x.deviceId, fmtTime(x.firstSeenAt), fmtTime(x.lastSeenAt)]),
    '（无设备记录）',
  ));
  const entries = Array.isArray(d.entries) ? d.entries : [];
  box.append(simpleTable(
    ['风控条目', '分数', '状态', '处置人', '时间'],
    entries.map((e) => [e.id, e.score, e.status, e.handledBy ?? '—', fmtTime(e.createdAt)]),
    '（无风控记录）',
  ));
  line(`限流来源：${d.limitSource ?? '无'}　封禁旗：${d.bannedFlagPresent ? '在' : '无'}`);

  line(`绑定设备：${d.binding ? `${d.binding.deviceId}（${fmtTime(d.binding.boundAt)}）` : '无'}　谓词命中：同 IP ${d.hits?.sameIp ?? 0} / 同设备 ${d.hits?.sameDevice ?? 0}`);

  section('处置');
  const actionBar = el('div', 'player-action-bar');
  // 设备绑定：仅在已绑定时提供解绑（端点 404 = 未绑定）。
  if (d.binding) {
    const unbindBtn = btn('解绑设备', 'btn');
    unbindBtn.addEventListener('click', () => {
      if (!confirm(`确定解绑该账号的设备绑定？
账号：${row.userId}
已绑定设备：${d.binding.deviceId}
解绑后可在新设备首次登录时静默重新绑定；本操作写风控审计。`)) return;
      unbindBtn.disabled = true;
      applyUnbindDevice(row).finally(() => {
        if (unbindBtn.isConnected) unbindBtn.disabled = false;
      });
    });
    actionBar.append(unbindBtn);
  }
  // 终审 F2：孤儿封禁旗态（status=active 但 risk:banned 旗在）必须可解封。
  const banned = p.status === 'banned' || d.accountStatus === 'banned' || d.bannedFlagPresent === true;
  const actionBtn = btn(banned ? '解封' : '封禁', banned ? 'btn' : 'btn primary');
  actionBtn.addEventListener('click', async () => {
    const action = banned ? 'unban' : 'ban';
    const text = await modalPrompt({
      title: action === 'ban' ? '封禁玩家' : '解封玩家',
      desc: `确认对 ${p.phone ?? row.phone ?? row.userId} 执行${action === 'ban' ? '封禁' : '解封'}？需填写原因（1–200 字）。`,
      placeholder: '处置原因（必填）',
      confirmLabel: action === 'ban' ? '确认封禁' : '确认解封',
      maxlength: 200,
    });
    if (text === null) return;
    const reason = text.trim();
    if (reason.length === 0 || reason.length > 200) return showMsg('请填写处置原因（1–200 字）', 'err');
    actionBtn.disabled = true;
    applyPlayerAction(row.userId, action, reason).finally(() => {
      if (actionBtn.isConnected) actionBtn.disabled = false;
    });
  });
  actionBar.append(actionBtn);
  box.append(actionBar);
}


/** 解绑设备（玩家页）：DELETE；成功后就地重拉详情，404 = 未绑定/已被解绑。 */
async function applyUnbindDevice(row) {
  const { status, body } = await api(
    `/api/admin/risk/users/${encodeURIComponent(row.userId)}/device-binding`,
    { method: 'DELETE' },
  );
  if (status === 200) {
    showMsg('已解绑设备', 'ok');
    await showPlayerDetail(row);
    return;
  }
  if (status === 404) return showMsg(body?.message ?? '该用户未绑定设备（可能已被其他管理员解绑）', 'err');
  if (status === 403) return showMsg('当前角色无权解绑设备', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`解绑失败（HTTP ${status}）`, 'err');
}

async function applyPlayerAction(userId, action, reason) {
  const { status, body } = await api('/api/admin/risk/actions', {
    method: 'POST',
    body: JSON.stringify({ userId, action, reason }),
  });
  if (status === 200) {
    showMsg(action === 'ban' ? '已封禁' : '已解封', 'ok');
    const row = playersState.rows.find((r) => r.userId === userId) ?? { userId };
    await loadPlayers();
    await showPlayerDetail(row);
    return;
  }
  if (status === 409) return showMsg(`状态冲突：${body?.message ?? ''}`, 'err');
  if (status === 403) return showMsg('当前角色无权执行该动作', 'err');
  if (handleAuth(status)) return;
  if (status === 0) return showMsg('无法连接服务端', 'err');
  return showMsg(`处置失败（HTTP ${status}）`, 'err');
}

/** 简单只读表（玩家详情的订单/对局/设备/风控区块共用）。 */
function simpleTable(headers, rows, emptyText) {
  if (rows.length === 0) return el('p', 'hint', emptyText);
  const table = document.createElement('table');
  table.className = 'data-table nested';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of headers) hr.append(el('th', '', h));
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of row) tr.append(textCell(value));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function resetPlayers() {
  playersState.filter = { q: '', status: '', online: '', activity: '' };
  playersState.page = 1;
  playersState.pageSize = 20;
  playersState.rows = [];
  playersState.total = 0;
  playersState.summary = null;
  playersState.balances = new Map();
  playersState.recharges = new Map();
  playersState.loading = false;
  playersState.loaded = false;
  $('pl-summary').textContent = '';
  $('pl-body').textContent = '';
  $('pl-detail-body').textContent = '';
  $('pl-detail').hidden = true;
  $('pl-empty').textContent = '';
  if ($('pl-q')) $('pl-q').value = '';
  if ($('pl-status')) $('pl-status').value = '';
  if ($('pl-online')) $('pl-online').value = '';
  if ($('pl-activity')) $('pl-activity').value = '';
  if ($('pl-page-size')) $('pl-page-size').value = '20';
}

/** 玩家页筛选/分页控件接线（wire() 调用）。 */
function wirePlayers() {
  const apply = () => {
    playersState.filter = {
      q: $('pl-q').value.trim(),
      status: $('pl-status').value,
      online: $('pl-online').value,
      activity: $('pl-activity').value,
    };
    playersState.page = 1;
    loadPlayers();
  };
  $('pl-search-btn').addEventListener('click', apply);
  $('pl-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  });
  $('pl-reset-btn').addEventListener('click', () => {
    resetPlayers();
    loadPlayers();
  });
  $('pl-prev-btn').addEventListener('click', () => {
    if (playersState.page > 1) {
      playersState.page -= 1;
      loadPlayers();
    }
  });
  $('pl-next-btn').addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(playersState.total / playersState.pageSize));
    if (playersState.page < pages) {
      playersState.page += 1;
      loadPlayers();
    }
  });
  $('pl-page-size').addEventListener('change', () => {
    playersState.pageSize = Number($('pl-page-size').value);
    playersState.page = 1;
    loadPlayers();
  });
  $('pl-back-btn').addEventListener('click', () => {
    $('pl-detail').hidden = true;
  });
}

/** 启动：有完整会话（token + username + role）⇒ 主视图（各视图懒加载）；否则登录视图。 */
function boot() {
  wire();
  if (sessionStorage.getItem(TOKEN_KEY) && usernameOf() && roleOf()) showMainView();
  else showLoginView();
}

boot();

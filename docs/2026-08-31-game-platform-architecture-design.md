# 棋牌游戏平台架构设计文档

> 版本: v3.2
> 日期: 2026-09-01
> 状态: 评审中

---

## 修订历史

| 版本 | 日期 | 内容 |
|------|------|------|
| v1.0 | 2026-08-31 | 初始设计文档 |
| v1.1 | 2026-08-31 | 修复Redis脚本、添加心跳/断线重连/提现/MongoDB/版本控制/幂等性 |
| v2.0 | 2026-08-31 | 添加对账审计、测试策略、配置管理、完整支付流程、RBAC、备份策略、风控系统、性能基准、运维文档 |
| v2.1 | 2026-08-31 | 新增服务间通信机制（RPC/事件/追踪/重试/服务发现） |
| v3.0 | 2026-08-31 | 新增前端架构（uni-app）、游戏状态持久化与故障恢复、ELO匹配算法、支付安全验签、K8s管理 |
| v3.1 | 2026-08-31 | 修复Redis金额类型不一致/支付签名精度/对账逻辑漏洞；补充风控处置流程、机器人虚拟经济隔离、连接路由策略；扩展错误码至38条；补充WebSocket消息清单、数据库ER、上线检查清单、性能优化策略；修正章节编号 |
| v3.2 | 2026-09-01 | 补充提现超时自动回滚机制（5.5节）；补充支付渠道抽象层（5.6.1节）；新增前端零业务逻辑约束清单（4.8节）；补充WebSocket直连路由架构（第三章附录）；补充Admin Service完整设计（5.12节）；统一技术栈表述为uni-app主方案；明确MongoDB归档边界；修复Record Service引用时序；错误码扩展至38条 |

---

## 目录

1. [项目概述](#一项目概述)
2. [整体架构](#二整体架构)
3. [服务间通信机制](#三服务间通信机制)
4. [前端架构设计](#四前端架构设计)
5. [服务拆分](#五服务拆分)
6. [机器人系统详细设计](#六机器人系统详细设计)
7. [游戏状态持久化与故障恢复](#七游戏状态持久化与故障恢复方案)
8. [监控与看板系统](#八监控与看板系统)
9. [匹配系统完整设计](#九匹配系统完整设计)
10. [网络层安全设计](#十网络层安全设计)
11. [WebSocket通信协议](#十一websocket通信协议)
12. [GitHub参考项目](#十二github参考项目)
13. [开发阶段规划](#十三开发阶段规划)
14. [Kubernetes 管理设计](#十四kubernetes-管理设计)
15. [部署架构](#十五部署架构)
16. [附录](#十六附录)

> 本文档包含 5 项新增补充设计：4.8 前端零业务逻辑约束、5.5.1 提现超时回滚、5.6.1 支付渠道抽象层、5.7.1 Record Service 实现、5.12 Admin Service 设计

---

## 一、项目概述

### 1.1 项目目标

开发一个跨平台棋牌游戏App，支持斗地主、麻将（血流成河、成都麻将等）、扑克等多种玩法。前端负责渲染和用户操作反馈，后端负责所有业务逻辑处理。

### 1.2 核心需求

| 需求 | 说明 |
|------|------|
| 多玩法支持 | 斗地主、麻将（血流成河/成麻）、扑克等，预留扩展接口 |
| 跨平台客户端 | H5 + 微信小游戏 + APP（uni-app 为主，Cocos3D 为备选） |
| 实时对战 | WebSocket 实时通信，支持万级并发 |
| 货币系统 | 平台货币，充值/提现/投注/结算 |
| 对账审计 | Redis余额与MySQL流水每日对账，差异自动告警 |
| 机器人系统 | 智能AI机器人填充房间，模拟真人体验 |
| 监控告警 | 全链路打点、日志采集、异常告警 |
| 数据看板 | 实时监控各服务状态、业务数据 |
| 测试覆盖 | 单元测试 + 集成测试 + 压力测试 + AI对战模拟 |

---

## 二、整体架构

### 2.1 架构图

```
                    ┌─────────────────┐
                    │   客户端 (跨平台) │
                    │    uni-app      │ ← 主方案
                    │  (Cocos3D 备选) │
                    │  H5 + 小程序+APP │
                    └────────┬────────┘
                             │ WSS / HTTPS
                    ┌────────▼────────┐
                    │   API Gateway    │
                    │  Kong/Traefik    │
                    │  (鉴权/限流/路由) │
                    └────────┬────────┘
                             │
        ┌────────┬───────────┼───────────┬────────┐
        ▼        ▼           ▼           ▼        ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │User    │ │Room    │ │Game    │ │Currency│ │Payment │
   │Service │ │Service │ │Service │ │Service │ │Service │
   └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘
       │          │          │          │          │
       └──────────┴──────────┴────┬─────┴──────────┘
                          │       │
                    ┌─────▼───────▼─────┐
                    │   Robot System     │
                    │  (机器人池+AI引擎) │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Dashboard Service│
                    │  (统计+日志+监控)  │
                    └─────────┬─────────┘
                              │
                   ┌──────────┼──────────┐
                   ▼          ▼          ▼
              ┌────────┐ ┌────────┐ ┌────────┐
              │Elastic-│ │Prometheus│ │ MySQL │
              │search  │ │ + Grafana│ │       │
              └────────┘ └────────┘ └────────┘
```

### 2.2 技术栈选型

| 层次 | 技术 | 说明 |
|------|------|------|
| 客户端 | uni-app (Vue 3) | 主方案：一套代码打包多端；Cocos3D 为备选（仅用于需要 WebGL 3D 渲染的特定玩法） |
| 网关层 | Kong / Traefik | API网关，鉴权、限流、路由 |
| 通信层 | WebSocket (WSS) | 实时双向通信 |
| 后端框架 | NestJS (TypeScript) | 微服务架构，模块化设计 |
| 消息队列 | RabbitMQ / Redis Stream | 服务间异步通信 |
| 缓存/状态 | Redis Cluster | 游戏状态、房间数据、会话管理 |
| 持久化 | MySQL 8.0 | 用户、货币、交易记录（在线账本） |
| 日志存储 | MongoDB | 对战记录归档（灵活 schema + TTL 自动过期，仅用于历史查询，不参与实时对局） |
| 日志检索 | Elasticsearch | 日志存储与检索 |
| 监控 | Prometheus + Grafana | 指标采集与可视化 |
| 告警 | Alertmanager | 告警规则与通知 |
| 容器化 | Docker + Kubernetes | 容器编排与部署 |

### 2.3 性能目标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| WebSocket延迟 | < 50ms | P99 |
| 游戏操作响应 | < 100ms | P99 |
| 并发玩家 | 10,000 | 峰值在线 |
| 系统可用性 | 99.9% | SLA |
| 数据库查询 | < 10ms | P99 |
| Redis操作 | < 1ms | P99 |
| API网关延迟 | < 20ms | P99 |
| 支付回调处理 | < 500ms | P99 |

### 2.4 测试策略

#### 2.4.1 单元测试（Jest）
```
测试范围：
- 游戏策略验证（出牌合法性、胜负判定）
- 货币操作原子性（Lua脚本测试）
- 消息解析与校验
- AI决策逻辑（斗地主/麻将AI单元测试）
- 配置文件解析与热更新

工具：jest + NestJS Test
覆盖率目标：核心业务逻辑 > 80%
```

#### 2.4.2 集成测试（supertest + docker-compose）
```
测试范围：
- API 端到端测试
- WebSocket 连接测试（心跳、断连、重连）
- 数据库事务测试
- 支付回调流程测试
- 机器人自动填充测试

工具：supertest + docker-compose + testcontainers
```

#### 2.4.3 压力测试（k6 / JMeter）
```
测试场景：
1. 万级WebSocket连接并发测试
2. 每秒1000次游戏操作并发测试
3. 数据库读写压测（1000 QPS）
4. Redis集群压力测试
5. 支付回调并发测试

目标：
- WebSocket连接稳定无异常断开
- 游戏操作P99延迟 < 100ms
- 系统无内存泄漏
```

#### 2.4.4 AI对战模拟测试
```
测试方法：
- 斗地主AI vs AI 对战 10000局
- 麻将AI vs AI 对战 10000局
- 统计胜率、出牌合理性、犯错率

验证指标：
- 高级AI胜率 > 70%（vs初级AI）
- 中级AI胜率 > 50%（vs初级AI）
- 低级AI犯错率符合预期配置
```

---

## 三、服务间通信机制

### 3.1 通信模式总览

系统采用 **同步 RPC + 异步事件** 的混合通信模式：

```
┌────────────────────────────────────────────────────────────────┐
│                        通信模式矩阵                            │
├──────────────────────┬───────────────┬─────────────────────────┤
│ 通信模式              │ 使用场景       │ 技术选型                │
├──────────────────────┼───────────────┼─────────────────────────┤
│ 同步 RPC (TCP)        │ 需要返回值     │ NestJS @ClientProxy     │
│                       │ 强一致性操作   │ Transport.TCP           │
├──────────────────────┼───────────────┼─────────────────────────┤
│ 异步事件 (RabbitMQ)   │ 最终一致性     │ NestJS @EventPattern    │
│                       │ 解耦通知       │ exchange: game-events   │
├──────────────────────┼───────────────┼─────────────────────────┤
│ Redis Stream          │ 实时数据流     │ 订阅/发布模式            │
│                       │ 低延迟场景     │                         │
└──────────────────────┴───────────────┴─────────────────────────┘
```

### 3.2 同步 RPC 通信

#### 3.2.1 客户端配置

```typescript
// Room Service 中注入 Game Service 客户端
import { ClientProxyFactory, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'GAME_SERVICE',
        transport: Transport.TCP,
        options: { host: 'game-service', port: 3001 },
      },
      {
        name: 'CURRENCY_SERVICE',
        transport: Transport.TCP,
        options: { host: 'currency-service', port: 3002 },
      },
    ]),
  ],
})
export class RoomModule {}
```

#### 3.2.2 关键 RPC 接口定义

```typescript
// room-to-game.rpc.ts
export interface RoomToGameRPC {
  // 开始游戏
  startGame(data: StartGameRequest): Observable<GameStartedResponse>;

  // 处理玩家操作
  handleAction(data: HandleActionRequest): Observable<ActionResult>;

  // 结束游戏
  finishGame(data: FinishGameRequest): Observable<GameFinishedResponse>;

  // 获取游戏状态
  getGameState(data: GetGameStateRequest): Observable<GameState>;
}

// game-to-currency.rpc.ts
export interface GameToCurrencyRPC {
  // 扣费
  deduct(data: DeductRequest): Observable<DeductResponse>;

  // 结算
  settlement(data: SettlementRequest): Observable<SettlementResponse>;
}
```

#### 3.2.3 错误处理与重试

```typescript
// 重试策略配置
interface RetryConfig {
  strategy: 'none' | 'fixed' | 'exponential';
  maxAttempts: number;
  delayMs: number;
  backoffFactor: number;
}

// 带重试的 RPC 调用
async callWithRetry<T>(
  client: ClientProxy,
  pattern: any,
  data: any,
  config: RetryConfig
): Promise<T> {
  return client.send<T>(pattern, data).pipe(
    retry({
      count: config.maxAttempts,
      delay: (err, retryCount) => {
        const delay = config.strategy === 'exponential'
          ? config.delayMs * Math.pow(config.backoffFactor, retryCount - 1)
          : config.delayMs;
        return timer(delay);
      },
    }),
    catchError(err => {
      this.logger.error(`RPC call failed after ${config.maxAttempts} attempts: ${err.message}`);
      throw new ServiceUnavailableError(err.message);
    })
  ).toPromise();
}
```

### 3.3 异步事件通信

#### 3.3.1 事件定义

```typescript
enum ServiceEvent {
  // 游戏事件
  GAME_FINISHED = 'game.finished',
  GAME_STARTED = 'game.started',
  PLAYER_JOINED = 'player.joined',
  PLAYER_LEFT = 'player.left',
  BOT_JOINED = 'bot.joined',
  BOT_LEFT = 'bot.left',

  // 支付事件
  PAYMENT_CREATED = 'payment.created',
  PAYMENT_COMPLETED = 'payment.completed',
  PAYMENT_FAILED = 'payment.failed',
  PAYMENT_REFUNDED = 'payment.refunded',

  // 货币事件
  CURRENCY_DEDUCTED = 'currency.deducted',
  CURRENCY_ADDED = 'currency.added',
  CURRENCY_WITHDRAWN = 'currency.withdrawn',

  // 用户事件
  USER_REGISTERED = 'user.registered',
  USER_BANNED = 'user.banned',
  USER_UNBANNED = 'user.unbanned',

  // 对账事件
  RECONCILIATION_COMPLETED = 'reconciliation.completed',
  RECONCILIATION_MISMATCH = 'reconciliation.mismatch',
}
```

#### 3.3.2 事件消息格式

```typescript
// 通用事件格式
interface ServiceEvent<T = any> {
  event: ServiceEvent;
  timestamp: Date;
  correlationId: string;     // 关联ID（全链路追踪）
  source: string;            // 来源服务名
  data: T;
  metadata?: {
    requestId?: string;      // 原始请求ID
    traceId?: string;        // 追踪ID
    version?: number;        // 事件版本
  };
}

// 游戏结束事件
interface GameFinishedEvent extends ServiceEvent {
  event: ServiceEvent.GAME_FINISHED;
  data: {
    matchId: string;
    gameType: string;
    baseScore: number;
    players: Array<{
      userId: string;
      isRobot: boolean;
      seat: number;
      result: 'win' | 'lose' | 'draw';
      scoreBefore: number;
      scoreAfter: number;
      scoreChange: number;
    }>;
    duration: number;
  };
}
```

#### 3.3.3 事件消费者

```typescript
// Record Service 监听游戏结束事件（详见 5.7.1 Record Service 完整实现）
@EventPattern(ServiceEvent.GAME_FINISHED)
async onGameFinished(event: GameFinishedEvent) {
  // 1. 存储对战记录到 MongoDB（归档，30天TTL）
  //    详见 5.7.1 RecordService.saveMatchRecord()
  await this.recordService.saveMatchRecord(event.data);

  // 2. 更新统计指标
  await this.metricsService.increment('games.finished', { gameType: event.data.gameType });
}

// Audit Service 监听货币变动事件
@EventPattern(ServiceEvent.CURRENCY_DEDUCTED)
async onCurrencyDeducted(event: ServiceEvent) {
  await this.auditService.logTransaction(event.data);
}

// Dashboard Service 监听用户注册事件
@EventPattern(ServiceEvent.USER_REGISTERED)
async onUserRegistered(event: ServiceEvent) {
  await this.dashboardService.updateStats('users.registered');
}
```

### 3.4 跨服务调用矩阵

```
┌──────────────────┬──────────────────────────────────────────────┐
│ 触发方            │ 调用目标 & 方式                               │
├──────────────────┼──────────────────────────────────────────────┤
│ Room Service     │ Game Service (RPC) — 开始/结束游戏           │
│ Room Service     │ Robot System (RPC) — 填充机器人               │
│ Game Service     │ Currency Service (RPC) — 扣费/结算           │
│ Game Service     │ Record Service (Event) — 游戏结束通知         │
│ Game Service     │ Dashboard Service (Event) — 游戏状态更新      │
│ Payment Service  │ Currency Service (RPC) — 充值/提现           │
│ Payment Service  │ Audit Service (Event) — 支付事件通知          │
│ Currency Service │ Audit Service (Event) — 货币变动通知          │
│ Currency Service │ Reconciliation Service (Event) — 对账触发    │
│ Robot System     │ Room Service (RPC) — 加入/离开房间            │
│ Admin Service    │ Currency Service (RPC) — 管理员操作           │
│ Admin Service    │ User Service (RPC) — 封禁/解封用户            │
│ Dashboard Service│ All Services (RPC) — 查询统计数据             │
└──────────────────┴──────────────────────────────────────────────┘
```

### 3.5 调用链追踪

```typescript
// 追踪上下文
interface TraceContext {
  traceId: string;       // 全链路唯一ID
  spanId: string;        // 当前 span ID
  parentSpanId: string | null;
  requestId: string;     // 原始请求ID
  service: string;       // 当前服务名
}

// NestJS 拦截器自动注入追踪上下文
@Injectable()
export class TraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const traceId = req.headers['x-trace-id'] as string || uuid();

    const traceContext: TraceContext = {
      traceId,
      spanId: uuid(),
      parentSpanId: req.headers['x-parent-span-id'] as string || null,
      requestId: req.headers['x-request-id'] as string || uuid(),
      service: context.getHandler().parentModule.constructor.name,
    };

    // 将追踪上下文传递到响应头
    const res = context.switchToHttp().getResponse();
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-span-id', traceContext.spanId);

    return next.handle().pipe(
      tap(() => {
        this.logger.debug(`[${traceId}] Request completed`);
      }),
      catchError(err => {
        this.logger.error(`[${traceId}] Request failed: ${err.message}`);
        throw err;
      })
    );
  }
}
```

### 3.6 服务发现与健康检查

```typescript
// 健康检查端点
@Get('health')
async healthCheck(): Promise<HealthCheckResult> {
  const checks = await Promise.all([
    this.redisService.ping().then(() => ({ redis: 'up' })).catch(() => ({ redis: 'down' })),
    this.mysqlService.query('SELECT 1').then(() => ({ mysql: 'up' })).catch(() => ({ mysql: 'down' })),
  ]);

  const allHealthy = checks.every(c => Object.values(c)[0] === 'up');
  return { status: allHealthy ? 'ok' : 'degraded', checks };
}

// 服务注册到 Consul/K8s
// 每个服务启动时注册，退出时注销
// 其他服务通过服务发现获取实例地址
```

---

## 四、前端架构设计

### 4.1 技术选型

| 层次 | 技术 | 说明 |
|------|------|------|
| 框架 | uni-app (Vue 3) | 一套代码打包 H5/微信小程序/APP |
| 状态管理 | Pinia | 轻量级、TypeScript 友好 |
| UI 组件 | uView Plus | uni-app 生态最全的 UI 库 |
| 网络层 | 自定义 WebSocket 客户端 + Axios | 封装统一接口 |
| 构建工具 | Vite | 快速构建 |

### 4.2 目录结构

```
apps/client/
├── pages/
│   ├── index/              # 启动页（版本号检查）
│   ├── login/              # 登录注册
│   ├── hall/               # 大厅
│   ├── room/               # 房间列表（好友房/随机房/积分房）
│   ├── game/               # 游戏房间
│   └── profile/            # 个人中心
├── components/
│   ├── game-board/         # 通用牌桌组件
│   ├── card/               # 扑克牌组件
│   ├── tile/               # 麻将牌组件
│   ├── player-seat/        # 玩家座位组件
│   └── action-panel/       # 操作面板（出牌/过/等待）
├── store/
│   ├── modules/
│   │   ├── user.ts         # 用户状态（登录态、信息、余额）
│   │   ├── game.ts         # 游戏状态（当前房间、对局数据）
│   │   ├── ws.ts           # WebSocket 连接状态
│   │   └── payment.ts      # 支付状态
│   └── index.ts
├── utils/
│   ├── ws-client.ts        # WebSocket 客户端封装
│   ├── http-client.ts      # HTTP 请求封装
│   ├── sign.ts             # 请求签名工具
│   ├── version.ts          # 版本检查
│   └── encrypt.ts          # 加密工具
├── api/
│   ├── user.ts
│   ├── room.ts
│   ├── game.ts
│   ├── payment.ts
│   └── record.ts
├── types/
│   ├── ws-message.ts       # WebSocket 消息类型定义
│   ├── game-state.ts       # 游戏状态类型
│   └── user.ts
├── App.vue
├── main.ts
└── manifest.json
```

### 4.3 WebSocket 客户端核心设计

```typescript
// utils/ws-client.ts
class WsClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private reconnectAttempts = 0;
  private maxReconnect = 10;

  // 串行消息处理队列
  private messageQueue: Queue<WSMessage> = new Queue();
  private processing = false;

  // 心跳
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  connect(url: string, token: string): void {
    this.ws = new WebSocket(this.buildUrl(url), [token]);
    this.setupHandlers();
  }

  private setupHandlers() {
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.processQueue();
    };
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (this.isServerPush(msg)) {
        this.messageQueue.enqueue(msg); // 服务端推送入队
      } else {
        this.handleResponse(msg); // 客户端请求的响应直接处理
      }
    };
    this.ws.onclose = () => this.scheduleReconnect();
  }

  // 发送请求（客户端主动操作）
  send(type: string, payload: any): number {
    this.seq++;
    const msg: WSMessage = {
      type, seq: this.seq,
      timestamp: Date.now(), payload,
    };
    this.ws?.send(JSON.stringify(msg));
    return this.seq;
  }

  // 注册服务器推送回调
  on(type: string, callback: (data: any) => void): void {
    this.handlers.set(type, callback);
  }
}
```

**消息优先级处理策略**：
- 优先级 1（最高）：客户端请求的响应（seq > 0 且 pendingRequests.has(seq)）
  → 立即处理，不进入队列
- 优先级 2（高）：游戏状态更新（type 以 'game.state' 或 'game.' 开头）
  → 进入高优先级队列，优先于通知
- 优先级 3（低）：其他推送消息（通知、事件等）
  → 进入普通队列，按序处理
- 队列满时：丢弃优先级 3 的最旧消息，保留优先级 1/2

**防丢包机制**：
- 状态更新消息携带 version 字段
- 客户端发现 version 回退时，主动发起 reconnect
- 重连后服务端返回缺失的状态片段

**消息优先级判断**：
```typescript
enum MessagePriority {
  IMMEDIATE = 0,      // 客户端响应，立即处理
  HIGH = 1,           // 游戏状态更新
  NORMAL = 2,         // 其他推送
}

function getMessagePriority(msg: WSMessage): MessagePriority {
  if (msg.seq > 0 && this.pendingRequests.has(msg.seq)) {
    return MessagePriority.IMMEDIATE;
  }
  if (msg.type.startsWith('game.') || msg.type === 'state_update') {
    return MessagePriority.HIGH;
  }
  return MessagePriority.NORMAL;
}
```

### 4.4 Pinia 状态管理

**核心状态模块**：

```typescript
// store/modules/game.ts
export const useGameStore = defineStore('game', () => {
  // 当前游戏状态
  const gameState = ref<GameState | null>(null);
  const currentRoomId = ref<string | null>(null);
  const mySeat = ref<number>(-1);

  // 游戏流程相关
  const isMyTurn = ref(false);
  const lastActionSeq = ref(0);
  const gameVersion = ref(0);

  // 游戏结果
  const gameResult = ref<GameResult | null>(null);
  const settlement = ref<Settlement[] | null>(null);

  function updateGameState(newState: GameState) {
    if (newState.version <= gameVersion.value) return; // 防止回退
    gameState.value = newState;
    gameVersion.value = newState.version;
  }

  return { gameState, currentRoomId, isMyTurn, updateGameState, ... };
});

// store/modules/ws.ts
export const useWsStore = defineStore('ws', () => {
  const isConnected = ref(false);
  const connectError = ref<string | null>(null);

  function setConnected(status: boolean) {
    isConnected.value = status;
  }

  return { isConnected, setConnected, ... };
});
```

### 4.5 版本管理流程

```
APP启动
  │
  ▼
┌─────────────────┐
│ 检查最新版本     │ ← GET /api/version/check
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
 新版本      同版本/旧版本
    │         │
    ▼         ▼
┌────────┐ ┌──────────────┐
│强制更新 │ │继续正常使用    │
│弹窗    │ │但兼容降级接口  │
│不能关闭│ │              │
└────────┘ └──────────────┘
```

**接口兼容策略**：
- 服务端新增接口字段 → 客户端无感知（可选字段）
- 服务端删除接口字段 → 返回 `426 UPGRADE_REQUIRED`，客户端提示更新
- 核心协议变更 → 版本号升级，旧客户端无法连接

### 4.6 跨端适配策略

| 平台 | 差异点 | 处理方式 |
|------|--------|----------|
| H5 | 无原生能力 | 使用 webview 替代 |
| 微信小程序 | 生命周期不同 | 使用 `onShow`/`onHide` 管理 WS 连接 |
| APP | 需要原生推送 | 集成 Push 插件 |

### 4.7 性能优化策略

**【资源加载策略】**
- 牌面/动画资源懒加载：仅在当前页面需要时加载
- 预加载：大厅页面预加载游戏资源，进入游戏时无缝切换
- 资源版本控制：文件名含 hash，利用浏览器缓存

**【内存管理】**
- 页面离开时清理 WebSocket 连接和定时器
- 组件销毁时移除所有事件监听（on/off 配对）
- 游戏状态对象深拷贝后存入 store，避免引用泄漏

**【低端设备适配】**
- FPS 检测：低端设备自动降帧率至 30fps
- 简化动画：低端设备关闭粒子特效和过渡动画
- 字体优化：使用系统字体，减少自定义字体加载

**【弱网环境处理】**
- 本地乐观更新：出牌后立即更新 UI，收到服务端确认后才生效
- 离线缓存：缓存最近 10 条游戏状态，断网时可展示
- 延迟容忍：网络延迟 > 500ms 时显示"网络不佳"提示

### 4.8 前端"零业务逻辑"约束清单 ⭐ 强制

#### 4.8.1 设计原则

**前端是游戏的哑终端（Dumb Terminal）—— 所有游戏规则、合法性校验、胜负判定、货币结算均在服务端完成。**

该原则是反作弊、合规审查（赌博法规要求服务端权威）和跨平台一致性的基础。违反以下约束的代码禁止合入主干。

---

#### 4.8.2 FORBIDDEN 操作清单（前端绝对禁止）

| # | 禁止行为 | 违反后果 | 替代方案 |
|---|----------|----------|----------|
| F01 | 客户端验证出牌合法性（如检查炸弹、顺子、胡牌规则） | 客户端被篡改后可任意出牌 | 发送原始操作，由服务端 `game.service.handleAction()` 验证 |
| F02 | 客户端计算输赢结果或分数变化 | 可篡改分数显示，引发欺诈 | 接收服务端 `game.finished` / `game.settlement` 广播 |
| F03 | 客户端本地缓存游戏状态用于决策（如"我手牌有哪些"） | 状态可能过期，导致决策错误 | 每次操作后以服务端 `state_update` 为准，仅用于渲染 |
| F04 | 客户端存储或展示余额（不经过服务端确认） | 余额可能被伪造，导致错误消费决策 | 仅展示服务端推送的余额，不本地存储 |
| F05 | 客户端执行匹配逻辑（如筛选房间、计算ELO） | 可绕过匹配规则，进入高等级房间 | 匹配完全由 `RoomService` + `MatchMaker` 在服务端完成 |
| F06 | 客户端使用本地时间判断游戏规则（如"2小时超时"） | 客户端时钟可被篡改 | 使用服务端时间戳，超时由服务端检测 |
| F07 | 客户端预判或提前提交操作（在 `current_turn` 广播之前） | 时序错乱，可能被用于攻击 | 收到 `current_turn` 且 `isMyTurn=true` 后才允许交互 |
| F08 | 客户端缓存 WebSocket 消息历史并回放 | 可能伪造历史操作记录 | 重连后由服务端返回从 `lastSeq` 之后的增量事件 |
| F09 | 客户端直接构造支付参数（金额、渠道） | 可篡改支付金额 | 金额由服务端订单创建，客户端仅发起唤起 |
| F10 | 客户端比较两个玩家手牌/牌型强度做决策展示 | 可展示错误信息误导其他玩家 | 服务端推送已计算好的对比结果 |

**【代码注释标记示例】**

```typescript
// ⚠️ FORBIDDEN: 禁止在客户端验证出牌合法性
// 出牌合法性由 GameService.validatePlay() 在服务端验证
// 客户端只负责发送原始操作，不得二次校验
function onPlayCards(cards: Card[]): void {
  // 错误做法：
  // if (!isValidPlay(cards)) { showWarning('出牌不合法'); return; }  // ❌ F01

  // 正确做法：
  ws.send('game.action', { cards, seq: ws.incrementSeq() });  // ✅
}

// ⚠️ FORBIDDEN: 禁止客户端计算分数变化
// 分数变化由服务端结算后通过 game.settlement 推送
let myBalance = 10000; // ❌ F04 - 本地存储余额
myBalance += 300;      // ❌ F04 - 本地修改余额

// ✅ 正确：仅展示服务端推送的值
ws.on('game.settlement', (data) => {
  displayBalance(data.myBalanceAfter);  // 直接展示服务端数据
});
```

---

#### 4.8.3 MANDATORY 行为清单（前端必须遵守）

| # | 强制行为 | 实现方式 |
|---|----------|----------|
| M01 | 每次发送操作请求时携带服务端时间戳（用于服务端验证延迟） | `ws.send()` 时附上 `{ timestamp: Date.now() }`，服务端检查 `|clientTs - serverTs| < 5s` |
| M02 | 收到服务端状态更新后，以服务端状态为准，丢弃本地冲突状态 | `updateGameState(newState)` 中校验 `newState.version > currentVersion`，否则丢弃 |
| M03 | 断线重连时携带最后收到的 `seq` 号，由服务端返回增量事件 | `ws.send('game.reconnect', { lastSeq, lastVersion })` |
| M04 | 展示余额前必须确认收到服务端推送，不得自行计算 | 余额仅在 `currency.balance` 或 `game.settlement` 消息后更新 |
| M05 | 所有用户操作（出牌、过牌、认输等）必须记录操作日志，用于调试和审计 | `logUserAction(action, seq, timestamp)` 写入本地日志，定期上报服务端 |
| M06 | 操作后显示 loading/乐观状态，但不提交业务结果，直到收到服务端 ack | 点击出牌后按钮变灰（loading），收到 `state_update` 后才允许下次操作 |
| M07 | 收到 `game.finished` 或 `game.result` 后才结束本局 UI 状态 | 禁止客户端提前显示"你赢了"等结果 |
| M08 | 版本号不匹配或 seq 不连续时，主动断开重连，不尝试本地修复 | 检测到 `version <= currentVersion` 时触发 `ws.reconnect()` |
| M09 | 前端代码中禁止包含任何游戏规则常量（如"斗地主底分默认100"） | 游戏配置从服务端 `GameConfigService` 获取，前端不硬编码 |
| M10 | 前端不包含任何货币计算逻辑（加减乘除金额） | 货币相关操作全部通过服务端 RPC 完成 |

**【代码注释标记示例】**

```typescript
// ✅ M02: 服务端状态为权威，本地版本落后则重连
function updateGameState(newState: GameState): void {
  if (newState.version <= gameStore.gameVersion) {
    // 版本回退或重复，触发重连
    ws.reconnect();
    return;
  }
  gameStore.gameState = newState;
  gameStore.gameVersion = newState.version;
}

// ✅ M03: 断线重连携带 lastSeq
function onDisconnect(): void {
  reconnectPayload = {
    lastSeq: ws.lastSeq,
    lastVersion: gameStore.gameVersion,
  };
}

// ✅ M06: 操作后等待服务端 ack
async function playCards(cards: Card[]): Promise<void> {
  ui.setLoading(true);
  const seq = ws.send('game.action', { cards });

  // 不立即更新 UI，等待 state_update 广播
  ws.once('game.state_update', (state) => {
    if (state.lastActionSeq === seq) {
      ui.setLoading(false);
      gameStore.updateGameState(state);
    }
  });
}

// ✅ M09: 不从前端硬编码游戏配置
// ❌ const BASE_SCORE = 100;
// ✅ 从服务端配置接口获取
const config = await api.getGameConfig(gameType);
const baseScore = config.baseScore;
```

---

#### 4.8.4 为什么这一约束至关重要

**1. 反作弊（Anti-Cheat）**
客户端代码完全由用户控制，任何在客户端执行的校验、计算、决策都可以被绕过或篡改。历史上几乎所有棋牌游戏作弊事件（改分器、透视挂、自动出牌）都源于客户端存在业务逻辑。将全部逻辑移至服务端是唯一可靠的反作弊手段。

**2. 法律合规（Legal Compliance）**
中国及多数司法管辖区的赌博/棋牌法规要求：
- 游戏结果必须由权威服务端决定，客户端不得参与判定
- 所有货币操作必须有服务端审计日志
- 游戏随机性（洗牌、发牌）必须由服务端生成并提供可验证证据
前端遵守本约束是合规审计的必要条件。

**3. 跨平台一致性（Cross-Platform Consistency）**
H5、微信小程序、APP 三端代码共享同一份前端逻辑。如果业务逻辑分散在各端实现，难以保证行为一致。服务端作为唯一逻辑中心，确保所有客户端看到相同的游戏规则和结算结果。

**4. 维护成本**
逻辑集中在服务端，新增玩法只需在 `GameService` 中添加新的 `IGameStrategy` 实现，前端无需修改业务逻辑，仅需适配新的 UI 展示。

---

#### 4.8.5 违规检测机制

为强制执行本约束，在代码审查和 CI 中引入静态检测：

```typescript
// .eslint-plugin-zero-business-logic/rules/forbidden-calls.js
// ESLint 规则：检测前端代码中的 forbidden 调用
module.exports = {
  rules: {
    'no-client-card-validation': {
      create(context) {
        return {
          CallExpression(node) {
            // 禁止客户端调用任何含 "isValid" "checkRule" "calculateWin" 的函数
            if (node.callee.name?.includes('isValid') ||
                node.callee.name?.includes('checkRule') ||
                node.callee.name?.includes('calculateWin')) {
              context.report({
                node,
                message: '❌ FORBIDDEN (F01/F02): 客户端禁止执行游戏规则校验或胜负计算，请移步服务端',
              });
            }
          },
        };
      },
    },
    'no-local-balance': {
      create(context) {
        return {
          VariableDeclarator(node) {
            // 禁止前端声明 balance 相关变量
            if (node.id.name?.includes('balance') || node.id.name?.includes('score')) {
              context.report({
                node,
                message: '❌ FORBIDDEN (F04): 前端禁止本地存储余额/分数，仅展示服务端推送值',
              });
            }
          },
        };
      },
    },
  },
};
```

> **违规代码禁止合入主干，CI 流水线中 ESLint 扫描发现 FORBIDDEN 调用时将阻断合并。**

---

## 五、服务拆分

### 5.1 API Gateway（API网关）

**职责：**
- 统一入口，HTTPS/WSS终止
- JWT Token验证、IP黑白名单
- 限流（Per-IP / Per-User）
- WebSocket握手与路由

**配置示例：**
```yaml
# Nginx 配置
location /ws/ {
    proxy_pass http://game-service;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Real-IP $remote_addr;
    # 保持长连接（1小时超时）
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

### 5.1.1 WebSocket 心跳机制

棋牌游戏是长连接，必须实现心跳检测：

```typescript
// WebSocket 连接管理
class WebSocketManager {
  private readonly HEARTBEAT_INTERVAL = 30000;  // 30秒心跳
  private readonly TIMEOUT = 90000;             // 90秒无响应断开
  
  handleConnection(ws: WebSocket, userId: string) {
    const conn = new ConnectionState(userId, ws);
    this.connections.set(userId, conn);
    
    // 心跳定时器
    conn.heartbeatTimer = setInterval(() => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    }, this.HEARTBEAT_INTERVAL);
    
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    
    // 全局心跳检测（清理僵尸连接）
    if (!this.heartbeatCheckTimer) {
      this.heartbeatCheckTimer = setInterval(() => {
        this.connections.forEach((conn) => {
          if (!conn.ws.isAlive) {
            conn.ws.terminate();
            this.handleDisconnect(conn.userId);
          }
        });
      }, this.HEARTBEAT_INTERVAL);
    }
  }
}
```

### 5.2 User Service（用户服务）

**职责：** 注册登录、角色权限（RBAC）、等级系统、好友关系

**RBAC权限模型：**
```typescript
enum AdminRole {
  SUPER_ADMIN = 'super_admin',   // 所有权限
  FINANCE = 'finance',           // 仅财务操作（充值/提现审核/对账查看）
  OPERATOR = 'operator',         // 仅运营操作（封号/解封/数据查看）
  VIEWER = 'viewer',             // 只读权限（看板查看）
}

// 权限映射
const ROLE_PERMISSIONS: Record<AdminRole, string[]> = {
  super_admin: ['*'],                              // 所有权限
  finance: ['currency.add', 'currency.withdraw', 'audit.view'],
  operator: ['user.ban', 'user.unban', 'data.view'],
  viewer: ['dashboard.view'],
};
```

**核心接口：**
```typescript
interface UserService {
  // 注册登录
  register(phone: string, password: string): Promise<User>;
  login(phone: string, password: string): Promise<LoginResult>;
  refreshToken(token: string): Promise<string>;

  // 用户信息
  getUserInfo(userId: string): Promise<UserInfo>;
  updateProfile(userId: string, profile: Partial<Profile>): Promise<void>;

  // 好友系统
  addFriend(userId: string, friendId: string): Promise<void>;
  removeFriend(userId: string, friendId: string): Promise<void>;
  getFriends(userId: string): Promise<UserInfo[]>;

  // 管理员操作（RBAC）
  banUser(targetUserId: string, operatorId: string, reason: string): Promise<void>;
  unbanUser(targetUserId: string, operatorId: string): Promise<void>;
}
```

**管理员权限表：**
```sql
CREATE TABLE admin_users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin', 'finance', 'operator', 'viewer') NOT NULL,
  status ENUM('active', 'banned') DEFAULT 'active',
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admin_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_id VARCHAR(36) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_id VARCHAR(36),
  details JSON,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_action (admin_id, action),
  INDEX idx_created_at (created_at)
);
```

**数据库表：**
```sql
CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nickname VARCHAR(50),
  avatar VARCHAR(255),
  level INT DEFAULT 1,
  exp INT DEFAULT 0,
  status ENUM('active', 'banned') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE user_friends (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  friend_id VARCHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_friend (user_id, friend_id)
);
```

### 5.3 Room Service（房间服务）

**职责：** 创建房间、匹配系统、入座踢人、房间状态管理

**房间状态机：**
```
  等待中 ──► 游戏中 ──► 已结束
     ▲         │
     │         └──► 已取消
     └──────────────
```

**Redis 数据结构：**
```
# 房间数据
key: room:{roomId}
fields:
  gameType: "doudizhu"
  baseScore: 100
  status: "waiting" | "playing" | "finished" | "cancelled"
  players: '[{"userId":"xxx","seat":0},{"userId":"yyy","seat":1}]'
  currentPlayer: 0
  maxPlayers: 3
  createdAt: 1725084000
  timeoutAt: 1725084300  # 超时时间

# 匹配队列
key: match_queue:{gameType}:{roomType}
members: [{"userId":"xxx","elo":1500,"enteredAt":1725084000}, ...]
```

**匹配算法（ELO + 多维度）：**
```typescript
class MatchMaker {
  async findMatch(gameType: string, playerId: string, options: MatchOptions): Promise<string | null> {
    const player = await this.getPlayerData(playerId);
    const queueKey = `match_queue:${gameType}:${options.roomType || 'random'}`;
    
    // 多维度匹配：ELO分数 + 网络延迟 + 等待时间
    const candidates = await this.redis.zrangebyscore(
      queueKey,
      player.elo - options.eloRange,
      player.elo + options.eloRange
    );
    
    // 过滤符合条件的候选者
    const validCandidates = candidates.filter(c => 
      this.isCompatible(player, c, options)
    );
    
    if (validCandidates.length > 0) {
      return this.createRoom(player, validCandidates[0]);
    }
    
    // 匹配不到时，返回null（由Robot System填充）
    return null;
  }
  
  private isCompatible(player1: Player, player2: Player, options: MatchOptions): boolean {
    // 检查房间类型是否一致
    if (player1.roomType !== player2.roomType) return false;
    
    // 检查网络延迟是否在可接受范围
    if (Math.abs(player1.latency - player2.latency) > options.maxLatencyDiff) return false;
    
    return true;
  }
}

interface MatchOptions {
  eloRange: number;       // ELO分数允许差异
  maxLatencyDiff: number; // 最大延迟差异（ms）
  roomType?: string;      // 房间类型（默认 'random'）
}
```

### 5.4 Game Service（游戏服务）⭐ 核心

**职责：** 所有游戏逻辑（洗牌、发牌、出牌验证、胜负判定、结算）

**策略模式设计：**
```typescript
// 游戏策略接口
interface IGameStrategy {
  readonly gameType: string;
  
  // 初始化
  init(playerCount: number): GameState;
  
  // 处理玩家操作
  handleAction(state: GameState, action: GameAction): Result;
  
  // 胜负判定
  calculateWinner(state: GameState): WinnerResult;
  
  // 货币结算
  calculateSettlement(winner: WinnerResult, baseScore: number): Settlement[];
}

// 游戏状态（带版本控制）
interface GameState {
  matchId: string;
  version: number;           // 乐观锁版本号
  gameType: string;
  status: 'waiting' | 'playing' | 'finished';
  players: PlayerState[];
  currentPlayerIndex: number;
  lastActionSeq: number;     // 最后处理的序列号
  createdAt: Date;
  updatedAt: Date;
}

// 斗地主策略实现
@Injectable()
export class DoudizhuStrategy implements IGameStrategy {
  readonly gameType = 'doudizhu';
  
  async handleAction(state: GameState, action: GameAction): Promise<Result> {
    // 1. 验证玩家身份
    this.validatePlayer(state, action.playerId);
    
    // 2. 验证轮到该玩家
    this.validateTurn(state, action.playerId);
    
    // 3. 验证消息幂等性（防止重复请求）
    if (action.seq <= state.lastActionSeq) {
      return { code: 40002, message: '重复消息' };
    }
    
    // 4. 验证出牌合法性
    this.validatePlay(state, action.cards);
    
    // 5. 更新游戏状态（版本号+1）
    const newState = this.applyAction(state, action);
    newState.version++;
    newState.lastActionSeq = action.seq;
    
    // 6. 检查游戏是否结束
    if (this.isGameOver(newState)) {
      return this.finishGame(newState);
    }
    
    // 7. 广播新状态
    return { state: newState, nextPlayer: this.getNextPlayer(newState) };
  }
}

// 麻将策略实现
@Injectable()
export class MahjongXueliuStrategy implements IGameStrategy {
  readonly gameType = 'mahjong_xl';
  // 同样的接口，不同的实现
}
```

**游戏流程：**
```
1. 客户端发送 join_room 请求
2. Room Service 校验 → 转发给 Game Service
3. Game Service 初始化游戏状态（存入Redis，带版本号）
4. 广播 start_game 消息给所有玩家
5. 轮到玩家操作 → 广播 current_turn 消息
6. 玩家出牌 → Game Service 验证 → 更新状态 → 广播 state_update
7. 游戏结束 → 结算 → 广播 game_finished
8. 存储对战记录

【断线重连流程】
9a. 玩家断线 → Redis 记录断线时间
9b. 玩家重连 → 发送 reconnect 消息 + seq 号
9c. 服务端验证 → 返回最新版本状态（如果游戏未结束）
9d. 继续游戏（从断点恢复）或提示游戏已结束
```

### 5.5 Currency Service（货币服务）

**职责：** 货币增减、余额查询、扣费校验、防超扣

**关键设计：**
```typescript
@Injectable()
export class CurrencyService {
  // 金额单位说明：内部统一使用整数分存储（金额 × 100），
  // 避免浮点数精度问题。传入的 amount 参数单位为元，
  // 写入 Redis 前自动转换为分。
  // 扣费（原子操作，防超扣）
  async deduct(userId: string, amount: number, reason: string): Promise<boolean> {
    const redis = this.redisService.getConnection();
    
    // Lua脚本保证原子性
    const result = await redis.eval(`
      local key = KEYS[1]
      local amount = tonumber(ARGV[1])
      local requestId = ARGV[2]
      
// 使用 Integer 类型（统一整数分存储，与 add/rejectWithdraw 的 INCRBY 保持一致）
      local balance = tonumber(redis.call('GET', key) or '0')
      if balance < amount then
        return 0  -- 余额不足
      end
      
      -- 检查是否重复请求
      local existed = redis.call('EXISTS', 'dedup:' .. requestId)
      if existed then
        return -1  -- 重复请求
      end
      
      -- 扣费（String 类型原子操作）
      -- amount 单位为元，转换为分（整数）后操作
      local amountInCents = math.floor(amount * 100)
      redis.call('DECRBY', key, amountInCents)
      redis.call('SET', 'dedup:' .. requestId, '1', 'EX', 3600)
      return 1  -- 成功
    `, 1, `currency:${userId}`, amount, uuid());
    
    if (result === 1) {
      await this.logTransaction(userId, 'bet', -amount, reason);
      return true;
    }
    return false;
  }
  
  // 充值
  async add(userId: string, amount: number, source: string): Promise<void> {
    const redis = this.redisService.getConnection();
    // 金额转换为整数分后再加
    const amountInCents = Math.round(amount * 100);
    await redis.eval("local key = KEYS[1]; local v = tonumber(ARGV[1]); redis.call('INCRBY', key, v); return 1", 1, `currency:${userId}`, String(amountInCents));
    await this.logTransaction(userId, 'recharge', amount, source);
  }
  
  // 查询余额
  async getBalance(userId: string): Promise<number> {
    const redis = this.redisService.getConnection();
    return Number(await redis.get(`currency:${userId}`)) || 0;
  }
  
  // 提现申请
  async createWithdrawRequest(userId: string, amount: number, bankInfo: any): Promise<string> {
    const requestId = uuid();
    
    // 检查余额
    const balance = await this.getBalance(userId);
    if (balance < amount) {
      throw new InsufficientBalanceError();
    }
    
    // 计算手续费（例如1%）
    const fee = Math.round(amount * 0.01);
    const actualAmount = amount - fee;
    
    // 创建提现申请记录
    await this.mysql.query(`
      INSERT INTO withdraw_requests 
      (id, user_id, amount, fee, actual_amount, bank_info, status, request_id)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `, [requestId, userId, amount, fee, actualAmount, JSON.stringify(bankInfo), requestId]);
    
    // 预扣金额（防止用户同时发起多个提现）
    const redis = this.redisService.getConnection();
    await redis.eval(`
      local key = KEYS[1]
      local amount = tonumber(ARGV[1])
      local balance = tonumber(redis.call('GET', key) or '0')
      if balance < amount then return 0 end
      -- amount 单位为元，转换为分（整数）后操作
      local amountInCents = math.floor(amount * 100)
      redis.call('DECRBY', key, amountInCents)
      return 1
    `, 1, `currency:${userId}`, amount);
    
    return requestId;
  }
  
  // 管理员确认提现
  async confirmWithdraw(requestId: string, operatorId: string): Promise<void> {
    const request = await this.mysql.query(
      'SELECT * FROM withdraw_requests WHERE id = ?', [requestId]
    );
    if (request.status !== 'pending') {
      throw new Error('请求状态异常');
    }
    
    // 执行打款（调用支付渠道）
    const paymentResult = await this.paymentChannel.withdraw({
      userId: request.userId,
      amount: request.actualAmount,
      bankInfo: request.bankInfo,
    });
    
    // 更新状态
    await this.mysql.query(`
      UPDATE withdraw_requests 
      SET status = 'completed', payment_result = ?, operator_id = ?
      WHERE id = ?
    `, [JSON.stringify(paymentResult), operatorId, requestId]);
    
    // 记录流水
    await this.logTransaction(request.userId, 'withdraw', -request.amount, `提现(${requestId})`);
  }
  
  // 拒绝提现
  async rejectWithdraw(requestId: string, reason: string): Promise<void> {
    const request = await this.mysql.query(
      'SELECT * FROM withdraw_requests WHERE id = ?', [requestId]
    );
    
    // 退回预扣金额
    const redis = this.redisService.getConnection();
    // 金额转换为整数分后再退还
    const amountInCents = Math.round(request.amount * 100);
    await redis.eval("local key = KEYS[1]; local v = tonumber(ARGV[1]); redis.call('INCRBY', key, v); return 1", 1, `currency:${request.userId}`, String(amountInCents));
    
    // 更新状态
    await this.mysql.query(`
      UPDATE withdraw_requests 
      SET status = 'rejected', reject_reason = ?
      WHERE id = ?
    `, [reason, requestId]);
  }
}
```

#### 5.5.1 提现超时自动回滚机制

**问题背景：** 提现流程为"申请→预扣金额（Redis DECRBY）→管理员审核（confirm/reject）→打款/退回"，但若无超时兜底，管理员长时间未审核时用户余额将永久冻结，造成投诉和对账差异。

**数据库变更：**

```sql
ALTER TABLE withdraw_requests
  ADD COLUMN timeout_at TIMESTAMP NOT NULL DEFAULT (DATE_ADD(NOW(), INTERVAL 72 HOUR))
    COMMENT '超时回滚时间点，超过此时仍未审核则自动退回' AFTER updated_at,
  ADD COLUMN timeout_hours TINYINT NOT NULL DEFAULT 72
    COMMENT '可配置的超时时长（小时），默认72小时' AFTER timeout_at,
  ADD COLUMN rollback_executed_at TIMESTAMP NULL
    COMMENT '超时自动回滚执行时间' AFTER status,
  MODIFY COLUMN status ENUM('pending', 'completed', 'rejected', 'timeout') DEFAULT 'pending'
    COMMENT '新增 timeout 状态';
```

**超时退回 Lua 脚本（幂等去重）：**

```typescript
// Currency Service 中的撤回 Lua 脚本
const ROLLBACK_WITHDRAW_LUA = `
local key         = KEYS[1]        -- currency:{userId}
local amountCents = tonumber(ARGV[1])   -- 预扣金额（分，整数）
local dedupKey    = ARGV[2]        -- dedup:rollback:{requestId}

-- 1. 幂等去重：防止定时任务并发执行导致重复退回
local existed = redis.call('EXISTS', dedupKey)
if existed == 1 then
  return 0  -- 已处理，跳过
end

-- 2. 原子增加余额（INCRBY，与 createWithdrawRequest 中的 DECRBY 单位一致）
local newBalance = redis.call('INCRBY', key, amountCents)

-- 3. 写入去重标记（TTL 1 小时）
redis.call('SET', dedupKey, '1', 'EX', 3600)

return 1  -- 成功，返回新余额（分）
`;
```

**定时任务（NestJS Cron）：**

```typescript
// Currency Service 中新增超时检查逻辑
@Injectable()
export class CurrencyService {
  // 每分钟扫描超时未审核的提现申请
  @Cron(CronExpression.EVERY_MINUTE)
  async handleWithdrawTimeouts() {
    const mysql = this.mysqlService.getConnection();
    const expiredRequests = await mysql.query(`
      SELECT id, user_id, amount
      FROM withdraw_requests
      WHERE status = 'pending'
        AND timeout_at < NOW()
      ORDER BY timeout_at ASC
      LIMIT 100
    `);

    for (const req of expiredRequests) {
      try {
        await this.timeoutRollbackWithdraw(req.id, req.user_id, req.amount);
      } catch (error) {
        this.logger.error(`Failed to rollback withdraw ${req.id}: ${error.message}`);
        // 失败记录写入补偿表，供人工介入
        await mysql.query(
          `INSERT INTO withdraw_rollback_failed
           (request_id, user_id, amount, error_msg, created_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [req.id, req.user_id, req.amount, error.message]
        );
      }
    }
  }

  private async timeoutRollbackWithdraw(
    requestId: string, userId: string, amount: number
  ): Promise<void> {
    const redis = this.redisService.getConnection();
    const amountInCents = Math.round(amount * 100);
    const dedupKey = `dedup:rollback:${requestId}`;

    const result = await redis.eval(ROLLBACK_WITHDRAW_LUA, 1,
      `currency:${userId}`, String(amountInCents), dedupKey
    );

    if (result === 0) return; // 已处理

    await redis.eval(`
      UPDATE withdraw_requests
      SET status = 'timeout', rollback_executed_at = NOW()
      WHERE id = ? AND status = 'pending'
    `, 0, requestId);

    // 记录流水（type='withdraw_timeout'）
    await this.logTransaction(userId, 'withdraw_timeout', amount,
      `提现超时自动退回(${requestId})`);

    // 推送用户通知
    await this.notifyUser(userId, 'WITHDRAW_TIMEOUT', {
      requestId, amount, message: '您的提现申请因超时已自动退回至账户。'
    });
  }
}
```

**补偿表设计：**

```sql
CREATE TABLE IF NOT EXISTS withdraw_rollback_failed (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  amount DECIMAL(20, 2) NOT NULL,
  error_msg TEXT NOT NULL,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  INDEX idx_request_id (request_id),
  INDEX idx_created_at (created_at)
);
```

**配置管理：**

```typescript
export const CurrencyConfig = {
  defaultWithdrawTimeoutHours: 72,    // 全局默认超时（小时）
  timeoutScanIntervalMinutes: 1,      // 定时任务扫描间隔
  maxBatchSize: 100,                  // 单次扫描最大处理条数
  rollbackFlowType: 'withdraw_timeout',
};
```

**对账处理：** 超时退回属于正常业务流水，`AuditService.dailyReconciliation()` 需额外校验 `timeout` 状态的 `withdraw_requests` 总金额与 `currency_flows.type='withdraw_timeout'` 记录总和的一致性。

---

**数据库表：**
```sql
CREATE TABLE currency_flows (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  amount DECIMAL(20, 2) NOT NULL,
  balance_before DECIMAL(20, 2) NOT NULL,
  balance_after DECIMAL(20, 2) NOT NULL,
  type ENUM('recharge', 'bet', 'win', 'lose', 'withdraw', 'admin_add', 'fee', 'refund'),
  reason VARCHAR(255),
  reference_id VARCHAR(64),
  request_id VARCHAR(64) UNIQUE,  -- 防重复
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at),
  INDEX idx_reference (reference_id),
  INDEX idx_created_at (created_at)
) PARTITION BY RANGE (YEAR(created_at) * 100 + MONTH(created_at)) (
  PARTITION p202608 VALUES LESS THAN (202609),
  PARTITION p202609 VALUES LESS THAN (202610),
  PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- 提现申请表
CREATE TABLE withdraw_requests (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  amount DECIMAL(20, 2) NOT NULL,
  fee DECIMAL(20, 2) NOT NULL,
  actual_amount DECIMAL(20, 2) NOT NULL,
  bank_info JSON NOT NULL,
  status ENUM('pending', 'completed', 'rejected') DEFAULT 'pending',
  payment_result JSON,
  reject_reason VARCHAR(255),
  operator_id VARCHAR(36),
  request_id VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_status (user_id, status),
  INDEX idx_created_at (created_at)
);
```

**【数据库 ER 关系】**

users (1) ──┬── (N) currency_flows
            ├── (1) withdraw_requests
            ├── (N) user_friends (双向)
            └── (N) admin_audit_logs (admin_id)

payment_orders (N) ── (1) users
game_configs ── (1) 多个游戏类型（gameType 为唯一键）

**索引设计说明**：
- `currency_flows.idx_user_time`: 高频查询用户余额流水，按 user_id + created_at 联合索引
- `currency_flows.idx_reference`: 对账时使用 reference_id 快速定位交易
- `payment_orders.idx_user_status`: 支付回调处理时按用户+状态筛选
- `withdraw_requests.idx_user_status`: 提现审核时按用户+状态筛选
- `admin_audit_logs.idx_admin_action`: 管理员操作审计查询

### 5.6 Payment Service（支付服务）

**职责：** 对接第三方支付、订单管理、回调处理、退款管理

**完整支付状态机：**
```
pending → paid → completed → settlement
              ↓
         failed → refund_pending → refunded
              ↓
         expired → cancelled
```

**支付流程：**
```
【充值流程】
1. 客户端发起充值请求 → Payment Service 创建订单（status: pending）
2. 调用支付渠道（支付宝/PayPal/微信）生成支付链接/二维码
3. 用户完成支付 → 支付渠道异步回调
4. Payment Service 验证回调签名
5. 幂等性检查（防止重复回调）
6. 调用 Currency Service 充值
7. 更新订单状态为 completed
8. 返回结果给客户端

【退款流程】
1. 用户/管理员发起退款申请
2. 验证原始订单状态（已支付且未退款）
3. 调用支付渠道退款接口
4. 退款成功 → 调用 Currency Service 加回货币
5. 更新订单状态为 refunded

【订单超时】
- 支付订单有效期30分钟
- 定时任务扫描超时的pending订单，自动取消
```

**安全设计：**
```typescript
async handleCallback(callback: PaymentCallback): Promise<void> {
  // 1. 验证签名
  const isValid = await this.verifySignature(callback);
  if (!isValid) {
    throw new Error('Invalid signature');
  }

  // 2. 幂等性检查
  const existed = await this.orderService.findOrder(callback.orderId);
  if (existed && existed.status === 'paid') {
    this.logger.warn(`Duplicate callback for order: ${callback.orderId}`);
    return;
  }

  // 3. 执行充值
  await this.currencyService.add(callback.userId, callback.amount, 'payment');

  // 4. 更新订单状态
  await this.orderService.updateStatus(callback.orderId, 'paid', {
    callbackData: callback,
    processedAt: new Date(),
  });

  // 5. 记录审计日志
  await this.auditService.logPaymentEvent({
    orderId: callback.orderId,
    type: 'payment_received',
    amount: callback.amount,
    userId: callback.userId,
  });
}
```

**数据库表：**
```sql
CREATE TABLE payment_orders (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  amount DECIMAL(20, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'CNY',
  channel VARCHAR(50) NOT NULL,       -- 支付渠道
  order_no VARCHAR(64) UNIQUE,         -- 渠道订单号
  status ENUM('pending', 'paid', 'failed', 'refunding', 'refunded', 'expired', 'cancelled'),
  callback_data JSON,                  -- 回调原始数据
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP,
  expired_at TIMESTAMP,
  INDEX idx_user_status (user_id, status),
  INDEX idx_created_at (created_at)
);
```

### 5.6.1 支付渠道抽象层 ⭐ 新增

**背景：** 原设计仅提及"支付宝/PayPal/微信"，但未定义渠道接口抽象，新增渠道需修改核心业务逻辑。本设计通过 `PaymentChannel` 接口实现渠道无关的核心流程。

#### 5.6.1.1 PaymentChannel 接口定义

```typescript
// payment/channel/payment-channel.interface.ts

/**
 * 支付渠道统一接口
 * 所有支付渠道必须实现此接口，确保 Payment Service 核心逻辑与渠道无关
 */
export interface PaymentChannel {
  /**
   * 创建订单并返回支付参数（支付链接/二维码/小程序调起参数等）
   */
  createOrder(order: CreateOrderRequest): Promise<ChannelPayParams>;

  /**
   * 查询订单支付状态
   */
  queryStatus(orderNo: string): Promise<ChannelOrderStatus>;

  /**
   * 发起退款（支持部分退款和全额退款）
   */
  refund(orderNo: string, refundAmount: number, reason: string): Promise<RefundResult>;

  /**
   * 验签：验证回调数据的签名合法性
   */
  verifySignature(data: ChannelCallbackData): Promise<boolean>;

  /**
   * 获取渠道标识名（用于日志和错误映射）
   */
  getChannelName(): string;
}

export interface CreateOrderRequest {
  orderId: string;            // 平台侧订单ID（UUID）
  userId: string;
  amount: number;             // 金额（分，整数）
  currency: string;           // 币种（CNY/USD等）
  subject: string;
  notifyUrl: string;          // 异步通知URL
  returnUrl?: string;
  timeout?: number;           // 订单有效期（分钟），默认30
  extra?: Record<string, any>;
}

export interface ChannelPayParams {
  channel: string;
  payUrl?: string;            // H5/PC 支付链接
  qrCodeUrl?: string;         // 二维码URL
  miniAppParams?: Record<string, any>; // 小程序调起参数
  appScheme?: string;         // App 调起 scheme
  extra?: Record<string, any>;
}

export interface ChannelOrderStatus {
  orderNo: string;
  status: 'WAITING' | 'SUCCESS' | 'CLOSED' | 'REFUNDED' | 'UNKNOWN';
  paidAt?: Date;
  channelExtra?: Record<string, any>;
}

export interface RefundResult {
  success: boolean;
  channelRefundNo: string;
  refundAmount: number;
  channelMessage?: string;
}

export type ChannelCallbackData = Record<string, any> & {
  channel: string;
  signature?: string;
};
```

#### 5.6.1.2 Channel Factory 模式

```typescript
// payment/channel/channel-factory.ts
@Injectable()
export class ChannelFactory {
  private readonly registry = new Map<string, PaymentChannel>();

  constructor(
    private readonly alipay: AlipayChannel,
    private readonly wechatPay: WechatPayChannel,
    private readonly paypal: PayPalChannel,
  ) {
    this.registry.set('alipay', this.alipay);
    this.registry.set('wechat_pay', this.wechatPay);
    this.registry.set('paypal', this.paypal);
  }

  getChannel(channelCode: string): PaymentChannel {
    const channel = this.registry.get(channelCode);
    if (!channel) throw new ChannelNotSupportedError(channelCode);
    return channel;
  }

  register(channel: PaymentChannel): void {
    this.registry.set(channel.getChannelName(), channel);
  }
}
```

#### 5.6.1.3 handleCallback 适配（渠道无关）

```typescript
// payment/payment.service.ts（适配后）
async handleCallback(channelCode: string, callbackData: any): Promise<void> {
  // 1. 获取对应渠道实例（工厂模式，核心逻辑与渠道解耦）
  const channel = this.channelFactory.getChannel(channelCode);

  // 2. 验签（各渠道算法不同，由 channel 实现负责）
  const isValid = await channel.verifySignature(callbackData);
  if (!isValid) {
    this.logger.warn(`[${channelCode}] 回调签名验证失败`);
    throw new PaymentPlatformError(15002, `渠道 ${channelCode} 签名验证失败`);
  }

  // 3. 提取平台订单号（不同渠道字段名不同，由 channel 实现归一化）
  const normalized = this.normalizeCallback(channelCode, callbackData);
  const { orderId, amount, userId } = normalized;

  // 4. 幂等性检查
  const order = await this.orderService.findOrder(orderId);
  if (order && (order.status === 'paid' || order.status === 'completed')) {
    this.logger.warn(`[${channelCode}] 重复回调，订单已处理: ${orderId}`);
    return;
  }

  // 5. 金额校验
  if (order.amount !== amount) {
    this.logger.error(`[${channelCode}] 金额不匹配: ${orderId}`);
    await this.orderService.updateStatus(orderId, 'failed', { reason: 'amount_mismatch' });
    return;
  }

  // 6. 执行充值
  await this.currencyService.add(userId, amount, `payment:${channelCode}`);

  // 7. 更新订单状态
  await this.orderService.updateStatus(orderId, 'paid', {
    callbackData, processedAt: new Date(),
  });
}

// 各渠道回调数据归一化
private normalizeCallback(channelCode: string, data: any): {
  orderId: string; amount: number; userId: string;
} {
  switch (channelCode) {
    case 'alipay':
      return {
        orderId: data.out_trade_no,
        amount: Math.round(parseFloat(data.total_amount) * 100),  // 元→分
        userId: data.buyer_user_id,
      };
    case 'wechat_pay':
      return {
        orderId: data.out_trade_no,
        amount: data.amount.total,  // 已是分
        userId: data.openid,
      };
    case 'paypal':
      return {
        orderId: data.resource.purchase_units[0].reference_id,
        amount: Math.round(parseFloat(data.resource.amount.value) * 100),
        userId: data.resource.payer.email_address,
      };
    default:
      throw new Error(`未知渠道: ${channelCode}`);
  }
}
```

#### 5.6.1.4 签名算法对比

| 渠道 | 签名算法 | 密钥类型 | 验签方式 |
|------|----------|----------|----------|
| 支付宝 | RSA2（RSA-SHA256） | 应用私钥/公钥对 | 支付宝公钥验签回调 |
| 微信支付 V2 | HMAC-SHA256 | 商户API密钥（32位） | API密钥验签 |
| 微信支付 V3 | RSA（商户私钥）+ 平台证书 | 商户私钥 + 微信平台证书 | 平台证书公钥验签 |
| PayPal | OAuth2.0 + 事件验证 | Client ID/Secret | 通过 `/v1/events/verify` API 二次验证 |

> **【安全注意】** 各渠道签名算法不同，`PaymentChannel.verifySignature()` 由具体渠道实现负责。`handleCallback` 不关心验签细节，只需调用统一接口。密钥信息通过 `@Inject('XXX_CONFIG')` 注入，禁止硬编码。

#### 5.6.1.5 新增支付渠道流程

接入新渠道（如 Apple Pay、Stripe）时：
```
1. 实现 PaymentChannel 接口（5个方法）
2. 在 ChannelFactory 构造函数中注入新渠道实例
3. 在 registry 中注册 channelCode → channel 映射
4. 在 UnifiedPaymentErrorMapper.errorMap 中添加渠道错误码映射
5. 在 normalizeCallback 中添加渠道数据归一化逻辑
6. payment_orders.channel 字段记录新渠道标识
```
无需修改 `handleCallback` 主流程代码，符合开闭原则。

---

### 5.6.2 支付安全验签流程

#### 威胁模型

```
攻击场景                          防护措施
─────────────────────────────────────────────────────
1. 伪造支付回调                   HMAC-SHA256 签名验证
2. 重放回调（重复充值）             幂等性检查（订单状态）
3. 篡改回调数据                   签名覆盖所有字段
4. 密钥泄露                       密钥轮换 + 多密钥支持
5. 支付金额篡改                   签名包含金额字段
6. 过期回调                       时间窗口验证
```

#### 签名算法设计

```typescript
// 签名生成（支付渠道 → 我们的服务器）
async function generateSignature(
  orderId: string,
  amount: number,
  timestamp: number,
  secretKey: string
): Promise<string> {
  // 金额转换为整数分，避免浮点精度问题
  const amountInCents = Math.round(amount * 100);
  const signString = `${orderId}${amountInCents}${timestamp}${secretKey}`;
  return hmacSha256(signString, secretKey);
}

// 签名验证（接收支付回调）
async function verifySignature(
  callback: PaymentCallback,
  secretKey: string
): Promise<boolean> {
  // 1. 时间窗口验证（±5分钟）
  const now = Date.now();
  if (Math.abs(now - callback.timestamp) > 5 * 60 * 1000) {
    throw new Error('回调已过期');
  }

  // 2. 签名验证
  const expectedSignature = await generateSignature(
    callback.orderId,
    callback.amount,
    callback.timestamp,
    secretKey
  );

  if (callback.signature !== expectedSignature) {
    throw new Error('签名验证失败');
  }

  return true;
}
/**
 * 【重要】签名字符串中金额必须使用整数分（Math.round(amount * 100)），
 * 不能直接使用浮点数。否则 "100.50" 会被序列化为 "100.5"，
 * 导致签名计算结果不一致，攻击者可能通过调整小数位伪造有效签名。
 */
```

#### 密钥管理

```typescript
// 密钥轮换策略
interface KeyConfig {
  activeKey: string;      // 当前使用的密钥
  previousKeys: {         // 历史密钥（用于验证旧签名）
    key: string;
    expireAt: Date;
  }[];
}

class KeyManager {
  // 每季度轮换一次密钥
  async rotateKeys() {
    const newKey = generateSecretKey();
    const oldKey = this.config.activeKey;

    // 旧密钥保留 3 个月
    this.config.previousKeys.push({
      key: oldKey,
      expireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    });

    this.config.activeKey = newKey;
    await this.saveKeyConfig();
  }

  // 验证签名（支持多密钥）
  async verifyWithAllKeys(data: any, signature: string): Promise<boolean> {
    const candidates = [
      this.config.activeKey,
      ...this.config.previousKeys.filter(k => k.expireAt > new Date()).map(k => k.key)
    ];

    for (const key of candidates) {
      if (await verifySignature(data, key) === signature) {
        return true;
      }
    }
    return false;
  }
}
```

#### 支付回调处理完整流程

```typescript
async function handlePaymentCallback(callback: PaymentCallback): Promise<void> {
  // 1. 签名验证（支持多密钥）
  const isValid = await keyManager.verifyWithAllKeys(callback, callback.signature);
  if (!isValid) {
    logger.warn('支付回调签名验证失败', { orderId: callback.orderId });
    return;
  }

  // 2. 幂等性检查
  const order = await orderService.getOrder(callback.orderId);
  if (order.status === 'paid' || order.status === 'completed') {
    logger.warn('重复回调', { orderId: callback.orderId });
    return;
  }

  // 3. 金额校验
  if (order.amount !== callback.amount) {
    logger.error('金额不匹配', { orderId: callback.orderId, expected: order.amount, actual: callback.amount });
    await orderService.updateStatus(callback.orderId, 'failed');
    return;
  }

  // 4. 执行充值
  await currencyService.add(callback.userId, callback.amount, 'payment');

  // 5. 更新订单状态
  await orderService.updateStatus(callback.orderId, 'paid', {
    callbackData: callback,
    processedAt: new Date(),
  });

  // 6. 异步通知
  await eventBus.publish('payment.completed', { orderId: callback.orderId, userId: callback.userId });
}
```

#### 支付风控规则

```typescript
interface PaymentRiskRule {
  name: string;
  condition: (userId: string, amount: number, context: any) => boolean;
  action: 'block' | 'review' | 'warn';
}

const paymentRiskRules: PaymentRiskRule[] = [
  {
    name: '单笔限额',
    condition: (_, amount) => amount > 10000,
    action: 'review',
  },
  {
    name: '单日累计限额',
    condition: async (userId, amount) => {
      const todayTotal = await getTodayRechargeTotal(userId);
      return todayTotal + amount > 50000;
    },
    action: 'review',
  },
  {
    name: '频繁充值',
    condition: async (userId) => {
      const recentCount = await getRecentRechargeCount(userId, 3600000); // 1小时
      return recentCount > 5;
    },
    action: 'block',
  },
];
```

### 5.7 Record Service（对战记录服务）

**职责：** 保存对战过程、提供30天内查询

**存储策略：**
- MongoDB（灵活schema，适合对战记录）
- TTL索引：30天自动过期

**【存储边界说明】**
MongoDB 仅用于对战记录的离线归档与历史查询。游戏实时状态（GameState）始终存储在 Redis，不经过 MongoDB。两者职责严格分离，避免将归档存储误认为权威数据源。故障恢复时不得从 MongoDB 回写 Redis，仅可用于事后追溯。

**数据结构：**
```json
{
  "matchId": "uuid",
  "gameType": "doudizhu",
  "baseScore": 100,
  "players": [
    {
      "userId": "xxx",
      "isRobot": false,
      "seat": 0,
      "result": "win",
      "scoreBefore": 10000,
      "scoreAfter": 10300,
      "scoreChange": 300
    }
  ],
  "actions": [
    {"timestamp": 1725084100, "playerId": "xxx", "action": "play_card", "cards": [1,2,3]},
    {"timestamp": 1725084105, "playerId": "yyy", "action": "pass"}
  ],
  "duration": 360,
  "totalPot": 600,
  "createdAt": "2026-08-31T10:00:00Z"
}
```

#### 5.7.1 Record Service 事件消费实现

```typescript
@Injectable()
export class RecordService {
  constructor(
    private readonly mongoService: MongoService,
    private readonly metricsService: MetricsService,
  ) {}

  async saveMatchRecord(event: GameFinishedEvent['data']): Promise<void> {
    const record: MatchRecord = {
      matchId: event.matchId,
      gameType: event.gameType,
      baseScore: event.baseScore,
      players: event.players.map(p => ({
        userId: p.userId,
        isRobot: p.isRobot,
        seat: p.seat,
        result: p.result,
        scoreBefore: p.scoreBefore,
        scoreAfter: p.scoreAfter,
        scoreChange: p.scoreChange,
      })),
      duration: event.duration,
      totalPot: event.players.reduce((sum, p) => sum + p.scoreChange, 0),
      createdAt: new Date(),
      // TTL 索引由 MongoDB 自动处理（30天过期）
    };

    await this.mongoService.getCollection('match_records').insertOne(record);

    // 同时追加到 game_events Stream（实时可查，不设置 TTL）
    await this.mongoService.getCollection('game_events').insertOne({
      ...record,
      eventType: 'game_finished',
      archivedAt: new Date(),
    });
  }
}
```

**MongoDB 集合索引设计：**
```javascript
// match_records 集合
db.match_records.createIndex({ createdAt: -1 }, { expireAfterSeconds: 2592000 }); // 30天TTL
db.match_records.createIndex({ matchId: 1 }, { unique: true });
db.match_records.createIndex({ userId: 1, createdAt: -1 });

// game_events 集合（实时追加，不设置TTL，由定期归档任务清理）
db.game_events.createIndex({ roomId: 1, timestamp: -1 });
db.game_events.createIndex({ createdAt: -1 });
```

### 5.8 Robot System（机器人系统）

**职责：** AI机器人管理、智能填充房间、模拟真人行为

**详见第六章。**

### 5.9 Dashboard Service（看板服务）

**职责：** 实时监控、日志检索、数据统计、告警管理

**详见第八章。**

### 5.10 Audit Service（对账审计服务）⭐ 关键

**职责：** 每日自动对账、资金差异检测、审计日志记录

**核心设计：**
```typescript
@Injectable()
export class AuditService {
  // 每日对账任务
  async dailyReconciliation(date: Date): Promise<AuditReport> {
    const mysql = this.mysqlService.getConnection();
    const redis = this.redisService.getConnection();

    // 1. 从MySQL流水计算每个用户的累计余额
    const mysqlBalances = await this.calculateBalanceFromFlows(date);

    // 2. 从Redis读取当前余额
    const redisBalances = await this.readRedisBalances();

    // 3. 对比并生成差异报告
    const discrepancies = this.compareBalances(mysqlBalances, redisBalances);

    // 4. 记录审计日志
    await this.logAuditReport({ date, discrepancies, totalTransactions });

    // 5. 差异超过阈值则告警
    if (this.hasCriticalDiscrepancy(discrepancies)) {
      await this.alertService.sendAlert('对账差异告警', {
        date,
        discrepancies: discrepancies.filter(d => Math.abs(d.difference) > 1),
      });
    }

    return { date, discrepancies, status: 'completed' };
  }

  // 从MySQL流水计算余额
  private async calculateBalanceFromFlows(date: Date): Promise<Map<string, number>> {
    const flows = await this.mysql.query(`
      SELECT user_id,
             SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS total_income,
             SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS total_expense,
             SUM(amount) AS net_balance
      FROM currency_flows
      WHERE created_at < ?
      GROUP BY user_id
    `, [date.toISOString()]);

    const balanceMap = new Map<string, number>();
    for (const flow of flows) {
      balanceMap.set(flow.user_id, flow.net_balance);
    }

    // 3. 合并注册赠送等初始余额（MySQL users 表中 register_bonus 字段）
    const bonuses = await this.mysql.query(
      `SELECT id, register_bonus FROM users WHERE register_bonus > 0`
    );
    for (const bonus of bonuses) {
      const current = balanceMap.get(bonus.id) || 0;
      balanceMap.set(bonus.id, current + bonus.register_bonus);
    }
    return balanceMap;
  }

  // 从Redis读取当前余额
  private async readRedisBalances(): Promise<Map<string, number>> {
    const redis = this.redisService.getConnection();
    const keys = await redis.keys('currency:*');
    const balanceMap = new Map<string, number>();

    for (const key of keys) {
      const userId = key.replace('currency:', '');
      const balance = Number(await redis.get(key)) || 0;
      balanceMap.set(userId, balance);
    }
    return balanceMap;
  }
}

interface AuditReport {
  date: Date;
  totalTransactions: number;
  totalDiscrepancy: number;
  discrepancies: Array<{
    userId: string;
    redisBalance: number;           // Redis 当前余额（分）
    mysqlBalance: number;           // MySQL 累计流水净余额（分）
    registerBonus: number;          // 注册赠送金（分）
    expectedBalance: number;        // mysqlBalance + registerBonus
    difference: number;             // redisBalance - expectedBalance
  }>;
  status: 'matched' | 'mismatch';
  generatedAt: Date;
}
```

**对账策略：**
- 每日凌晨2点自动执行对账
- 差异计算单位：分（integer cents），与 Redis 存储单位一致
- 允许误差：≤ 1 分（浮点计算累积误差）
- 告警阈值：≥ 100 分（1 元）发送告警，≥ 10000 分（100 元）紧急告警
- 对账报告保留1年

### 5.11 GameConfig Service（游戏配置服务）

**职责：** 游戏参数管理、规则配置、机器人难度分布、配置热更新

**配置数据结构：**
```typescript
interface GameConfig {
  gameType: string;               // 游戏类型
  baseScore: number;              // 底分（可配置）
  maxPlayers: number;             // 最大人数
  minPlayers: number;             // 最小人数
  rules: Record<string, any>;     // 玩法规则（如血流成河的血量规则）
  robotSkillDistribution: {       // 机器人难度分布
    beginner: number;
    intermediate: number;
    advanced: number;
  };
  tableLimits: {                  // 桌费限制
    min: number;
    max: number;
    steps: number[];
  };
  updatedAt: Date;
  updatedBy: string;
  version: number;                // 配置版本号
}
```

**配置热更新机制：**
```typescript
class GameConfigService {
  // 缓存配置（Redis，TTL 5分钟）
  async getConfig(gameType: string): Promise<GameConfig> {
    const cacheKey = `game_config:${gameType}`;
    let config = await this.redis.get(cacheKey);

    if (!config) {
      config = await this.mysql.query(
        'SELECT * FROM game_configs WHERE game_type = ?', [gameType]
      );
      await this.redis.setex(cacheKey, 300, JSON.stringify(config));
    }
    return JSON.parse(config);
  }

  // 管理员更新配置（触发热更新）
  async updateConfig(gameType: string, updates: Partial<GameConfig>, adminId: string): Promise<void> {
    // 1. 验证配置
    await this.validateConfig(updates);

    // 2. 更新数据库
    await this.mysql.query(`
      UPDATE game_configs SET config = ?, version = version + 1, updated_by = ?
      WHERE game_type = ?
    `, [JSON.stringify(updates), adminId, gameType]);

    // 3. 清除缓存（强制下次读取重新加载）
    await this.redis.del(`game_config:${gameType}`);

    // 4. 广播配置变更通知（通知游戏服重新加载）
    await this.messageBus.publish('config.updated', { gameType, version: newVersion });

    // 5. 游戏服务监听消息，热加载新配置
  }
}
```

**配置表：**
```sql
CREATE TABLE game_configs (
  id VARCHAR(36) PRIMARY KEY,
  game_type VARCHAR(50) UNIQUE NOT NULL,
  config JSON NOT NULL,
  version INT DEFAULT 1,
  updated_by VARCHAR(36),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 5.12 Admin Service（管理后台服务）

#### 5.12.1 服务职责

Admin Service 是面向平台运营人员和管理员的独立后端服务，与游戏服务完全隔离。

| 职责域 | 说明 |
|--------|------|
| 管理员认证 | 独立于用户 JWT 的管理员认证体系（Admin JWT） |
| 管理员 CRUD | 管理员账号的创建、修改、停用、查询 |
| 用户管理 | 用户信息查询、封禁/解封、申诉处理 |
| 充值管理 | 手动充值（运营充值）、充值记录查询 |
| 提现审核 | 提现申请审核（通过/拒绝）、审核记录 |
| 对账报告 | 每日对账报告查询、差异明细导出 |
| 配置管理 | 游戏配置热更新、配置变更审计 |
| 审计日志 | 管理员操作全量记录，不可篡改 |
| 数据看板 | 实时业务数据统计、趋势分析 |

**隔离原则：** Admin Service 使用独立的 JWT secret，不与用户 JWT 混用；数据库连接与 Game Service 隔离（只读权限）；操作日志通过独立通道写入。

#### 5.12.2 API 端点清单

**认证接口：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/admin/auth/login` | 管理员登录 | 无 |
| POST | `/api/admin/auth/logout` | 管理员登出 | 所有管理员 |
| POST | `/api/admin/auth/refresh` | 刷新 Token | 所有管理员 |
| GET | `/api/admin/auth/me` | 获取当前管理员信息 | 所有管理员 |

**管理员管理：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/admin/users` | 创建管理员账号 | `super_admin` |
| GET | `/api/admin/users` | 查询管理员列表 | `super_admin` |
| PUT | `/api/admin/users/:id` | 修改管理员信息 | `super_admin` |
| PATCH | `/api/admin/users/:id/status` | 停用/启用管理员 | `super_admin` |

**用户管理：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/admin/users/player/:id` | 查询玩家详情 | `operator`, `super_admin` |
| POST | `/api/admin/users/player/ban` | 封禁玩家 | `operator`, `super_admin` |
| POST | `/api/admin/users/player/unban` | 解封玩家 | `operator`, `super_admin` |
| GET | `/api/admin/users/player/:id/flows` | 玩家货币流水 | `finance`, `super_admin` |
| POST | `/api/admin/users/player/:id/recharge` | 手动充值 | `finance`, `super_admin` |

**充值/提现/对账：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/admin/recharge/manual` | 管理员手动充值 | `finance`, `super_admin` |
| GET | `/api/admin/withdraw/pending` | 待审核提现列表 | `finance`, `super_admin` |
| POST | `/api/admin/withdraw/:id/approve` | 批准提现 | `finance`, `super_admin` |
| POST | `/api/admin/withdraw/:id/reject` | 拒绝提现 | `finance`, `super_admin` |
| GET | `/api/admin/reconciliation/daily` | 每日对账报告列表 | `finance`, `super_admin` |
| POST | `/api/admin/reconciliation/daily/:date/export` | 导出对账报告（CSV） | `super_admin` |

**配置/审计/看板：**

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/admin/config/:gameType` | 查询游戏配置 | `operator`, `super_admin` |
| PUT | `/api/admin/config/:gameType` | 更新游戏配置 | `super_admin` |
| GET | `/api/admin/audit/logs` | 查询审计日志 | `super_admin` |
| GET | `/api/admin/dashboard/overview` | 实时概览 | 所有管理员 |
| GET | `/api/admin/dashboard/finance` | 财务数据看板 | `finance`, `super_admin` |
| GET | `/api/admin/dashboard/operations` | 运营数据看板 | `operator`, `super_admin` |

#### 5.12.3 管理员 JWT 认证流程

管理员 JWT 与用户 JWT 完全独立：

```typescript
interface AdminJwtPayload {
  sub: string;           // adminId
  role: AdminRole;
  username: string;
  jti: string;           // Token ID（用于吊销）
  iat: number;
  exp: number;
  sessionId: string;     // 会话 ID（用于多设备管理）
}
```

- Access Token 有效期：2h（短期，降低泄露风险）
- Refresh Token 有效期：7d
- 签发方：`admin-service`（与用户 JWT 区分）

**登录流程：** 验证用户名密码 → 检查账号状态 → 生成 Redis Session → 签发 Admin JWT + Refresh Token → 记录登录日志。

**Token 吊销：** `/logout` 时删除 Redis Session + 将 JTI 加入吊销列表（TTL = Access Token 剩余有效期）。

#### 5.12.4 RBAC 权限模型

```typescript
enum AdminRole {
  SUPER_ADMIN = 'super_admin',  // 所有权限，可管理管理员
  FINANCE = 'finance',          // 仅财务操作
  OPERATOR = 'operator',        // 仅运营操作
  VIEWER = 'viewer',            // 只读权限（看板查看）
}

const ADMIN_ROLE_PERMISSIONS: Record<AdminRole, string[]> = {
  super_admin: ['admin.*', 'user.*', 'recharge.*', 'withdraw.*',
    'reconciliation.*', 'config.*', 'audit.view', 'dashboard.*'],
  finance: ['user.player.view', 'user.player.flow.view', 'user.player.recharge',
    'recharge.*', 'withdraw.pending.view', 'withdraw.approve', 'withdraw.reject',
    'withdraw.history.view', 'reconciliation.*', 'dashboard.finance'],
  operator: ['user.player.view', 'user.player.ban', 'user.player.unban',
    'config.view', 'dashboard.operations', 'dashboard.overview'],
  viewer: ['dashboard.overview', 'dashboard.finance', 'dashboard.operations', 'config.view'],
};
```

权限校验装饰器：

```typescript
// 使用示例
@Post('player/ban')
@RequirePermissions('user.player.ban')
async banPlayer(@Body() dto: BanPlayerDto) {
  return await this.adminService.banPlayer(dto);
}

// 权限校验守卫
@Injectable()
export class AdminAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.get<string[]>('permissions', context.getHandler());
    if (!requiredPermissions) return true;
    const { user } = context.switchToHttp().getRequest();
    const adminPermissions = ADMIN_ROLE_PERMISSIONS[user.role];
    const hasPermission = requiredPermissions.every(
      perm => adminPermissions.includes(perm) || adminPermissions.includes('*')
    );
    if (!hasPermission) throw new ForbiddenError('权限不足');
    return true;
  }
}
```

#### 5.12.5 安全审计日志

**必须记录的操作：** 登录/登出、密码修改、封禁/解封、手动充值、提现批准/拒绝、配置变更、报告导出、审计日志查询。

**不记录的内容：** 密码明文、完整银行卡号（脱敏后存储）、JWT Token 内容。

**存储策略：** MySQL 主存储（永久保留）+ Elasticsearch 检索（90天自动过期）。

#### 5.12.6 Redis Session 管理

```
key: admin_session:{sessionId}         → Hash（字段：adminId, username, role, ipAddress, lastActiveAt）
key: admin_jwt_revoked:{jti}           → String "1"，TTL 7200s
key: admin_login_fail:{ipAddress}      → String count，TTL 900s（防暴力破解）
```

Session 滑动窗口：每次 API 请求更新 `lastActiveAt`，超过 1 小时才刷新；TTL 从 `lastActiveAt` 起算，最长 8 天。

#### 5.12.7 数据库表设计

```sql
-- 管理员账号表
CREATE TABLE admin_users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  real_name VARCHAR(50),
  email VARCHAR(100),
  role ENUM('super_admin', 'finance', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  status ENUM('active', 'banned', 'pending') NOT NULL DEFAULT 'pending',
  last_login_at TIMESTAMP NULL,
  last_login_ip VARCHAR(45),
  login_fail_count INT DEFAULT 0,
  must_change_password TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_username (username),
  INDEX idx_role (role),
  INDEX idx_status (status)
);

-- 管理员操作审计日志表
CREATE TABLE admin_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  log_id VARCHAR(36) UNIQUE NOT NULL,
  admin_id VARCHAR(36) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(36),
  details JSON,
  ip_address VARCHAR(45),
  user_agent VARCHAR(255),
  session_id VARCHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_action (admin_id, action),
  INDEX idx_admin_time (admin_id, created_at),
  INDEX idx_target (target_type, target_id),
  INDEX idx_created_at (created_at)
);

-- 管理员登录日志表（独立存储，便于安全分析）
CREATE TABLE admin_login_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(36) NOT NULL,
  action ENUM('login_success', 'login_fail', 'logout', 'token_refresh') NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  user_agent VARCHAR(255),
  fail_reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_time (admin_id, created_at),
  INDEX idx_ip_time (ip_address, created_at)
);
```

**初始管理员种子数据：**

```sql
INSERT INTO admin_users (id, username, password_hash, real_name, role, status, must_change_password)
VALUES (
  'admin-root-0000-0000-000000000000',
  'root',
  '$2b$12$XJwQ7z9K1vF3hL8mN5pO6eR7tY2uI1oP3aS4dF5gH6jK8lZ9xC0b',
  '系统管理员',
  'super_admin',
  'active',
  1
);
-- 注意：首次登录后强制改密
```

#### 5.12.8 提现审核流程

```
待审核提现列表（分页）
       │
       ▼
管理员点击某笔提现申请 → 查看详情（用户信息、金额、手续费、银行账户、申请时间）
       │
       ├── 批准 ──────────────────► 拒绝
       │        │                        │
       │        ▼                        ▼
       │  调用 Currency Service    记录拒绝原因
       │  confirmWithdraw()        更新状态为 rejected
       │        │                        │
       │        ▼                        │
       │  执行打款（调用支付渠道）          │
       │        │                        │
       │        ▼                        │
       │  更新状态为 completed            │
       │        │                        │
       │        ▼                        │
       │  记录审计日志                   │
       │        │                        │
       │        ▼                        ▼
       │  返回审核结果 ◄─────────────────┘
```

#### 5.12.9 NestJS 模块结构

```
apps/admin-service/
├── src/
│   ├── auth/              (admin-jwt.strategy, admin-jwt.guard, permissions.decorator)
│   ├── user/              (玩家查询、封禁/解封)
│   ├── recharge/          (手动充值)
│   ├── withdraw/          (提现审核)
│   ├── reconciliation/    (对账报告)
│   ├── config/            (游戏配置管理)
│   ├── audit/             (审计日志)
│   ├── dashboard/         (数据看板)
│   ├── session/           (Session 管理)
│   ├── app.module.ts
│   └── main.ts
└── Dockerfile
```

#### 5.12.10 模块依赖关系

```
Admin Service
  ├── UsersModule（外部）──► User Service（RPC）
  ├── CurrencyModule（外部）──► Currency Service（RPC）
  ├── AuditModule（外部）──► Audit Service（Event）
  ├── MetricsModule（外部）──► Dashboard Service（RPC）
  ├── 内部依赖：
  │     ├── AuthService（JWT + Session）
  │     ├── AuditLogService（审计日志写入）
  │     └── RedisService（Session 存储）
  └── 基础设施：
        ├── MySQL（admin_users, admin_audit_logs, admin_login_logs）
        ├── Redis（Session, Token 吊销, 登录失败计数）
        └── Elasticsearch（审计日志检索）
```

---

## 六、机器人系统详细设计

### 6.1 架构

```
┌─────────────────────────────────────────────────────┐
│              Robot System                           │
│                                                     │
│  ┌──────────────┐  ┌──────────────────────────┐    │
│  │ Robot Pool   │  │       AI Engine           │    │
│  │  (机器人池)   │  │                          │    │
│  │              │  │  ┌────────────────────┐  │    │
│  │  - 可用机器人  │  │  │  DoudizhuAI       │  │    │
│  │  - 忙碌机器人  │  │  │  (斗地主AI)        │  │    │
│  │  - 离线机器人  │  │  ├────────────────────┤  │    │
│  └──────────────┘  │  │  │  MahjongAI       │  │    │
│                    │  │  │  (麻将AI)         │  │    │
│  ┌──────────────┐  │  └────────────────────┘  │    │
│  │ Room Filler  │  │                          │    │
│  │ (自动填充)    │  │  ┌────────────────────┐  │    │
│  │              │  │  │  ThinkingDelay      │  │    │
│  │  - 空闲检测   │  │  │  (思考延迟模拟)      │  │    │
│  │  - 自动加入   │  │  └────────────────────┘  │    │
│  │  - 离开清理   │  │                          │    │
│  └──────────────┘  └──────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### 6.2 机器人实例

```typescript
interface RobotInstance {
  robotId: string;
  gameType: 'doudizhu' | 'mahjong_xl' | 'mahjong_cm' | 'poker';
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  personality: PersonalityTraits;
  currentRoomId: string | null;
  lastGameAt: Date;
  idleTime: number;
  gamesPlayed: number;
  winRate: number;
  virtualAccountId: string;   // 虚拟账户 ID（隔离于真实用户）
  balance: number;            // 机器人余额（分，整数）
  maxBalance: number;         // 余额上限（防止无限膨胀）
  replenishThreshold: number; // 低于此余额时 replenish
}

interface PersonalityTraits {
  aggression: number;       // 攻击性 0-1
  conservatism: number;     // 保守程度 0-1
  riskTaking: number;       // 冒险倾向 0-1
  bluffFrequency: number;   // bluff频率 0-1
  thinkingSpeed: number;    // 思考速度 (ms)
  errorRate: number;        // 犯错概率 0-1
  patience: number;         // 耐心程度 0-1
  mood: 'calm' | 'aggressive' | 'conservative';  // 当前情绪
}
```

### 6.3 AI策略

**斗地主AI：**
```typescript
class DoudizhuAI {
  constructor(private skillLevel: 'beginner' | 'intermediate' | 'advanced') {}
  
  async chooseCard(state: GameState, hand: Card[]): Promise<PlayAction> {
    // 1. 评估当前局势
    const situation = this.evaluateSituation(state, hand);
    
    // 2. 根据技能等级选择策略
    const strategy = this.getStrategy(situation);
    
    // 3. 生成候选出牌
    const candidates = this.generateCandidates(strategy, hand);
    
    // 4. 根据性格和错误率选择
    return this.pickWithPersonality(candidates, state);
  }
  
  private evaluateSituation(state: GameState, hand: Card[]): Situation {
    return {
      isLandlord: state.isLandlord,
      opponentCardCount: state.opponents.map(p => p.cardCount),
      lastPlay: state.lastPlay,
      handStrength: this.calculateHandStrength(hand),
      needToBeat: state.needsBeat,
    };
  }
  
  private getStrategy(situation: Situation): Strategy {
    switch (this.skillLevel) {
      case 'beginner':
        return {
          priority: ['survive', 'pass', 'win'],
          aggression: 0.3,
          errorRate: 0.15,
        };
      case 'intermediate':
        return {
          priority: ['win', 'survive', 'pass'],
          aggression: 0.6,
          errorRate: 0.05,
        };
      case 'advanced':
        return {
          priority: ['win', 'count_cards', 'bluff', 'pass'],
          aggression: 0.8,
          errorRate: 0.01,
        };
    }
  }
}
```

**思考延迟模拟：**
```typescript
class ThinkingDelay {
  calculateDelay(personality: PersonalityTraits, action: Action): number {
    // 基础延迟
    let base = personality.thinkingSpeed;
    
    // 复杂操作思考更久
    if (action.type === 'special_move') base += 500;
    if (action.type === 'bluff') base += 300;
    
    // 添加随机波动（模拟人类犹豫）
    const jitter = random(0, 500);
    
    // 低级机器人偶尔"发呆"
    if (personality.errorRate > 0.1 && Math.random() < personality.errorRate) {
      base += random(1000, 3000);  // 模拟走神
    }
    
    return base + jitter;
  }
}
```

### 6.4 自动填充逻辑

```typescript
class RoomFiller {
  private fillInterval: NodeJS.Timer;
  
  async startMonitoring(): Promise<void> {
    this.fillInterval = setInterval(async () => {
      await this.checkAndFill();
    }, 5000); // 每5秒检查一次
  }
  
  private async checkAndFill(): Promise<void> {
    const emptyRooms = await this.getEmptyRooms();
    
    for (const room of emptyRooms) {
      const needed = room.maxPlayers - room.players.length;
      
      for (let i = 0; i < needed; i++) {
        const robot = await this.robotPool.getAvailableRobot(room.gameType);
        if (robot) {
          await this.joinRoom(robot, room);
          this.notifyRoomState(room);
        }
      }
    }
  }
  
  private async joinRoom(robot: RobotInstance, room: Room): Promise<void> {
    // 通过正常JOIN接口加入（让机器人看起来像真实玩家）
    await this.roomService.joinRoom({
      userId: robot.robotId,
      roomId: room.roomId,
      isRobot: true,
    });
    
    // 通知客户端有新玩家加入
    this.broadcastRoomState(room);
  }
}
```

### 6.5 关键设计点

| 特性 | 实现方式 |
|------|----------|
| **不可区分性** | 机器人走人类玩家接口，前端无感知 |
| **难度分级** | beginner/intermediate/advanced |
| **行为多样化** | 每个机器人有独立性格参数 |
| **延迟模拟** | 随机思考时间，避免立即出牌 |
| **错误模拟** | 低级机器人有一定概率犯错 |
| **自动填充** | 空闲房间自动填充机器人 |
| **离房清理** | 机器人离开后清理状态 |

### 6.6 AI算法路线

**斗地主AI升级路线：**
```
Phase 1: 规则引擎（当前设计）
  - 基于规则的决策树
  - 手牌强度评估
  - 出牌合法性验证

Phase 2: 蒙特卡洛树搜索（MCTS）
  - 模拟未来N步出牌结果
  - 选择期望收益最大的出牌
  - 计算复杂度：O(N × B) where B=分支因子

Phase 3: 深度学习（可选）
  - 使用AlphaZero-like架构
  - 策略网络 + 价值网络
  - 需要大量对战数据训练
```

**麻将AI算法设计：**
```typescript
// 麻将核心算法
class MahjongAI {
  // 向听数计算（Shanten Number）- 判断牌型距离胡牌还有几步
  calculateShanten(hand: Tile[]): number {
    // 返回 0 = 听牌, 1 = 一向听, 2 = 两向听...
    // 使用递归算法计算最小向听数
  }

  // 危险牌判定 - 根据对手出牌推断安全牌
  calculateSafetyScore(tile: Tile, opponentHistory: Move[]): number {
    // 牌效 + 安全度综合评分
    // 返回 0-1 的安全系数
  }

  // 读牌能力 - 根据对手出牌推断手牌范围
  inferOpponentHand(opponentMoves: Move[]): HandRange {
    // 返回对手可能的手牌范围
    // 用于防守决策
  }

  // 综合决策
  async chooseAction(state: GameState): Promise<MahjongAction> {
    // 1. 计算向听数（进攻方向）
    const shanten = this.calculateShanten(state.myHand);

    // 2. 计算牌效（最优进张）
    const efficiency = this.calculateEfficiency(state.myHand);

    // 3. 计算安全度（防守需求）
    const safety = this.calculateSafety(state);

    // 4. 综合评分选择最优动作
    return this.scoreAndSelect({ shanten, efficiency, safety }, state);
  }
}
```

### 6.7 虚拟经济隔离

**【账户隔离】**
- 机器人使用独立的 virtual_account_{robotId} 前缀存储余额
- 不与真实用户货币表（currency_flows）混用
- 机器人余额不可提现、不可转账给真实用户

**【余额管理策略】**
- 初始余额：10000 分（100 元）
- 下限 replenish：余额 < 1000 分时自动补充至 5000 分
- 上限控制：余额 > 50000 分时停止参与游戏
- 补充来源：定时任务从虚拟资金池划拨（与管理后台独立）

**【对战记录】**
- 机器人参与的对战记录标记 isRobot: true
- 统计时排除机器人数据（不参与真人排行榜）
- 保留 30 天用于 AI 训练数据分析

---

## 七、游戏状态持久化与故障恢复方案

### 7.1 问题定义

当前设计的问题：
- GameState 只存 Redis，Redis 故障 → 所有进行中的游戏丢失
- Game Service 重启 → 需要知道如何从 Redis 恢复游戏
- Redis Cluster 故障转移期间 → 客户端超时如何处理

### 7.2 方案设计

**核心思路：Redis 为主存储 + 本地内存快照 + 事件日志三重重保**

```
┌──────────────────────────────────────────────────────┐
│                  Game Service 进程                    │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │         内存游戏会话表 (Memory)               │      │
│  │  roomId → GameState + 操作事件日志           │      │
│  └─────────────┬──────────────────────────────┘      │
│                │                                      │
│    ┌───────────┼───────────┐                         │
│    ▼           ▼           ▼                         │
│ ┌──────┐  ┌──────────┐  ┌──────────────┐            │
│ │Redis │  │本地快照   │  │ 事件日志      │            │
│ │主存储 │  │(防丢失)  │  │(可回放)      │            │
│ └──────┘  └──────────┘  └──────────────┘            │
└──────────────────────────────────────────────────────┘
```

### 7.3 数据持久化策略

```typescript
// Redis 数据结构（已有设计）
// key: room:{roomId}  →  GameState JSON
// key: game_events:{roomId}  →  Stream（事件日志）

// 新增：本地内存快照
class GameSessionManager {
  private sessions = new Map<string, GameSession>();

  // 启动时从 Redis 加载所有进行中的游戏
  async loadActiveGames() {
    const roomKeys = await this.redis.keys('room:*');
    for (const key of roomKeys) {
      const roomData = await this.redis.get(key);
      if (roomData.status === 'playing') {
        this.sessions.set(roomData.roomId, new GameSession(roomData));
      }
    }
  }

  // 定期快照到本地文件（用于灾难恢复）
  private snapshotTimer = setInterval(() => {
    this.saveSnapshot();
  }, 60000); // 每分钟

  private saveSnapshot() {
    const snapshot = Array.from(this.sessions.entries()).map(([id, session]) => ({
      roomId: id,
      gameState: session.state,
      eventLog: session.eventLog,
      lastUpdatedAt: Date.now(),
    }));
    fs.writeFileSync('/data/snapshots/latest.json', JSON.stringify(snapshot));
  }
}
```

### 7.4 故障恢复流程

#### 场景 1：Game Service 实例崩溃

```
1. Kubernetes 检测到 Pod 崩溃，自动重启新实例
2. 新实例启动时调用 loadActiveGames()
3. 从 Redis 加载所有进行中的游戏状态
4. 客户端重连 → 发送 reconnect + seq
5. 服务端验证 seq → 返回最新 gameState
6. 游戏继续（玩家无感知）
```

#### 场景 2：Redis 故障（RDB/AOF 损坏）

```
1. Game Service 检测到 Redis 不可用
2. 暂停接受新的游戏开始请求
3. 从本地快照恢复进行中的游戏
4. 向所有在线玩家广播 "系统维护中" 消息
5. Redis 恢复后，从快照合并增量事件
6. 通知玩家恢复游戏

【数据权威性原则】
- Redis 是权威数据源（正常情况）
- 本地快照是灾难恢复手段（异常情况下）
- Redis 恢复后，用快照中的事件日志与 Redis 中的增量事件做合并，
  以 Redis 中较新的数据为准
```

#### 场景 3：Redis Cluster 故障转移

```
1. 主从切换期间，部分请求可能超时
2. Game Service 捕获超时异常 → 不返回错误
3. 自动重试（最多 3 次，间隔 100ms）
4. 如果全部重试失败 → 记录到事件日志，稍后补偿
5. 客户端收到连接断开 → 触发重连机制
```

### 7.5 事件溯源（Event Sourcing）

```typescript
// 所有游戏操作以事件形式存储
interface GameEvent {
  eventId: string;
  roomId: string;
  seq: number;
  type: 'action' | 'start' | 'finish';
  timestamp: Date;
  data: any;
}

// 事件存储策略
class EventStore {
  // Redis Stream（实时查询）
  async appendEvent(event: GameEvent) {
    await this.redis.xadd('game_events:' + event.roomId, '*',
      'event_id', event.eventId,
      'seq', String(event.seq),
      'type', event.type,
      'data', JSON.stringify(event.data),
      'timestamp', String(event.timestamp.getTime())
    );
  }

  // MongoDB（长期归档，30天自动过期）
  // 【重要】MongoDB 中存储的仅为归档副本，游戏状态以 Redis 为准。
  // 故障恢复时不得从 MongoDB 回写 Redis，仅可用于事后追溯。
  async archiveEvent(event: GameEvent) {
    await this.mongo.collection('game_events').insertOne({
      ...event,
      ttl: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
  }
}
```

---

## 八、监控与看板系统

### 8.1 日志体系

**三层日志架构：**

```
┌─────────────────────────────────────────────────────────────┐
│                      日志采集层                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  业务日志     │  │  流水日志     │  │  玩法日志     │      │
│  │  (INFO/WARN) │  │  (交易记录)   │  │  (对局记录)   │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┴─────────────────┘               │
│                           ▼                                 │
│              ┌──────────────────────┐                       │
│              │   Log Aggregator      │                       │
│              │   (Fluentd/Filebeat)  │                       │
│              └──────────┬───────────┘                       │
│                         ▼                                   │
│              ┌──────────────────────┐                       │
│              │   Elasticsearch      │                       │
│              │   (日志存储与检索)     │                       │
│              └──────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

**业务日志：**
```typescript
@Injectable()
export class GameService {
  constructor(private readonly logger = new Logger(GameService.name)) {}
  
  async playAction(playerId: string, action: GameAction) {
    this.logger.log(`Player ${playerId} plays action: ${action.type}`);
    this.logger.debug(`Action details: ${JSON.stringify(action)}`);
    
    try {
      const result = await this.executeAction(playerId, action);
      this.logger.log(`Action succeeded`);
      return result;
    } catch (error) {
      this.logger.error(`Action failed: ${error.message}`, error.stack);
      throw error;
    }
  }
}
```

**流水日志：**
```typescript
interface TransactionLog {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceId: string;
  metadata: Record<string, any>;
  createdAt: Date;
}

enum TransactionType {
  RECHARGE = 'recharge',
  BET = 'bet',
  WIN = 'win',
  LOSE = 'lose',
  WITHDRAW = 'withdraw',
  ADMIN_ADD = 'admin_add',
  ADMIN_SUBTRACT = 'admin_subtract',
  FEE = 'fee',
  REFUND = 'refund',
}
```

**玩法日志：**
```typescript
interface GamePlayLog {
  matchId: string;
  gameType: string;
  players: Array<{
    userId: string;
    isRobot: boolean;
    seat: number;
    result: 'win' | 'lose' | 'draw';
    scoreBefore: number;
    scoreAfter: number;
    scoreChange: number;
  }>;
  actions: Array<{
    timestamp: number;
    playerId: string;
    actionType: string;
    actionData: any;
  }>;
  duration: number;
  baseScore: number;
  totalPot: number;
  finishedAt: Date;
}
```

### 8.2 指标采集（Prometheus）

```typescript
import { Registry, Histogram, Counter, Gauge } from 'prom-client';

export class GameMetrics {
  private readonly registry = new Registry();
  
  // 计数器
  readonly totalGames = new Counter({
    name: 'game_total_games',
    help: 'Total number of games played',
    labelNames: ['gameType'],
    registry: this.registry,
  });
  
  readonly totalActions = new Counter({
    name: 'game_total_actions',
    help: 'Total number of player actions',
    labelNames: ['gameType', 'actionType'],
    registry: this.registry,
  });
  
  readonly errorTotal = new Counter({
    name: 'game_error_total',
    help: 'Total number of errors',
    labelNames: ['service', 'errorType'],
    registry: this.registry,
  });
  
  // 直方图
  readonly gameDuration = new Histogram({
    name: 'game_duration_seconds',
    help: 'Game duration in seconds',
    labelNames: ['gameType'],
    buckets: [30, 60, 120, 300, 600, 1200],
    registry: this.registry,
  });
  
  readonly requestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['service', 'method', 'path'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    registry: this.registry,
  });
  
  // 仪表盘
  readonly activeGames = new Gauge({
    name: 'game_active_games',
    help: 'Number of currently active games',
    labelNames: ['gameType'],
    registry: this.registry,
  });
  
  readonly onlinePlayers = new Gauge({
    name: 'game_online_players',
    help: 'Number of online players',
    registry: this.registry,
  });
  
  readonly wsConnections = new Gauge({
    name: 'ws_active_connections',
    help: 'Number of active WebSocket connections',
    registry: this.registry,
  });
}
```

### 8.3 告警规则

```yaml
# Prometheus alerting rules
groups:
  - name: game_alerts
    rules:
      - alert: GameErrorRateHigh
        expr: rate(game_error_total[5m]) / rate(game_total_actions[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "游戏错误率超过5%"
          description: "服务 {{ $labels.service }} 的错误率在过去5分钟内超过5%"
          
      - alert: OnlinePlayersDrop
        expr: game_online_players < 100
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "在线玩家数低于100"
          
      - alert: GameResponseTimeHigh
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "95%分位响应时间超过1秒"
          
      - alert: CurrencyAnomaly
        expr: rate(currency_abnormal_change_total[1h]) > 10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "检测到异常货币变动"
          
      - alert: ServiceDown
        expr: up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "服务 {{ $labels.instance }} 已下线"
```

### 8.4 告警通知

```
Prometheus ──► Alertmanager ──► 企业微信群
                  │              ├──► 飞书
                  │              ├──► 邮件
                  └──────────────└──► 钉钉
```

### 8.5 看板服务功能

**1. 实时概览**
- 在线玩家数、活跃对局数、每分钟对局数
- 今日充值/提现/投注总额
- 各服务健康状态

**2. 服务监控面板**
- CPU/内存使用率
- 请求数/错误率/响应时间
- WebSocket连接数
- Redis/MySQL连接池状态

**3. 日志检索**
- 按服务名、级别、时间范围筛选
- 支持关键词搜索
- 支持按用户ID过滤

**4. 流水查询**
- 按用户/类型/时间范围查询
- 汇总统计（总额、笔数、趋势）
- 导出CSV

**5. 玩法统计**
- 各玩法对局数、时长分布
- 热门玩法排行
- 用户留存分析

---

## 九、匹配系统完整设计

### 9.1 匹配流程总览

```
玩家点击"匹配"
       │
       ▼
┌─────────────────┐
│ Room Service    │
│ 创建匹配请求     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Match Service   │ ← 多维度匹配算法
│ 写入匹配队列     │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
  找到匹配    等待超时
    │         │
    ▼         ▼
┌────────┐ ┌──────────────┐
│创建房间│ │填充机器人/    │
│通知双方│ │继续等待       │
└────────┘ └──────────────┘
```

### 9.2 匹配队列设计

```typescript
// Redis 数据结构
// key: match_queue:{gameType}:{roomType}
// 类型: Sorted Set
// member: userId
// score: ELO分数

// 额外元数据（Hash）
// key: match_meta:{userId}
// fields: gameType, roomType, elo, enteredAt, latency

interface MatchQueue {
  gameType: 'doudizhu' | 'mahjong_xl' | 'mahjong_cm';
  roomType: 'friend' | 'random' | 'points';
  elo: number;
  enteredAt: number; // 进入队列时间戳
  latency: number;   // 客户端网络延迟
}
```

### 9.3 ELO 匹配算法

```typescript
class MatchMaker {
  // ELO 分数更新公式
  private eloUpdateScore(actualScore: number, expectedScore: number, K: number = 32): number {
    return Math.round(K * (actualScore - expectedScore));
  }

  // 计算期望得分
  private expectedScore(playerElo: number, opponentElo: number): number {
    return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
  }

  // 查找匹配
  async findMatch(request: MatchRequest): Promise<string | null> {
    const queueKey = `match_queue:${request.gameType}:${request.roomType}`;
    const player = await this.getPlayerData(request.userId);

    // 多维匹配窗口
    const eloRange = this.getEloRange(player.elo, request.difficulty);
    const timeWindow = Date.now() - request.maxWaitMs;

    // 1. ELO 匹配
    const candidates = await this.redis.zrangebyscore(
      queueKey,
      player.elo - eloRange,
      player.elo + eloRange
    );

    // 2. 过滤符合条件的候选者
    const validCandidates = candidates.filter(c => {
      const meta = await this.getMatchMeta(c);
      return meta.enteredAt >= timeWindow &&
             Math.abs(meta.latency - player.latency) < 200; // 延迟差异 < 200ms
    });

    if (validCandidates.length > 0) {
      return this.createRoom(player, validCandidates[0]);
    }

    return null;
  }

  // ELO 范围自适应（等待越久，范围越大）
  private getEloRange(baseElo: number, waitTime: number): number {
    const baseRange = 100;
    const timeBonus = Math.min(Math.floor(waitTime / 10000), 150); // 最多增加 150
    return baseRange + timeBonus;
  }
}
```

### 9.4 匹配超时处理

```typescript
// 超时策略配置
interface MatchTimeoutConfig {
  maxWaitTime: number;        // 最大等待时间（ms）
  robotFillThreshold: number; // 达到此时间后填充机器人
  expandRangeInterval: number; // 每隔多久扩大匹配范围
}

// 超时处理流程
class MatchTimeoutHandler {
  async handleTimeout(userId: string, request: MatchRequest) {
    // 1. 检查是否超过最大等待时间
    if (Date.now() - request.enteredAt > request.maxWaitTime) {
      // 取消匹配，返回大厅
      this.cancelMatch(userId);
      this.notifyUser(userId, 'MATCH_TIMEOUT', '匹配超时，请稍后重试');
      return;
    }

    // 2. 如果超过机器人填充阈值，自动填充机器人
    if (Date.now() - request.enteredAt > request.robotFillThreshold) {
      await this.fillWithRobot(request.roomId);
      this.notifyUser(userId, 'BOT_FILLED', '已为你匹配机器人对手');
    }

    // 3. 定期扩大匹配范围
    const expandedRange = this.expandMatchingRange(request);
    this.updateMatchQueue(request, { eloRange: expandedRange });
  }
}
```

### 9.5 房间类型差异化匹配

| 房间类型 | 匹配规则 | ELO 范围 | 延迟限制 | 特殊处理 |
|----------|----------|----------|----------|----------|
| 好友房 | 直接加入好友房间 | 无限制 | 无限制 | 不需要匹配 |
| 随机房 | ELO + 延迟匹配 | ±100-250 | ±200ms | 超时自动填机器人 |
| 积分房 | ELO + 积分匹配 | ±50-150 | ±100ms | 积分差异也考虑 |

---

## 十、网络层安全设计

### 10.1 传输层安全
- **WSS（WebSocket Secure）：** 所有WebSocket连接使用TLS加密
- **HTTPS：** REST API全部走HTTPS
- **证书固定：** 关键操作可做证书固定

### 10.2 认证与鉴权
- **JWT Token：** 登录成功后颁发，有效期2小时
- **刷新Token：** 长期使用，安全存储
- **请求签名：** 关键操作（充值、提现）需要对请求体签名
  ```
  signature = HMAC-SHA256(secretKey, `${timestamp}${body}`)
  ```

### 10.3 防重放攻击
- **时间窗口：** 请求携带时间戳，服务器验证±5分钟内
- **Nonce：** 关键操作携带唯一Nonce，Redis记录已使用的Nonce

### 10.4 限流与防护
- **连接数限制：** 单IP最大WebSocket连接数5个
- **操作频率限制：** 每秒操作次数限制
- **DDoS防护：** 使用云服务商WAF

### 10.5 反作弊
- 所有操作在服务端验证合法性
- 异常行为检测（操作速度过快、概率异常）
- 记录日志便于事后审计

### 10.6 敏感数据脱敏
- 日志中手机号脱敏：`138****1234`
- 日志中密码字段不记录
- 日志中银行卡号脱敏：`6222****1234`
- 使用 Logback 自定义转换器实现

### 10.7 风控系统
```typescript
interface RiskRule {
  name: string;
  threshold: number;
  action: 'warn' | 'block' | 'review';
}

interface RiskScore {
  userId: string;
  score: number;
  level: 'normal' | 'suspicious' | 'blocked';
  action: 'none' | 'throttle' | 'review' | 'ban';
  evidenceId: string;
}

interface Evidence {
  userId: string;
  deviceId: string;
  ipAddress: string;
  recentActions: any[];
  deviceFingerprint: string;
  collectedAt: Date;
}

class RiskControlService {
  // 操作速度异常检测
  async checkFastAction(userId: string, actions: Action[]): Promise<boolean> {
    const window = this.getActionsInWindow(actions, 5000); // 5秒窗口
    return window.length > 20; // 5秒内超过20次操作
  }

  // 概率异常检测
  async checkProbabilityAnomaly(userId: string): Promise<boolean> {
    const stats = await this.getUserStats(userId);
    return stats.winRate > 0.8 && stats.gamesPlayed > 100;
  }

  // 设备异常检测
  async checkDeviceFraud(userId: string): Promise<boolean> {
    const deviceCount = await this.countUniqueDevices(userId);
    return deviceCount > 3; // 同一账号超过3个设备
  }

  // 综合风控评分
  async calculateRiskScore(userId: string): Promise<RiskScore> {
    const checks = await Promise.all([
      this.checkFastAction(userId, this.getRecentActions(userId)),
      this.checkProbabilityAnomaly(userId),
      this.checkDeviceFraud(userId),
      this.checkAbnormalWithdraw(userId),
    ]);

    const score = checks.filter(Boolean).length * 25;
    const riskLevel = this.getRiskLevel(score);
    return { userId, score, level: riskLevel.level, action: riskLevel.action, evidenceId: uuid() };
  }

  private async getRiskLevel(score: number): Promise<{
    level: 'normal' | 'suspicious' | 'blocked';
    action: 'none' | 'throttle' | 'review' | 'ban';
  }> {
    if (score >= 75) {
      return { level: 'blocked', action: 'ban' };
    }
    if (score >= 50) {
      return { level: 'suspicious', action: 'review' };
    }
    return { level: 'normal', action: 'none' };
  }

  // 根据风险级别执行处置
  async applyRiskAction(userId: string, riskScore: RiskScore): Promise<void> {
    switch (riskScore.action) {
      case 'throttle':
        // 限制操作频率（每秒最多 3 次）
        await this.throttleService.setLimit(userId, 3, 1000);
        break;
      case 'review':
        // 标记待审核，暂停高价值操作
        await this.auditQueue.enqueue({ userId, type: 'manual_review', reason: riskScore.score });
        break;
      case 'ban':
        // 永久封禁，通知用户
        await this.userService.banUser(userId, 'system', '风控封禁');
        await this.notifyUser(userId, 'BANNED', {
          reason: '异常行为 detected，已被永久封禁',
          appealUrl: '/api/appeal/create',
          evidenceId: riskScore.evidenceId,
        });
        break;
    }
  }

  // 证据留存
  private async collectEvidence(userId: string): Promise<Evidence> {
    return {
      userId,
      deviceId: await this.deviceService.getDeviceId(userId),
      ipAddress: await this.getRequestIP(userId),
      recentActions: await this.actionLog.getRecent(userId, 100),
      deviceFingerprint: await this.deviceService.getFingerprint(userId),
      collectedAt: new Date(),
    };
  }
}
```

**【申诉流程】**
1. 被封禁用户可通过 /api/appeal/create 提交申诉
2. 申诉包含：evidenceId、申诉理由、辅助证明（截图等）
3. 运营人员人工审核（24小时内响应）
4. 申诉通过 → 解封 + 补偿损失 + 记录误判
5. 申诉驳回 → 维持封禁 + 告知复核渠道

---

## 十一、WebSocket通信协议

### 11.1 消息格式
```typescript
interface WSMessage {
  type: string;        // 消息类型
  seq: number;         // 请求序列号
  timestamp: number;   // 客户端时间戳
  payload: any;
  signature?: string;  // 签名（关键操作）
}

interface WSResponse {
  type: string;
  seq: number;
  code: number;        // 0=成功
  message?: string;
  data?: any;
}
```

### 11.2 完整消息类型清单

**【系统消息】**
- `login` / `login_ok` / `login_fail` — 登录请求/响应
- `logout` — 登出通知
- `ping` / `pong` — 心跳
- `system.error` — 系统级错误通知
- `system.warning` — 系统维护警告

**【大厅消息】**
- `hall.refresh` — 刷新大厅列表
- `room.list` — 获取房间列表
- `room.create` — 创建房间
- `room.join` — 加入房间
- `room.joined` — 加入成功（返回 gameState）
- `room.leave` — 离开房间
- `room.kick` — 踢出玩家（房主操作）
- `room.state_update` — 房间状态变更

**【游戏消息】**
- `game.action` — 玩家操作（出牌/过/等）
- `game.state_update` — 服务端状态广播
- `game.current_turn` — 轮到某玩家操作
- `game.pass` — 玩家选择过牌
- `game.rematch` — 要求再来一局
- `game.finished` — 游戏结束通知
- `game.result` — 游戏结果详情
- `game.settlement` — 结算明细

**【断线重连】**
- `game.reconnect` — 客户端重连请求（含 lastSeq）
- `game.reconnected` — 服务端重连响应
- `game.timeout` — 游戏已结束，无法恢复

**【机器人消息】**
- `robot.join` — 机器人加入房间
- `robot.leave` — 机器人离开房间

**【支付消息】**
- `payment.create_order` — 创建充值订单
- `payment.order_created` — 订单创建成功
- `payment.callback` — 支付结果推送

**【好友消息】**
- `friend.request` — 发送好友请求
- `friend.accept` — 接受好友请求
- `friend.reject` — 拒绝好友请求
- `friend.remove` — 删除好友
- `friend.online` — 好友在线状态变更

**【消息格式】**
```typescript
interface WSMessage {
  type: string;        // 消息类型（见上方清单）
  seq: number;         // 请求序列号（客户端发起为 >0，服务端推送为 0）
  timestamp: number;   // 客户端时间戳（毫秒）
  payload: any;
  signature?: string;  // 签名（关键操作如充值、提现）
}

interface WSResponse {
  type: string;
  seq: number;
  code: number;        // 0=成功，详见附录B错误码
  message?: string;
  data?: any;
}
```

---

## 十二、GitHub参考项目

| 项目 | 描述 | 语言 | 链接 |
|------|------|------|------|
| floatinghotpot/casino-server | 博彩游戏服务器（老虎机、扑克等） | JavaScript | https://github.com/floatinghotpot/casino-server |
| notpritam/4amcasino | Provably-fair Texas Hold'em，心理健康扑克 | TypeScript | https://github.com/notpritam/4amcasino |
| absswds/GameNest | 自托管LAN派对中心，27种棋牌/桌游 | JavaScript | https://github.com/absswds/GameNest |
| Atvriders/cards-and-such | 基于浏览器的游戏中心，4500+可玩游戏 | TypeScript | https://github.com/Atvriders/cards-and-such |
| hugo-chilemme/node-realtime-server | 实时服务器框架，WebSocket/Socket.io | JavaScript | https://github.com/hugo-chilemme/node-realtime-server |
| albrthuynh/Secure-Chess | 安全国际象棋平台，C++ WS+Prometheus监控 | Python/C++ | https://github.com/albrthuynh/Secure-Chess |
| elithz/Duelyst | 卡牌策略游戏，Node.js服务端 | Java/JS | https://github.com/elithz/Duelyst |

**搜索建议：**
- GitHub搜索关键词：`斗地主 websocket 源码`、`mahjong game server`、`poker nodejs`
- 搜索框架：`NestJS microservices example`、`socket.io multiplayer game`

---

## 十三、开发阶段规划

### Phase 1：基础框架（2-3周）
- [ ] 搭建NestJS微服务脚手架
- [ ] 实现API Gateway
- [ ] 实现User Service（注册登录 + RBAC权限模型）
- [ ] 实现WebSocket通信基础（含心跳机制）
- [ ] 搭建Redis和MySQL基础设施
- [ ] 集成Prometheus + Grafana
- [ ] 编写单元测试框架

### Phase 2：核心游戏框架（3-4周）
- [ ] 实现Room Service（房间管理 + 多维度匹配）
- [ ] 实现Game Service基础框架（策略模式 + 版本控制）
- [ ] 实现斗地主玩法
- [ ] 实现WebSocket消息协议（含断线重连）
- [ ] 实现基础监控指标
- [ ] 编写集成测试 + 压力测试脚本

### Phase 3：货币与支付（2-3周）
- [ ] 实现Currency Service（含提现流程）
- [ ] 实现Payment Service完整流程（充值/退款/超时处理）
- [ ] 对接一个支付渠道（测试环境）
- [ ] 实现流水日志系统
- [ ] 实现每日自动对账任务
- [ ] 编写货币操作单元测试

### Phase 4：机器人系统（2-3周）
- [ ] 实现Robot Pool Service
- [ ] 实现AI引擎（斗地主AI规则引擎）
- [ ] 实现自动填充逻辑
- [ ] 实现思考延迟模拟
- [ ] 编写AI对战模拟测试

### Phase 5：配置管理与风控（2周）
- [ ] 实现GameConfig Service（配置热更新）
- [ ] 实现风控系统（异常检测）
- [ ] 实现管理员权限管理（RBAC）
- [ ] 编写配置管理集成测试

### Phase 6：更多玩法（持续）
- [ ] 实现麻将（血流成河）
- [ ] 实现麻将（成都麻将）
- [ ] 实现其他扑克玩法
- [ ] AI算法升级（MCTS → 深度学习）

### Phase 7：管理后台与运维（2-3周）
- [ ] 实现Dashboard Service
- [ ] 实现Admin Service（含审计日志）
- [ ] 实现对战记录查询
- [ ] 配置告警规则
- [ ] 部署监控面板
- [ ] 编写运维手册（备份恢复流程）
- [ ] 数据库备份策略配置

### Phase 7.5：上线检查清单

**【灰度发布步骤】**
- [ ] 部署前备份 MySQL 数据（全量 mysqldump）
- [ ] 部署 Redis 快照（RDB + AOF 校验）
- [ ] 蓝绿/金丝雀发布：先部署 1 个实例，观察 10 分钟
- [ ] 检查监控指标：错误率 < 0.1%，P99 延迟 < 目标值
- [ ] 逐步增加实例，每步观察 5 分钟
- [ ] 全部实例部署完成后，进行冒烟测试

**【回滚条件】**
- 错误率 > 1% 持续 5 分钟
- P99 延迟超过目标值 2 倍持续 3 分钟
- 支付回调失败率 > 0.5%
- 数据库连接池耗尽
- 触发回滚 → kubectl rollout undo deployment/<service> --to-revision=N

**【紧急止血方案】**
- 支付熔断：支付服务健康检查失败时，自动切换备用渠道
- 限流降级：WebSocket 连接数超过 8000 时，暂停新用户登录
- 只读模式：MySQL 主库异常时，切换为只读模式，拒绝写操作
- 熔断器：RPC 调用失败率 > 10% 时，熔断下游服务调用

**【安全扫描要求】**
- [ ] 依赖包漏洞扫描（npm audit）
- [ ] 容器镜像安全扫描（Trivy/Clair）
- [ ] 渗透测试（OWASP ZAP）
- [ ] 密钥泄露检查（git-secrets/truffleHog）

---

## 十四、Kubernetes 管理设计

### 14.1 服务资源配置

```yaml
# k8s/deployments/game-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: game-service
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # 滚动更新，零停机
  selector:
    matchLabels:
      app: game-service
  template:
    metadata:
      labels:
        app: game-service
    spec:
      containers:
      - name: game-service
        image: registry.game.com/game-service:latest
        ports:
        - containerPort: 3001
          name: tcp
        - containerPort: 9090
          name: metrics
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2000m"
            memory: "2Gi"
        livenessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 10
          periodSeconds: 5
---
# HPA：根据 CPU 和 WebSocket 连接数自动扩缩容
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: game-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: game-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: ws_connections
      target:
        type: AverageValue
        averageValue: "500"  # 每个 Pod 最多 500 个 WS 连接
```

### 14.2 服务发现与负载均衡

```yaml
# k8s/services.yaml
apiVersion: v1
kind: Service
metadata:
  name: game-service
spec:
  selector:
    app: game-service
  ports:
  - name: tcp
    port: 3001
    targetPort: 3001
    protocol: TCP
  - name: metrics
    port: 9090
    targetPort: 9090
    protocol: TCP
  type: ClusterIP
---
# Gateway 服务（NodePort 暴露给外部）
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
spec:
  type: NodePort
  selector:
    app: api-gateway
  ports:
  - name: http
    port: 80
    targetPort: 80
    nodePort: 30080
  - name: https
    port: 443
    targetPort: 443
    nodePort: 30443
  - name: websocket
    port: 8080
    targetPort: 8080
    nodePort: 30808
```

### 14.3 Ingress 配置（WebSocket + HTTPS）

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: game-ingress
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-http-version: "1.1"
    nginx.ingress.kubernetes.io/use-regex: "true"
spec:
  tls:
  - hosts:
    - game.example.com
    secretName: game-tls
  rules:
  - host: game.example.com
    http:
      paths:
      - path: /ws(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: game-service
            port:
              number: 3001
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-gateway
            port:
              number: 80
```

### 14.4 配置管理（ConfigMap + Secret）

```yaml
# ConfigMap：业务配置
apiVersion: v1
kind: ConfigMap
metadata:
  name: game-config
data:
  GAME_CONFIG.json: |
    {
      "maxPlayers": 3,
      "baseScore": 100,
      "matchTimeout": 30000
    }
  LOG_LEVEL: "info"
  NODE_ENV: "production"
---
# Secret：敏感配置
apiVersion: v1
kind: Secret
metadata:
  name: game-secrets
type: Opaque
stringData:
  REDIS_PASSWORD: "xxxxxxxx"
  MYSQL_PASSWORD: "xxxxxxxx"
  JWT_SECRET: "xxxxxxxx"
  PAYMENT_SECRET_KEY: "xxxxxxxx"
```

### 14.5 滚动更新与回滚策略

```yaml
# Deployment 滚动更新配置
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1           # 最多比期望副本数多 1 个
    maxUnavailable: 0     # 更新过程中不允许不可用

# 版本管理
apiVersion: apps/v1
kind: Deployment
metadata:
  name: game-service
spec:
  template:
    metadata:
      labels:
        app: game-service
        version: v1.2.3   # 版本号标签
    spec:
      containers:
      - name: game-service
        image: registry.game.com/game-service:v1.2.3
```

**回滚命令**：
```bash
# 查看历史版本
kubectl rollout history deployment/game-service

# 回滚到上一个版本
kubectl rollout undo deployment/game-service

# 回滚到指定版本
kubectl rollout undo deployment/game-service --to-revision=2
```

### 14.6 监控告警集成

```yaml
# Prometheus ServiceMonitor
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: game-service-monitor
spec:
  selector:
    matchLabels:
      app: game-service
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
---
# AlertManager 规则
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: game-alerts
spec:
  groups:
  - name: game
    rules:
    - alert: GameServiceHighErrorRate
      expr: rate(game_error_total[5m]) / rate(game_total_actions[5m]) > 0.05
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "游戏服务错误率超过5%"
    - alert: GameServicePodCrashLoop
      expr: kube_pod_status_phase{phase="CrashLoopBackOff"} == 1
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Pod 处于 CrashLoopBackOff 状态"
```

### 14.7 备份策略（持久化存储）

```yaml
# PVC：MySQL 数据持久化
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mysql-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  storageClassName: ssd
---
# Backup Job：每日备份
apiVersion: batch/v1
kind: CronJob
metadata:
  name: mysql-backup
spec:
  schedule: "0 2 * * *"  # 每天凌晨2点
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: mysql:8.0
            command: ['/bin/sh', '-c', 'mysqldump -h mysql-service -u root -p${MYSQL_ROOT_PASSWORD} --all-databases > /backup/mysql_$(date +%Y%m%d).sql']
            volumeMounts:
            - name: backup-volume
              mountPath: /backup
          volumes:
          - name: backup-volume
            persistentVolumeClaim:
              claimName: backup-pvc
          restartPolicy: OnFailure
```

### 14.8 HPA 配置汇总

| 服务 | 最小副本 | 最大副本 | CPU 目标 | 其他指标 |
|------|----------|----------|----------|----------|
| Game Service | 3 | 20 | 70% | WS连接数 ≤ 500/Pod |
| Room Service | 2 | 10 | 70% | - |
| User Service | 2 | 10 | 70% | - |
| Currency Service | 2 | 10 | 70% | - |
| Payment Service | 1 | 5 | 70% | - |
| Robot System | 1 | 5 | 70% | - |
| API Gateway | 2 | 10 | 70% | - |

---

## 十五、部署架构

### 15.1 Kubernetes集群

```
┌──────────────────────────────────────────────┐
│              Kubernetes Cluster              │
│                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │ Gateway │  │ Game ×3 │  │ Room ×2 │     │
│  └─────────┘  └─────────┘  └─────────┘     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │ User ×2 │  │ Pay ×1  │  │Admin ×1 │     │
│  └─────────┘  └─────────┘  └─────────┘     │
│  ┌─────────┐  ┌─────────┐                  │
│  │ Robot   │  │Dashboard│                  │
│  │ ×1      │  │ ×1      │                  │
│  └─────────┘  └─────────┘                  │
│                                              │
│  ┌─────────────────────────────────────┐    │
│  │       Redis Cluster (Sentinel)       │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐           │    │
│  │  │Master│ │Slave│ │Slave│           │    │
│  │  └─────┘ └─────┘ └─────┘           │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─────────────────────────────────────┐    │
│  │        RabbitMQ Cluster              │    │
│  └─────────────────────────────────────┘    │
│                                              │
│  ┌─────────────────────────────────────┐    │
│  │     Prometheus + Grafana             │    │
│  │     Elasticsearch                    │    │
│  │     Alertmanager                     │    │
│  └─────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

### 15.2 水平扩展策略

| 服务 | 扩展方式 | 说明 |
|------|----------|------|
| Game Service | 无状态，水平扩容 | 通过负载均衡分发 |
| Room Service | 一致性哈希 | 房间数据在Redis，按roomId路由 |
| WebSocket | 一致性哈希路由 | roomId % N → 固定 Game Service 实例；HPA 扩缩时重新哈希，触发断线重连 |
| User Service | 无状态，水平扩容 | |
| Currency Service | 无状态，水平扩容 | 原子操作由Redis保证 |

### 15.3 CI/CD 流程

```
Git Push
    │
    ▼
┌──────────────┐
│  GitLab CI   │  (代码检查 + 单元测试)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Docker Build │  (构建镜像)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Registry    │  (镜像推送)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Kubernetes  │  (灰度发布 + 自动回滚)
└──────────────┘
```

### 15.4 数据库备份策略

| 数据库 | 备份方式 | 频率 | 保留时间 | 恢复演练 |
|--------|----------|------|----------|----------|
| MySQL | mysqldump + binlog | 全量每日2点，增量每6小时 | 30天 | 每月一次 |
| Redis | AOF持久化 + RDB快照 | 每秒刷盘 + 每小时快照 | 7天快照 | 每季度一次 |
| MongoDB | mongodump | 每日2点 | 30天 | 每月一次 |
| Elasticsearch | snapshot + restore | 每日2点 | 14天 | 每季度一次 |

**恢复流程：**
```
1. 评估影响范围（哪个表/集合需要恢复）
2. 停止相关服务写入（或切换到备份库）
3. 执行恢复操作（mysqldump/mongorestore/es snapshot restore）
4. 验证数据完整性（抽样检查）
5. 恢复服务并监控
6. 记录恢复日志和原因
```

**关键操作前自动备份：**
- 数据库结构变更（ALTER TABLE）
- 批量数据更新
- 配置变更（游戏配置热更新）

### 15.5 WebSocket 连接路由策略

**【一致性哈希路由】**
- 客户端建立 WebSocket 连接时，根据 roomId 计算哈希值
- hash(roomId) % activeGameServiceCount → 目标实例
- 优势：同一房间的所有玩家请求始终路由到同一 Game Service 实例
- 内存中的 GameSession 保持完整，无需跨实例同步

**【HPA 扩缩容处理】**
- 实例数变化时，一致性哈希重新计算
- 受影响的用户连接断开，触发客户端重连机制
- 重连后从 Redis 恢复游戏状态（见第七章故障恢复）
- 路由变化期间暂停新匹配，避免进入"飘移房间"

**【客户端重连策略】**
- 检测路由变更后，客户端自动重连
- 重连时携带最后已知 seq 号
- 服务端验证 seq → 返回当前 gameState（如果游戏未结束）
- 游戏已结束则通知结果，返回大厅

---

## 十六、附录

### A. 关键接口汇总

| 服务 | 接口 | 方法 | 说明 |
|------|------|------|------|
| User | /api/user/login | POST | 登录 |
| User | /api/user/profile | GET | 获取个人信息 |
| User | /api/user/ban | POST | 封禁用户（需operator权限） |
| Room | /api/room/create | POST | 创建房间 |
| Room | /api/room/join | POST | 加入房间 |
| Game | /ws/game | WebSocket | 游戏通信 |
| Currency | /api/currency/balance | GET | 查询余额 |
| Currency | /api/currency/deduct | POST | 扣费 |
| Currency | /api/currency/withdraw/create | POST | 提现申请 |
| Payment | /api/payment/create | POST | 创建订单 |
| Payment | /api/payment/callback | POST | 支付回调 |
| Payment | /api/payment/refund | POST | 退款申请 |
| Record | /api/record/list | GET | 查询对战记录 |
| Admin | /api/admin/recharge | POST | 管理员充值 |
| Admin | /api/admin/withdraw/confirm | POST | 确认提现（需finance权限） |
| Admin | /api/admin/config/update | PUT | 更新游戏配置（需super_admin权限） |
| Audit | /api/audit/daily-report | GET | 获取对账报告 |
| Dashboard | /api/dashboard/stats | GET | 获取实时统计 |
| Dashboard | /api/dashboard/logs | GET | 日志检索 |

### B. 错误码定义

| 错误码范围 | 错误码 | 说明 |
|-----------|--------|------|
| 通用 | 10001 | 参数错误 |
| 通用 | 10002 | 未登录 |
| 通用 | 10003 | 权限不足 |
| 通用 | 10004 | Token 已过期 |
| 通用 | 10005 | Token 签名无效 |
| 通用 | 10006 | 请求频率超限 |
| 用户 | 11001 | 手机号已注册 |
| 用户 | 11002 | 密码错误 |
| 用户 | 11003 | 账号已被封禁 |
| 用户 | 11004 | 用户不存在 |
| 房间 | 12001 | 房间不存在 |
| 房间 | 12002 | 房间已满 |
| 房间 | 12003 | 不在你的回合 |
| 房间 | 12004 | 你不在该房间中 |
| 房间 | 12005 | 踢人权限不足 |
| 房间 | 12006 | 好友房创建失败 |
| 游戏 | 13001 | 操作非法 |
| 游戏 | 13002 | 消息重复（seq号冲突） |
| 游戏 | 13003 | 消息过期（seq号不连续） |
| 游戏 | 13004 | 状态冲突（版本不一致） |
| 游戏 | 13005 | 游戏已结束无法操作 |
| 游戏 | 13006 | 出牌不合法 |
| 游戏 | 13007 | 超出操作时间限制 |
| 货币 | 14001 | 余额不足 |
| 货币 | 14002 | 重复请求 |
| 货币 | 14003 | 提现申请不存在 |
| 货币 | 14004 | 提现状态异常 |
| 货币 | 14005 | 手续费计算错误 |
| 货币 | 14006 | 提现申请已超时（pending 状态超过 timeout_at） |
| 货币 | 14007 | 提现额度已超时自动退回，请重新申请 |
| 支付 | 15001 | 支付失败 |
| 支付 | 15002 | 支付回调验证失败 |
| 支付 | 15003 | 提现申请失败 |
| 支付 | 15004 | 提现额度超限 |
| 支付 | 15005 | 支付渠道不可用 |
| 风控 | 16001 | 操作过于频繁 |
| 风控 | 16002 | 设备异常 |
| 风控 | 16003 | 账号存在风险，已限制操作 |
| 版本 | 17001 | 客户端版本过低，请更新 |
| 版本 | 17002 | 协议版本不兼容 |

**【分类说明】**
- 1xxxx: 通用错误
- 11xxx: 用户服务错误
- 12xxx: 房间服务错误
- 13xxx: 游戏服务错误
- 14xxx: 货币服务错误
- 15xxx: 支付服务错误
- 16xxx: 风控系统错误
- 17xxx: 版本控制错误

### C. AI算法升级路线

**斗地主AI：**
- Phase 1: 规则引擎（当前设计）
- Phase 2: 蒙特卡洛树搜索（MCTS）
- Phase 3: 深度学习（AlphaGo-like架构）

**麻将AI：**
- Phase 1: 向听数计算 + 牌效评估
- Phase 2: 安全度计算 + 防守策略
- Phase 3: 读牌能力 + 对手建模

### D. 设计决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 前端框架 | uni-app vs Cocos3D | uni-app | 一套代码多端，开发效率高 |
| 状态管理 | Vuex vs Pinia | Pinia | 更轻量，TS 支持更好 |
| 消息处理 | 串行 vs 批量 | 串行 | 简单可靠，游戏频率不高 |
| 版本管理 | 强制更新 vs 接口降级 | 强制更新 | 确保安全性，简单可控 |
| 匹配算法 | ELO vs MMORPG | ELO | 成熟稳定，适合棋牌 |
| 支付签名 | HMAC-SHA256 vs RSA | HMAC-SHA256 | 性能好，足够安全 |
| 密钥轮换 | 季度 vs 月度 | 季度 | 平衡安全与运维成本 |
| K8s 策略 | 滚动更新 vs 蓝绿 | 滚动更新 | 零停机，资源利用率高 |

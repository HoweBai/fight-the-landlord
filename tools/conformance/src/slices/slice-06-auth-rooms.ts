/**
 * conformance 用例：切片 6 —— 登录 + 房间列表。
 *
 * 判据（`docs/superpowers/plans/2026-09-13-slice-06-login-and-room-list.md` §Task 6）：
 *   **注册 → 登录 → 列表 → 刷新令牌 → 登出**，且登出**真的**让令牌失效。
 *
 * 覆盖的服务端契约：
 *   §5.1（access 2h / refresh 7d、轮换、`session:{jti}` 白名单、登出双删）、
 *   §7.1（公开路径白名单只有 4 条）、§3.1 + R22（`GET /api/rooms` → `{ code, data: RoomInfo[] }`）、
 *   §11.1–11.2（统一信封与数字错误码）。
 *
 * 前端无法自证的一部分（令牌真的被服务端吊销）只能在这里验 —— 这是本用例存在的主要理由。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, info, step } from '../lib/assert';
import { getJson, login, logout, postJson, refresh, registerUser, setFriendRooms } from '../lib/http';

/** §3.1：`RoomInfo` 的**完整且恰好**的字段集（多一个字段就是泄漏）。 */
// 多玩法（S2 Task 2.2）：RoomInfo 增 gameType（旧客户端忽略；恰键集同步为七个）。
const ROOM_INFO_KEYS = ['baseScore', 'code', 'gameType', 'maxPlayers', 'mode', 'playerCount', 'status'];
/** §3.1：`mode` 三值 —— `gold` = 金币场（P2-② 新增三值化；残留金币房出现在列表里是合法状态）。 */
const ROOM_MODES = ['random', 'practice', 'gold'];
const ROOM_STATUSES = ['waiting', 'playing', 'finished', 'cancelled'];

export async function runSlice06(): Promise<Checks> {
  const checks = new Checks();

  // ── 1) 注册 ────────────────────────────────────────────────────
  step('注册：POST /api/auth/register');
  const user = await registerUser(0);
  checks.that(user.id.length > 0, '注册返回 user.id');
  checks.that(user.accessToken.length > 0, '注册返回 accessToken');
  checks.that(user.refreshToken.length > 0, '注册返回 refreshToken');
  checks.that(user.accessToken !== user.refreshToken, 'access 与 refresh 是两张不同的令牌');
  checks.that(user.nickname.length > 0, '注册返回昵称');
  checks.eq(user.nickname, user.nickname?.trim(), '注册返回的昵称已 trim');

  // ── 片⑦ 前置（T14）：好友房开关必须**开** ────────────────────────
  // 本片第 6 步要 `POST /api/rooms` 建房，而片⑦ 起该路由按 `room.friendRoomEnabled`
  // 缓存值拦截（关 ⇒ 12006）。这里经管理面置 true 并**轮询至建房生效**（≤30s）。
  // ⚠️ 只开**不还原**（规格 §3 编排：开关的复原是 slice-14 收尾的职责）。
  await setFriendRooms(true, user.accessToken);

  // ── 2) 手机号重复 → 11001 / 409 ────────────────────────────────
  step('重复注册必须被拒（§11.2 的 11001）');
  const dup = await postJson('/api/auth/register', {
    phone: user.phone,
    password: 'passw0rd',
    nickname: 'dup',
  });
  checks.eq(dup.body?.code, ErrCode.PHONE_TAKEN, '重复注册 code');
  checks.eq(dup.status, 409, '重复注册 HTTP 状态');

  // ── 3) 登录失败的两条分支 ──────────────────────────────────────
  step('登录失败：密码错 / 用户不存在');
  const badPassword = await login(user.phone, 'definitely-wrong');
  checks.eq(badPassword.body?.code, ErrCode.BAD_CREDENTIALS, '密码错 code');

  const unknownPhone = `138${String(Date.now()).slice(-8)}`.slice(0, 11);
  const unknown = await login(unknownPhone, 'passw0rd');
  checks.eq(unknown.body?.code, ErrCode.USER_NOT_FOUND, '用户不存在 code');

  // ── 4) 登录成功 ────────────────────────────────────────────────
  step('登录成功');
  const ok = await login(user.phone, 'passw0rd');
  checks.eq(ok.body?.code, ErrCode.OK, '登录 code');
  checks.that(Boolean(ok.body?.data?.accessToken), '登录返回 accessToken');
  checks.that(Boolean(ok.body?.data?.refreshToken), '登录返回 refreshToken');

  // ── 5) 房间列表必须鉴权（§7.1 白名单只有 4 条） ────────────────
  step('匿名 GET /api/rooms 必须 401');
  const anon = await getJson('/api/rooms');
  checks.eq(anon.status, 401, '匿名访问房间列表的 HTTP 状态');
  checks.eq(anon.body?.code, ErrCode.UNAUTHENTICATED, '匿名访问房间列表的 code');

  // ── 6) 建一个房间，供列表断言使用 ──────────────────────────────
  step('带 token 创建房间：POST /api/rooms');
  const created = await postJson<{ code: string }>('/api/rooms', { mode: 'random' }, user.accessToken);
  checks.eq(created.body?.code, ErrCode.OK, '创建房间 code');
  const roomCode: string = created.body?.data?.code ?? '';
  checks.that(roomCode.length > 0, `拿到房间号（${roomCode}）`);

  // ── 7) 房间列表：信封 + 精确字段集 + 不泄漏 ────────────────────
  step('带 token GET /api/rooms → { code, data: RoomInfo[] }');
  const list = await getJson<any[]>('/api/rooms', user.accessToken);
  checks.eq(list.body?.code, ErrCode.OK, '房间列表 code');
  checks.that(Array.isArray(list.body?.data), 'data 是数组（R22：不是裸数组、也不是 { rooms }）');

  const rooms: any[] = list.body?.data ?? [];
  checks.that(rooms.length > 0, `列表非空（${rooms.length} 个房间）`);

  for (const room of rooms) {
    checks.eq(JSON.stringify(Object.keys(room).sort()), JSON.stringify(ROOM_INFO_KEYS), `房间 ${room.code} 的字段集恰好是 RoomInfo`);
    checks.that(ROOM_MODES.includes(room.mode), `房间 ${room.code} 的 mode 合法`);
    checks.that(ROOM_STATUSES.includes(room.status), `房间 ${room.code} 的 status 合法`);
    checks.that(typeof room.playerCount === 'number', `房间 ${room.code} 的 playerCount 是数字`);
    checks.that(typeof room.baseScore === 'number', `房间 ${room.code} 的 baseScore 是数字`);
  }

  const mine = rooms.find((r) => r.code === roomCode);
  checks.that(Boolean(mine), '刚创建的房间出现在列表里');
  checks.eq(mine?.playerCount, 0, '刚创建的房间 playerCount');
  checks.eq(mine?.maxPlayers, 3, '房间 maxPlayers');

  /**
   * 缺省底分（§3.1）：建房**未指定** `baseScore` ⇒ 服务端走自己的缺省值。
   *
   * ⚠️ **不写死数字**（Task 3e）：缺省底分在 2026-10-21 改成了「档位表最低档」，
   * 写死的断言会在**真栈上**红（conformance 的 job 跑在 master/tag 上 ⇒「合了就红」）。
   * 缺省值的**真实来源**是档位表：片⑦ 起经 `GET /api/config`（config-service 的玩家面子集
   * `{ baseScoreLevels, friendRoomEnabled, version }`）读 —— 旧端点 `GET /api/base-score-levels`
   * 已随 user-service 的底分 RPC 一同退役（T13）；room-service 走 config RPC 读同一张 config 表。
   * §2.4 的不变量是「缺省必须**属于**档位表」。
   *
   * ⚠️ **断言是成员关系，不是「等于最小的那档」**（Task 3g 修复 I3）：规格 §2.3 明确支持
   * 运维在**运行期**往表里加/改档位 —— 加一档更便宜的（比如 5 分休闲场）是**被许可**的
   * 变更，而「=== 最小档」会把它误判成失败（本仓缺省取的是最小的那档只是**当前**取值，
   * 不是契约）。成员断言保住活读（表变了跟着走）、去掉误红面 —— 仍然能在「缺省不在表里」
   * （T2-M4 那个真缺陷）时红。
   */
  step('读客户端配置：GET /api/config 的 baseScoreLevels（缺省底分的真实来源）');
  const levelsRes = await getJson<{ baseScoreLevels: { name: string; baseScore: number }[] }>(
    '/api/config',
    user.accessToken,
  );
  checks.eq(levelsRes.body?.code, ErrCode.OK, '底分档位表 code');
  const levelValues = (levelsRes.body?.data?.baseScoreLevels ?? []).map((level) => level.baseScore);
  checks.that(levelValues.length > 0, `档位表非空（${levelValues.length} 档）`);
  checks.that(
    levelValues.includes(mine?.baseScore),
    `房间 baseScore ∈ 档位表（${mine?.baseScore} ∈ [${levelValues.join(', ')}]；缺省底分必须` +
      `**属于**档位表 —— 断言读真实来源、且只要求成员关系：运维加一档更便宜的是许可的变更）`,
  );

  assertNoLeak(rooms, 'GET /api/rooms 的 data');
  checks.ok('房间列表无 players / isRobot / actionLog 等泄漏');

  // ── 8) 刷新：轮换，旧 refresh token 立即失效 ───────────────────
  step('刷新令牌：POST /api/auth/refresh（轮换）');
  const rotated = await refresh(user.refreshToken);
  checks.eq(rotated.body?.code, ErrCode.OK, 'refresh code');
  const newAccess: string = rotated.body?.data?.accessToken ?? '';
  const newRefresh: string = rotated.body?.data?.refreshToken ?? '';
  checks.that(newAccess.length > 0 && newRefresh.length > 0, 'refresh 返回新的一对');
  checks.that(newAccess !== user.accessToken, '新 access token 与旧的不同');
  checks.that(newRefresh !== user.refreshToken, '新 refresh token 与旧的不同');

  const replay = await refresh(user.refreshToken);
  checks.that(replay.body?.code !== ErrCode.OK, `旧 refresh token 重放被拒（code=${replay.body?.code}）`);

  // ── 9) 轮换只吊销旧的 refresh，旧的 access 仍然有效（§5.1 只规定 refresh 轮换） ──
  step('轮换不影响仍在有效期内的旧 access token');
  const stillOk = await getJson('/api/rooms', user.accessToken);
  checks.eq(stillOk.body?.code, ErrCode.OK, '旧 access token 在轮换后仍可用');

  // ── 10) 登出 ───────────────────────────────────────────────────
  step('登出：POST /api/auth/logout（删除两个 jti）');
  const out = await logout(newAccess, newRefresh);
  checks.eq(out.body?.code, ErrCode.OK, 'logout code');

  // ── 11) 登出后 access token 必须被白名单拒绝（R26 的核心） ─────
  step('登出后旧 access token 必须失效');
  const afterLogout = await getJson('/api/rooms', newAccess);
  checks.eq(afterLogout.body?.code, ErrCode.TOKEN_EXPIRED, '登出后 access token 的 code（R26：白名单真的被查询）');
  checks.eq(afterLogout.status, 401, '登出后 access token 的 HTTP 状态');

  // ── 12) 登出后 refresh token 也必须失效 ────────────────────────
  const afterLogoutRefresh = await refresh(newRefresh);
  checks.that(afterLogoutRefresh.body?.code !== ErrCode.OK, `登出后 refresh token 被拒（code=${afterLogoutRefresh.body?.code}）`);

  // ── 13) 未登出的另一个账号不受影响（白名单是按 jti 的，不是全局开关） ──
  step('另一个账号不受影响（白名单按 jti 生效）');
  const other = await registerUser(1);
  const otherList = await getJson('/api/rooms', other.accessToken);
  checks.eq(otherList.body?.code, ErrCode.OK, '另一账号仍可访问列表');
  info(`roomCode=${roomCode}，断言全部通过后该房间仍留在 Redis 里（TTL 3600s），不影响后续用例`);

  return checks;
}

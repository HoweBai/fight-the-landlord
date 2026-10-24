import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { botNamesLockKey, nicknamesKey, ROOM_TTL_SECONDS } from './rooms.seats';

/**
 * 机器人拟人昵称（设计 `2026-10-22-bot-display-nicknames-design.md`）。
 *
 * 目标：让机器人座位与人类一样带 `nickname`，消除「玩家N」这一事实上的机器人标识。
 * 约束：
 *  - 池为人工精选常量：2–8 字、唯一、不含 `机器人/人机/电脑/AI/bot/系统/官方`；
 *  - 分配确定性：`hash(roomCode + displayId + seat)`，同房间重试稳定、换房间换名；
 *  - 落盘进现有 `room:{code}:nicknames` Hash（field = displayId），读路径零改动；
 *  - 全链路 fail-open：任何失败只 WARN，绝不阻塞开局/记录。
 */

const logger = new Logger('BotNames');

/** 锁释放脚本：token 匹配才删（避免 TTL 过期后误删新持有者的锁）。 */
export const BOT_NAMES_RELEASE_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** 短锁 TTL / 自旋参数：临界区只有几次 Redis 往返，3s 足够兜底。 */
export const BOT_NAME_LOCK_TTL_SECONDS = 3;
export const BOT_NAME_SPIN_ATTEMPTS = 15;
export const BOT_NAME_SPIN_INTERVAL_MS = 20;

/**
 * 精选中文昵称池（240 个）。
 *
 * ⚠️ 只在代码内维护：本片不新增配置键（用户裁决 K3）。改池必须走代码评审，
 * `bot-names.test.ts` 会机械校验长度/唯一性/禁词。
 */
export const BOT_DISPLAY_NAMES: readonly string[] = [
  '清风', '明月', '山间风', '海边树', '落霞', '秋水', '春山', '夏雨',
  '冬雪', '星河', '云朵', '小溪', '竹林', '松风', '听雨', '观海',
  '望山', '踏雪', '寻梅', '赏月', '小猫咪', '大橘猫', '柴犬', '白兔',
  '小熊', '狐狸', '松鼠', '海豚', '企鹅', '熊猫', '小鹿', '燕子',
  '麻雀', '鲸鱼', '猫头鹰', '糖葫芦', '小笼包', '豆浆', '油条', '麻花',
  '汤圆', '饺子', '粽子', '月饼', '年糕', '布丁', '奶茶', '咖啡',
  '蛋糕', '冰淇淋', '棉花糖', '爆米花', '纸飞机', '风车', '风筝', '弹珠',
  '陀螺', '木马', '积木', '拼图', '画笔', '吉他', '口琴', '钢琴',
  '相机', '单车', '帆船', '开心果', '小太阳', '乐天派', '慢半拍', '急性子',
  '夜猫子', '小吃货', '爱旅行', '想下班', '江南客', '北方人', '山里人', '江湖客',
  '剑客', '书生', '侠客', '行者', '归人', '过客', '阿豆', '阿木',
  '小林', '小周', '小北', '小南', '小西', '小东', '阿飞', '阿杰',
  '阿凯', '阿宁', '阿泽', '阿远', '青柠', '柠檬茶', '蜜桃', '草莓',
  '蓝莓', '樱桃', '西瓜', '哈密瓜', '葡萄', '橘子', '柚子', '苹果',
  '香蕉', '菠萝', '芒果', '山竹', '荔枝', '龙眼', '石榴', '无花果',
  '白云', '蓝天', '彩虹', '晚风', '晨曦', '夕阳', '月光', '星光',
  '灯火', '炊烟', '小桥', '流水', '古道', '长亭', '庭院', '屋檐',
  '窗台', '书桌', '台灯', '沙发', '毛毯', '抱枕', '拖鞋', '茶杯',
  '水壶', '闹钟', '日历', '笔记本', '书签', '信封', '邮票', '明信片',
  '老照片', '收音机', '唱片', '电影票', '车票', '地图', '指南针', '望远镜',
  '手电筒', '雨伞', '雨靴', '围巾', '手套', '帽子', '背包', '水杯',
  '钥匙扣', '小铃铛', '幸运星', '千纸鹤', '纸船', '风筝线', '蒲公英', '四叶草',
  '向日葵', '薰衣草', '满天星', '勿忘我', '栀子花', '桂花', '梅花', '兰花',
  '荷花', '菊花', '桃花', '杏花', '梨花', '樱花', '小海星', '小螃蟹',
  '小虾米', '小丑鱼', '海龟', '水母', '珊瑚', '贝壳', '珍珠', '浪花',
  '沙滩', '椰子树', '小木屋', '帐篷', '篝火', '露营灯', '吊床', '银河',
  '流星', '彗星', '月亮船', '太阳花', '云朵儿', '雨滴', '雪花', '冰晶',
  '露珠', '晨雾', '晚霞', '霞光', '小木桥', '石板路', '青石巷', '老槐树',
  '梧桐', '银杏', '枫叶', '松果', '橡果', '蘑菇', '小苔藓', '竹笋',
  '稻穗', '麦田', '油菜花', '茉莉', '百合', '玫瑰', '郁金香', '风铃草',
];

/** FNV-1a 32 位：稳定、零依赖、跨进程一致。 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 纯函数：为一批机器人分配昵称。
 *
 * - 输入按 `seat` 升序（同座按 displayId 兜底）处理，保证结果与调用顺序无关；
 * - 起始下标 = `fnv1a32(`${roomCode}:${displayId}:${seat}`) % pool.length`；
 * - 与 `taken` 或本批已用名字重复时向后线性探测，最多池长次；
 * - 探测耗尽（理论上 `taken` 覆盖整池）⇒ 跳过该机器人，不死循环。
 */
export function assignBotDisplayNames(
  roomCode: string,
  robots: ReadonlyArray<{ seat: number; displayId: string }>,
  taken: Iterable<string> = [],
): Array<{ displayId: string; nickname: string }> {
  const used = new Set(taken);
  const sorted = [...robots].sort((a, b) => {
    if (a.seat !== b.seat) return a.seat - b.seat;
    // seat 在同一房间内唯一；这里只做 locale 无关的稳定兜底（防夹具重复座位）。
    return a.displayId < b.displayId ? -1 : a.displayId > b.displayId ? 1 : 0;
  });
  const assignments: Array<{ displayId: string; nickname: string }> = [];

  for (const robot of sorted) {
    const start = fnv1a32(`${roomCode}:${robot.displayId}:${robot.seat}`) % BOT_DISPLAY_NAMES.length;
    let chosen: string | null = null;
    for (let step = 0; step < BOT_DISPLAY_NAMES.length; step += 1) {
      const candidate = BOT_DISPLAY_NAMES[(start + step) % BOT_DISPLAY_NAMES.length]!;
      if (!used.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === null) continue;
    used.add(chosen);
    assignments.push({ displayId: robot.displayId, nickname: chosen });
  }

  return assignments;
}

export interface BotDisplayNameOptions {
  /** 测试注入：避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
  spinAttempts?: number;
  spinIntervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 房间级落盘（唯一入口）：抢短锁 → 读 Hash → 分配 → `HSETNX` → `EXPIRE`。
 *
 * - `robots` 为空 ⇒ 零 Redis 调用；
 * - 锁被占用：自旋 `spinAttempts` 次后放弃（由持锁方负责）；
 * - 读 Hash 失败 ⇒ `taken = []`，照常分配；
 * - 任一步抛错 ⇒ WARN，绝不向外抛（fail-open）；
 * - 只要本次有字段写入成功，`finally` 里一定补 `EXPIRE`（Hash 不继承 TTL）。
 */
export async function ensureBotDisplayNames(
  redis: Redis,
  roomCode: string,
  robots: ReadonlyArray<{ seat: number; displayId: string }>,
  options: BotDisplayNameOptions = {},
): Promise<void> {
  if (robots.length === 0) return;

  const sleep = options.sleep ?? defaultSleep;
  const spinAttempts = options.spinAttempts ?? BOT_NAME_SPIN_ATTEMPTS;
  const spinIntervalMs = options.spinIntervalMs ?? BOT_NAME_SPIN_INTERVAL_MS;
  const lockKey = botNamesLockKey(roomCode);
  const token = randomUUID();

  let locked = false;
  let wrote = false;

  try {
    for (let attempt = 0; attempt < spinAttempts && !locked; attempt += 1) {
      try {
        const result = await redis.set(lockKey, token, 'EX', BOT_NAME_LOCK_TTL_SECONDS, 'NX');
        locked = result === 'OK';
      } catch (err) {
        logger.warn(`Failed to acquire bot-name lock for room ${roomCode}: ${String(err)}`);
        return;
      }
      if (!locked) await sleep(spinIntervalMs);
    }

    if (!locked) {
      logger.warn(`Bot-name lock busy for room ${roomCode}; skip assignment (fail-open)`);
      return;
    }

    let hash: Record<string, string> = {};
    try {
      hash = (await redis.hgetall(nicknamesKey(roomCode))) ?? {};
    } catch (err) {
      logger.warn(`Failed to read nicknames for room ${roomCode}: ${String(err)}`);
    }

    const missing = robots.filter((robot) => !(robot.displayId in hash));
    if (missing.length === 0) return;

    // 空串是「已知无昵称」哨兵，不参与撞名。
    const taken = Object.values(hash).filter((name) => name !== '');
    const assignments = assignBotDisplayNames(roomCode, missing, taken);

    for (const { displayId, nickname } of assignments) {
      const added = await redis.hsetnx(nicknamesKey(roomCode), displayId, nickname);
      if (added === 1) wrote = true;
    }
  } catch (err) {
    logger.warn(`Failed to assign bot display names for room ${roomCode}: ${String(err)}`);
  } finally {
    if (wrote) {
      try {
        await redis.expire(nicknamesKey(roomCode), ROOM_TTL_SECONDS);
      } catch (err) {
        logger.warn(`Failed to refresh nickname TTL for room ${roomCode}: ${String(err)}`);
      }
    }
    if (locked) {
      try {
        await redis.eval(BOT_NAMES_RELEASE_LOCK_LUA, 1, lockKey, token);
      } catch (err) {
        logger.warn(`Failed to release bot-name lock for room ${roomCode}: ${String(err)}`);
      }
    }
  }
}

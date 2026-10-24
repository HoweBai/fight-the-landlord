import { IsInt, IsOptional, IsString, IsEnum, IsIn } from 'class-validator';
import { GAME_TYPES, type GameType } from '@fight-the-landlord/protocol';

/**
 * §3.1：模式**只有**两种。旧枚举里的 `friend` / `score` 不在 MVP 契约内。
 *
 * 注意 `rooms.service.ts` 另有一个同名的字面量联合类型 `RoomMode`
 * （'random' | 'practice'）用于内部 `Room` 形状；两者取值完全一致，
 * 字符串枚举成员可以直接赋给该联合类型，因此不需要任何 cast。
 */
export enum RoomMode {
  RANDOM = 'random',
  PRACTICE = 'practice',
}

export class CreateRoomDto {
  @IsEnum(RoomMode)
  mode!: RoomMode;

  @IsOptional()
  @IsString()
  roomCode?: string;

  /**
   * 片规格 §2.4 协议⑤：底分。**是不是合法档位由 `RoomsService.create()` 校验**
   * （要经 RPC 查表 ⇒ 那是服务层的事，DTO 只管「是不是一个整数」）。
   *
   * 🔴 **这个字段是那扇门**：`main.ts` 的 `ValidationPipe({whitelist: true})` 会把
   * **未声明**的属性**静默剥掉**（不是报错）—— 少了它，`{"mode":"random","baseScore":999}`
   * 会以缺省底分建房**成功**，协议⑤ 的校验根本到不了。
   * ⚠️ 同样理由，它**不能**写成无装饰器的普通属性（无校验元数据 ⇒ 一样被剥掉）。
   */
  @IsOptional()
  @IsInt()
  baseScore?: number;

  /**
   * 多玩法（Task 2.2 / spec §4.6.2）：玩法 id。缺省 = doudizhu（旧客户端）。
   * 🔴 **必须在这里声明**：`ValidationPipe({whitelist:true})` 会静默剥掉未声明属性，
   * 少了它新客户端建的跑得快房会静默变成斗地主房（与 `baseScore` 同一扇门）。
   */
  @IsOptional()
  @IsIn([...GAME_TYPES])
  gameType?: GameType;

  /** 人数（跑得快 2/3/4；斗地主 3）。合法人数/玩法闸在 service（12012）。 */
  @IsOptional()
  @IsInt()
  playerCount?: number;
}

/**
 * `POST /api/rooms/:code/join` 的请求体（Task 2.2 / spec RB1）。
 *
 * 旧客户端**不带 body** ⇒ `gameType` 缺省 = doudizhu；进跑得快房 ⇒ `12012`（不占座）。
 * 身份仍**只**来自网关注入的 `X-User-Id`（§5.2）——本 DTO 不含 userId。
 */
export class JoinRoomDto {
  @IsOptional()
  @IsIn([...GAME_TYPES])
  gameType?: GameType;
}

import type { Seat } from '@fight-the-landlord/protocol';

/**
 * §3.1 `Seat` 的测试工厂。
 *
 * 形状的**唯一**来源是 `packages/protocol/src/views.ts`（本片零改动协议包），
 * 这里只是省字 —— 因此**不得**引入任何本地同义类型（R128）。
 *
 * 切片 7.1 之前 `Room.players` 是 `string[]`，测试夹具直接写
 * `players: ['alice', 'bob']`；改成 `Seat[]` 后，座位号不再等于数组下标，
 * 夹具必须**显式**给出座位号（这正是 R128 要钉住的东西）。
 */

/** 单个座位。 */
export function seat(userId: string, seatNumber: number, isRobot = false): Seat {
  return { userId, seat: seatNumber, isRobot };
}

/** 人类座位：座位号 = 参数下标。 */
export function seatsOf(...userIds: string[]): Seat[] {
  return userIds.map((userId, seatNumber) => seat(userId, seatNumber));
}

/** 机器人座位：接在 `humans` 个座位之后，`isRobot: true`。 */
export function botSeatsOf(humans: number, ...botIds: string[]): Seat[] {
  return botIds.map((userId, i) => seat(userId, humans + i, true));
}

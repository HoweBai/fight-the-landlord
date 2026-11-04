import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from '../src/users/users.dto';

async function errorsFor(input: Record<string, unknown>) {
  return validate(plainToInstance(RegisterDto, input));
}

describe('RegisterDto.inviteCode（选填，但类型必须正确）', () => {
  it('合法码 trim + 大写；空白串 ⇒ 视为未填（undefined）', async () => {
    const dto = plainToInstance(RegisterDto, {
      phone: '13800000000',
      password: 'passw0rd',
      nickname: '阿豆',
      inviteCode: ' abcd2345 ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.inviteCode).toBe('ABCD2345');

    const blank = plainToInstance(RegisterDto, {
      phone: '13800000000',
      password: 'passw0rd',
      nickname: '阿豆',
      inviteCode: '   ',
    });
    expect(await validate(blank)).toHaveLength(0);
    expect(blank.inviteCode).toBeUndefined();
  });

  it('非字符串（数字/对象/数组）⇒ inviteCode 校验失败（不得静默当缺省）', async () => {
    for (const inviteCode of [12345678, { code: 'ABCD2345' }, ['ABCD2345']]) {
      const errors = await errorsFor({
        phone: '13800000000',
        password: 'passw0rd',
        nickname: '阿豆',
        inviteCode,
      });
      expect(
        errors.some((e) => e.property === 'inviteCode'),
        `inviteCode=${JSON.stringify(inviteCode)}`,
      ).toBe(true);
    }
  });
});

describe('RegisterDto.nickname（注册昵称必填）', () => {
  it('合法昵称通过，且被 trim', async () => {
    const dto = plainToInstance(RegisterDto, {
      phone: '13800000000',
      password: 'passw0rd',
      nickname: '  阿豆  ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.nickname).toBe('阿豆');
  });

  it('缺省 / 空串 / 纯空白 ⇒ nickname 校验失败', async () => {
    for (const nickname of [undefined, '', '   ']) {
      const errors = await errorsFor({ phone: '13800000000', password: 'passw0rd', nickname });
      expect(errors.some((e) => e.property === 'nickname'), `nickname=${JSON.stringify(nickname)}`).toBe(
        true,
      );
    }
  });

  it('超过 20 字符 ⇒ nickname 校验失败；恰 20 字符通过', async () => {
    const tooLong = await errorsFor({
      phone: '13800000000',
      password: 'passw0rd',
      nickname: 'a'.repeat(21),
    });
    expect(tooLong.some((e) => e.property === 'nickname')).toBe(true);

    const exact = await errorsFor({
      phone: '13800000000',
      password: 'passw0rd',
      nickname: 'a'.repeat(20),
    });
    expect(exact).toHaveLength(0);
  });
});

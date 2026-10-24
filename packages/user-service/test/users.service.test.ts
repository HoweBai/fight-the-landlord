import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from '../src/users/users.service';

/**
 * `UsersService` 现在只负责资料读写（注册/登录归 `AuthService`）。
 *
 * ⚠️ 这里曾用 `vi.mock('bcrypt')` / `vi.mock('uuid')` 覆盖 `register` / `login`：
 * 那两个方法签发的令牌既没有 `typ` 也没有 `jti`，必然被网关以 `10005` 拒绝，
 * 已整体删除，对应用例随之删除。
 */
describe('UsersService', () => {
  let service: UsersService;
  let mockRepo: any;

  beforeEach(() => {
    mockRepo = {
      findByPhone: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    service = new UsersService(mockRepo);
  });

  it('getMe 只回四个字段（绝不带 passwordHash）', async () => {
    mockRepo.findById.mockResolvedValue({
      id: 'user-1',
      phone: '13800000001',
      nickname: 'Test',
      status: 'active',
      passwordHash: 'super-secret-hash',
      avatar: null,
    });

    const me = await service.getMe('user-1');

    expect(me).toEqual({ id: 'user-1', phone: '13800000001', nickname: 'Test', status: 'active' });
    expect(JSON.stringify(me)).not.toContain('super-secret-hash');
  });

  it('getMe 对不存在的用户抛 NotFound', async () => {
    mockRepo.findById.mockResolvedValue(null);
    await expect(service.getMe('ghost')).rejects.toThrow(NotFoundException);
  });

  it('updateProfile 只透传显式给出的字段', async () => {
    await service.updateProfile('user-1', { nickname: '新名字' });

    expect(mockRepo.update).toHaveBeenCalledWith('user-1', { nickname: '新名字' });
  });

  it('updateProfile 允许只改 avatar（不改 nickname）', async () => {
    await service.updateProfile('user-1', { avatar: 'http://img' });

    expect(mockRepo.update).toHaveBeenCalledWith('user-1', { avatar: 'http://img' });
  });
});

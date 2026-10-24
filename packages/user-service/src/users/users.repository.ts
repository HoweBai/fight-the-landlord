import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserEntity } from './users.entity';

@Injectable()
export class UsersRepository {
  constructor(
    @InjectRepository(UserEntity)
    private readonly repo: Repository<UserEntity>,
  ) {}

  async findByPhone(phone: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ phone });
  }

  async findById(id: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ id });
  }

  async create(data: Partial<UserEntity>): Promise<UserEntity> {
    const user = this.repo.create(data);
    return this.repo.save(user);
  }

  async update(id: string, data: Partial<UserEntity>): Promise<void> {
    await this.repo.update(id, data);
  }

  /** 昵称片：批量读昵称。调用方保证 ids 非空且 ≤ 50（接收侧已校验）。 */
  async findNicknamesByIds(ids: string[]): Promise<Array<{ id: string; nickname: string | null }>> {
    if (ids.length === 0) return [];
    return this.repo.find({ where: { id: In(ids) }, select: ['id', 'nickname'] });
  }
}

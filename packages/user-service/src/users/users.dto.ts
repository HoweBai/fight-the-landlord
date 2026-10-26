import { Transform } from 'class-transformer';
import { IsString, IsOptional, MinLength, MaxLength, Length, Matches } from 'class-validator';

/**
 * 设备指纹入参（设备绑定片）：可选、8..64、字符域 `[A-Za-z0-9._-]`
 * （逐字照客户端 `getDeviceId()` 的域规则；缺省 = 旧端/隐私模式，绑定闸 fail-open 放行不绑）。
 */
const DEVICE_ID_REGEX = /^[A-Za-z0-9._-]{8,64}$/;
const DEVICE_ID_LENGTH_MESSAGE = 'deviceId 非法：长度须为 8–64';
const DEVICE_ID_DOMAIN_MESSAGE = 'deviceId 非法：只允许字母、数字、点、下划线、短横线';

export class RegisterDto {
  @IsString()
  @MinLength(11)
  phone!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  /**
   * 昵称（昵称片，用户裁决 2026-10-17）：**必填**，trim 后 1–20 字符，**不唯一**。
   * 存量用户仍可是 `NULL`（DB 列保持可空；见设计 §2 D1）。
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: '昵称必须是字符串' })
  @MinLength(1, { message: '昵称不能为空' })
  @MaxLength(20, { message: '昵称最多 20 个字符' })
  nickname!: string;

  /** 设备绑定片：注册即首绑当前设备（开关关时服务端不读，字段允许透传）。 */
  @IsOptional()
  @IsString()
  @Length(8, 64, { message: DEVICE_ID_LENGTH_MESSAGE })
  @Matches(DEVICE_ID_REGEX, { message: DEVICE_ID_DOMAIN_MESSAGE })
  deviceId?: string;

  /**
   * 代理分润（2026-10-26）：可选邀请码；trim + 大写后交给 currency-service 重校验。
   * 格式不在 DTO 强校验（长度 1–16 即可）—— 无效码统一由下游返回 `11006`
   * 「邀请码无效」，客户端文案才能精确（DTO 的 10001 会是泛化的「请检查填写的内容」）。
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsOptional()
  @IsString()
  @Length(1, 16, { message: '邀请码长度须为 1–16' })
  inviteCode?: string;
}

export class LoginDto {
  @IsString()
  phone!: string;

  @IsString()
  password!: string;

  /** 设备绑定片：登录设备闸（无绑定行 ⇒ 静默首绑；不一致 ⇒ 11005）。 */
  @IsOptional()
  @IsString()
  @Length(8, 64, { message: DEVICE_ID_LENGTH_MESSAGE })
  @Matches(DEVICE_ID_REGEX, { message: DEVICE_ID_DOMAIN_MESSAGE })
  deviceId?: string;
}

/** §5.1：`POST /api/auth/refresh` 与 `POST /api/auth/logout` 的入参。 */
export class RefreshTokenDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;

  /** 设备绑定片：refresh 同样过设备闸（字段可选；缺省放行不绑）。 */
  @IsOptional()
  @IsString()
  @Length(8, 64, { message: DEVICE_ID_LENGTH_MESSAGE })
  @Matches(DEVICE_ID_REGEX, { message: DEVICE_ID_DOMAIN_MESSAGE })
  deviceId?: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  nickname?: string;

  @IsOptional()
  @IsString()
  avatar?: string;
}

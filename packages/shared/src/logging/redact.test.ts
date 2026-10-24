import { describe, it, expect } from 'vitest';
import {
  AD_CHANNEL_SECRET_KEYS,
  NOTIFY_CHANNEL_SECRET_KEYS,
  PAY_CHANNEL_SECRET_KEYS,
} from '@fight-the-landlord/protocol';
import { redactText, redactValue, REDACTED } from './redact';

describe('§5.5 日志脱敏（R142）', () => {
  it('手机号：保留前 3 后 4（§5.5 的示例就是 138****1234）', () => {
    expect(redactText('login phone=13812341234 ok')).toBe('login phone=138****1234 ok');
    expect(redactText('{"phone":"13900001111"}')).toBe('{"phone":"139****1111"}');
  });

  it('JWT 全文与 Bearer：整体替换（可记录 jti，但那是调用方的事）', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.abcdefghijk';
    expect(redactText(`auth header Bearer ${jwt}`)).toBe('auth header Bearer [REDACTED_JWT]');
    expect(redactText(`token=${jwt}`)).toBe('token=[REDACTED_JWT]');
  });

  it('内部头（X-Internal-Token / X-Token-Jti）的值不得记录（§5.5：X-User-Id 之外的内部头）', () => {
    expect(redactText('x-internal-token: dev-internal-token-change-in-production')).toBe(
      'x-internal-token: [REDACTED]',
    );
    expect(redactText("headers={'x-token-jti': 'jti-1', 'x-user-id': 'u1'}")).toBe(
      "headers={'x-token-jti': '[REDACTED]', 'x-user-id': 'u1'}",
    );
  });

  it('密码键（password / passwordHash / password_hash）不得记录', () => {
    expect(redactText('{"phone":"13812341234","password":"pw","passwordHash":"$2b$10$x"}')).toBe(
      '{"phone":"138****1234","password":"[REDACTED]","passwordHash":"[REDACTED]"}',
    );
  });

  /**
   * 支付片 §12（T6）：PEM 私钥块的机械层。块从 `-----BEGIN … PRIVATE KEY-----`
   * 到对应 `-----END … PRIVATE KEY-----` **整块**替换 ⇒ `[REDACTED_PRIVATE_KEY]`。
   * 含 JSON 转义形态（`\n` 两字符）；正文里的类手机号数字**不得**留下半脱敏残渣
   * （判据：PEM 规则必须排在 PHONE 等规则**之前** —— 顺序是判据的一部分）。
   */
  it('PEM 私钥块：整块 ⇒ [REDACTED_PRIVATE_KEY]（含 RSA/EC/ENCRYPTED 变体与 JSON 转义形态）', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj13812341234\n-----END PRIVATE KEY-----';
    expect(redactText(`key=${pem} done`)).toBe('key=[REDACTED_PRIVATE_KEY] done');
    expect(redactText(pem)).toBe('[REDACTED_PRIVATE_KEY]');
    expect(redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe(
      '[REDACTED_PRIVATE_KEY]',
    );
    // EC 变体（SEC1 的 `EC PRIVATE KEY` 头）：波 2 评审订正——标题含 EC 则正文须有 EC 正例
    // （`[A-Z ]*` 通配全族，EC 与 RSA/ENCRYPTED 结构等价）。
    expect(redactText('-----BEGIN EC PRIVATE KEY-----\nMHc\n-----END EC PRIVATE KEY-----')).toBe(
      '[REDACTED_PRIVATE_KEY]',
    );
    expect(redactText('-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE\n-----END ENCRYPTED PRIVATE KEY-----')).toBe(
      '[REDACTED_PRIVATE_KEY]',
    );

    // JSON 日志里的转义形态（\n 是反斜杠 + n 两个字符，不是换行）；正文数字不出残渣
    const escaped = '"alipayPrivateKey":"-----BEGIN RSA PRIVATE KEY-----\\nMIIE13812341234\\n-----END RSA PRIVATE KEY-----"';
    const out = redactText(escaped);
    expect(out).toBe('"alipayPrivateKey":"[REDACTED_PRIVATE_KEY]"');
    expect(out).not.toContain('138****1234');
  });

  it('负对照：公钥/证书块不是秘密，不得误伤；对象值经 redactValue 同规则', () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----';
    expect(redactText(pub)).toBe(pub);
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(redactText(cert)).toBe(cert);
    expect(redactText('a ----- b ----- c')).toBe('a ----- b ----- c');
    // redactValue 路径：对象里私钥块（形状命中）⇒ 替换；公钥块 ⇒ 原样
    expect(
      redactValue({ alipayPrivateKey: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----', appPublicKey: pub }),
    ).toEqual({ alipayPrivateKey: '[REDACTED_PRIVATE_KEY]', appPublicKey: pub });
  });

  /**
   * 支付配置管理化片（评审 G1）：渠道键名的结构性兜底 —— 渠道六项的私钥在日志里的
   * 形态是 **base64(PEM)**、拉取令牌是**随机串**，两者都超出 `PRIVATE_KEY_PEM` 的
   * 形状可判范围（见 redact.ts 覆盖面声明）⇒ 键名是唯一可靠的上下文。
   * 值刻意选「形状规则认不出」的串：下方判别力自证证明替换**只能**来自键名。
   */
  it('G1：渠道键名命中 —— pay.channel.privateKey / PAY_CHANNEL_PULL_TOKEN 形态 ⇒ [REDACTED]', () => {
    const base64Pem = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ';
    // 判别力自证：这两个值裸走文本规则**不变**（形状认不出）⇒ 命中只能来自键名规则
    expect(redactText(base64Pem)).toBe(base64Pem);
    const token = 'dev-pay-channel-pull-token-change-in-production';
    expect(redactText(token)).toBe(token);

    expect(
      redactValue({
        'pay.channel.privateKey': base64Pem, // ⚙️1 机密集成员的完整键名形态
        'pay.channel.appId': '9021000000000000', // 非密键：不得误伤
        PAY_CHANNEL_PULL_TOKEN: token, // env 形（下划线分隔大写）
        pullToken: 'tok-1', // 驼峰形（RPC 载荷键名）
        privateKey: 'raw-x', // 驼峰形
        private_key: 'raw-y', // 下划线形（退役 env 名 `ALIPAY_PRIVATE_KEY` 的族）
      }),
    ).toEqual({
      'pay.channel.privateKey': REDACTED,
      'pay.channel.appId': '9021000000000000',
      PAY_CHANNEL_PULL_TOKEN: REDACTED,
      pullToken: REDACTED,
      privateKey: REDACTED,
      private_key: REDACTED,
    });
  });

  it('G1 负对照：公钥与其余渠道键不得误伤；无段界的 alipayPrivateKey 仍走 PEM 文本路径', () => {
    expect(
      redactValue({
        'pay.channel.publicKey': 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A',
        'pay.channel.sellerId': '2088721087500000',
        'pay.channel.gatewayUrl': 'https://openapi.alipaydev.com/gateway.do',
      }),
    ).toEqual({
      'pay.channel.publicKey': 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A',
      'pay.channel.sellerId': '2088721087500000',
      'pay.channel.gatewayUrl': 'https://openapi.alipaydev.com/gateway.do',
    });
    // 段界规则**不得**吞掉 `alipayPrivateKey`（无 `(^|[._])` 段界）⇒ 仍交文本路径的
    // PEM 块规则（`[REDACTED_PRIVATE_KEY]` 形态；既有用例 :66-69 同判，防回归）
    expect(
      redactValue({ alipayPrivateKey: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----' }),
    ).toEqual({ alipayPrivateKey: '[REDACTED_PRIVATE_KEY]' });
  });

  /**
   * 通知通道管理化片（T10）：通知命名空间（第三键空间）**五密键全名**的键名兜底
   * （规格 §5.3#11/§1.2）。值同 G1 选法：形状规则认不出 ⇒ 命中**只能**来自键名规则。
   * ⚠️ **枚举而非通配**（本片的判别力在负侧）：非密键（host/port/user/email.to）与
   * `REDIS_URL` / `DOUZERO_URL` / 裸 `url` 一律**不得**命中。
   */
  it('T10：notify 五密键名命中 ⇒ [REDACTED]；非密键与 url 族名不命中', () => {
    const secretish = 'shape-rule-cannot-tell'; // 判别力自证：裸走文本规则不变
    expect(redactText(secretish)).toBe(secretish);

    expect(
      redactValue({
        'notify.smtp.host': 'smtp.example.com', // 非密键：不得误伤
        'notify.smtp.port': '465',
        'notify.smtp.user': 'bot@example.com',
        'notify.smtp.pass': secretish,
        'notify.email.to': 'ops@example.com', // 非密键
        'notify.webhook.feishuUrl': secretish,
        'notify.webhook.wecomUrl': secretish,
        'notify.webhook.dingtalkUrl': secretish,
        'notify.webhook.dingtalkSecret': secretish,
        REDIS_URL: 'redis://localhost:6379', // 裸 url 族：不得命中
        DOUZERO_URL: 'http://localhost:2021',
        url: 'https://example.com/hook',
      }),
    ).toEqual({
      'notify.smtp.host': 'smtp.example.com',
      'notify.smtp.port': '465',
      'notify.smtp.user': 'bot@example.com',
      'notify.smtp.pass': REDACTED,
      'notify.email.to': 'ops@example.com',
      'notify.webhook.feishuUrl': REDACTED,
      'notify.webhook.wecomUrl': REDACTED,
      'notify.webhook.dingtalkUrl': REDACTED,
      'notify.webhook.dingtalkSecret': REDACTED,
      REDIS_URL: 'redis://localhost:6379',
      DOUZERO_URL: 'http://localhost:2021',
      url: 'https://example.com/hook',
    });
  });

  /**
   * 广告片（T10）：第四键空间（广告回调）密钥名的键名兜底（规格 §2.3）。全键恰 1 枚
   * （工作名 `ad.callbackSecret`，T0-2 回填可改名——影响面 = redact 名 + 测试，低）。值同
   * G1/T10 选法：形状规则认不出 ⇒ 命中**只能**来自键名规则。
   * ⚠️ 枚举而非通配 `ad.*`：第 41 键 `ad.reliefAdpid`（参数键、在广播快照里、非秘密）
   * 一律**不得**命中（负例钉住）。
   * ⚠️ `AD_CHANNEL_PULL_TOKEN`（env 形拉取令牌）**无需**枚举加项 —— 段界规则
   * `(^|[._])pull[_]?token$` 已覆盖；下方正例一并钉住（防将来有人误删该支）。
   */
  it('T10（广告）：ad.callbackSecret 键名命中 ⇒ [REDACTED]；AD_CHANNEL_PULL_TOKEN 走段界规则；ad.reliefAdpid 不命中', () => {
    const secretish = 'shape-rule-cannot-tell'; // 判别力自证：裸走文本规则不变
    expect(redactText(secretish)).toBe(secretish);

    expect(
      redactValue({
        'ad.callbackSecret': secretish, // 第四键空间唯一键（全键 = 密键）
        AD_CHANNEL_PULL_TOKEN: secretish, // env 形（段界规则覆盖，非枚举项）
        'ad.reliefAdpid': 'abc123', // 第 41 键：参数键非秘密 ⇒ 不得误伤
      }),
    ).toEqual({
      'ad.callbackSecret': REDACTED,
      AD_CHANNEL_PULL_TOKEN: REDACTED,
      'ad.reliefAdpid': 'abc123',
    });
  });

  /**
   * W3 勘误（规格微审 v1.5 同批）：redact ↔ protocol **同步机械闸**。
   *
   * `SECRET_KEY_NAME` 的枚举式密键与 protocol 的 `PAY_CHANNEL_SECRET_KEYS` /
   * `NOTIFY_CHANNEL_SECRET_KEYS` / `AD_CHANNEL_SECRET_KEYS`（广告片 T10 入闸）是**双源**：
   * 未来新增密键只改一源 ⇒ 静默漏脱敏。
   * 方向 = protocol ⇒ redact（protocol 全量密键逐键必须被 redactValue 整值替换）。
   * 反向（redact 枚举项 ∉ protocol）不可机械枚举 —— redact 侧另有段界/通配支
   * （`privateKey` / `pullToken` / `password` 族），并非全部来自 protocol 名单。
   *
   * 判别力：探针值刻意选「形状规则认不出」的串 ⇒ 逐键的 `[REDACTED]` **只能**来自
   * 键名规则（下方先自证裸走 redactText 不变）。**任何一源新增而另一源漏改 ⇒ 当场红。**
   */
  it('W3 同步闸：protocol 全量密键（pay ×1 + notify ×5 + ad ×1）逐键经 redactValue ⇒ [REDACTED]', () => {
    const probe = 'shape-rule-cannot-tell'; // 判别力自证：裸走文本规则不变
    expect(redactText(probe)).toBe(probe);

    const keys = [...PAY_CHANNEL_SECRET_KEYS, ...NOTIFY_CHANNEL_SECRET_KEYS, ...AD_CHANNEL_SECRET_KEYS];
    // 空集会把逐键断言静默退化成空转（闸失效）——先钉非空。
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(redactValue({ [key]: probe }), `密键 ${key} 须命中键名规则`).toEqual({ [key]: REDACTED });
    }
  });

  it('手牌类键整体替换，只留张数（对账表 S7：至少覆盖手牌）', () => {
    expect(redactText('move={"cards":[3,4,5],"hand":[7,8]}')).toBe(
      'move={"cards":"[REDACTED 3 cards]","hand":"[REDACTED 2 cards]"}',
    );
    expect(redactText('{"bottomCards":[17,20,30],"actionLog":[]}')).toBe(
      '{"bottomCards":"[REDACTED 3 cards]","actionLog":"[REDACTED 0 cards]"}',
    );
  });

  it('负对照：普通数字、ID、座位号不得被误伤', () => {
    expect(redactText('room=ABC123 seat=2 version=41 cards=3')).toBe('room=ABC123 seat=2 version=41 cards=3');
    expect(redactText('bot p_12345678 decided 2 cards')).toBe('bot p_12345678 decided 2 cards');
    expect(redactText('cardCounts=[17,17,17]')).toBe('cardCounts=[17,17,17]');
  });

  /**
   * R142 的正对照：证明这套规则**真的**在「有东西可脱敏」时生效，而不是
   * 「一个都没命中所以看起来干净」（切片 8 的 R115 教训）。
   * 同时也是**负对照的补集**：`X-User-Id` 是 §5.5 明确允许记录的（排障需要）。
   */
  it('正对照：确实命中了（`X-User-Id` 不脱敏，其余敏感项都变）', () => {
    const line =
      'user=x-user-id: u1 token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.abcdefghijk phone=13812341234 password=pw';
    const out = redactText(line);

    expect(out).toContain('x-user-id: u1'); // 允许记录，排障需要
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).toContain('138****1234');
    expect(out).toContain(`${REDACTED}`);
    expect(out).not.toContain('13812341234');
    expect(out).not.toContain('abcdefghijk');
  });

  it('redactValue：按键名递归脱敏对象与数组（JSON 日志的实际入口）', () => {
    expect(
      redactValue({
        userId: 'u1',
        password: 'pw',
        hand: [3, 4, 5],
        nested: { cards: [7], phone: '13812341234' },
        list: [{ passwordHash: '$2b$10$x' }],
      }),
    ).toEqual({
      userId: 'u1',
      password: REDACTED,
      hand: '[REDACTED 3 cards]',
      nested: { cards: '[REDACTED 1 cards]', phone: '138****1234' },
      list: [{ passwordHash: REDACTED }],
    });
  });

  it('redactValue：深度超限时整体替换（防止循环/超深结构把日志打爆）', () => {
    let deep: unknown = 'hand=[1,2]';
    for (let i = 0; i < 10; i += 1) deep = { a: deep };
    const out = JSON.stringify(redactValue(deep));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('hand');
  });
});

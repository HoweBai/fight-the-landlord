import { describe, expect, it } from 'vitest';
import { NOTIFY_CHANNEL_KEYS, type NotifyChannelKey } from '@fight-the-landlord/protocol';
import {
  urlHint,
  validateAndNormalize,
  type NotifyChannelValidation,
} from '../src/notify-channel/notify-channel.validators';

/**
 * 通知九键校验/规范化 + urlHint 单测（规格 §2.4 校验矩阵与 hint 规则**逐格**；§2.3 canonical 口径；
 * §2.9 理由纪律）。
 *
 * 关键判据（§5.1.1）：
 *  - 九键矩阵正反逐格：host 正则/port 范围/user 空白/pass 控制字符/email.to 逗号列表逐项/URL http(s)/
 *    dingtalkSecret 空白/各键上限边界（253·254·512·2048·256；email 项 254）；
 *  - **canonical = 「唯一变换 = trim」**：URL 逐字保真（不剥尾斜杠、不低改大小写）——与支付片有意不同规；
 *  - **理由文本不含输入值**：喂含标记串 `ZZMARKERZZ` 的坏值 ⇒ 断言 reason 无该串（§2.9）；
 *  - `urlHint`：三平台域全等（含默认端口形态/混合大小写）⇒ origin；仿冒两负例
 *    （`evilqyapi.weixin.qq.com.hk`、`qyapi.weixin.qq.com.evil.com`）⇒「外部地址」；非 URL ⇒ null。
 *
 * 空串预检说明：§2.4 表注「全键先 trim」，trim 后空串的拒绝理由取表内逐字文案 `值不得为空`
 * （host 行第三理由；照 `pay-channel.validators.ts` 六键统一预检的同形先例）。
 */

/** 期望通过：返回 canonical。 */
function expectOk(result: NotifyChannelValidation): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`期望通过，实际拒绝：${result.reason}`);
  return result.canonical;
}

/**
 * 期望拒绝：断言 ok=false、reason 非空、**不含任何输入值片段**（标记串恒不在 reason 中；
 * §2.9——400 message 会回显到管理页/日志，值可能含密钥材料）。
 */
function expectReject(result: NotifyChannelValidation, ...requiredFragments: string[]): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`期望拒绝，实际通过：${result.canonical}`);
  expect(result.reason.length).toBeGreaterThan(0);
  expect(result.reason).not.toContain('ZZMARKERZZ');
  for (const fragment of requiredFragments) expect(result.reason).toContain(fragment);
  return result.reason;
}

const URL_KEYS = [
  'notify.webhook.feishuUrl',
  'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl',
] as const;

describe('通知九键校验/规范化（规格 §2.4 矩阵逐格）', () => {
  it('统一前置：全键先 trim；空串/纯空白 ⇒ 拒（理由「值不得为空」）', () => {
    for (const key of NOTIFY_CHANNEL_KEYS) {
      expect(validateAndNormalize(key, ''), key).toEqual({ ok: false, reason: '值不得为空' });
      expect(validateAndNormalize(key, '   \t \n '), key).toEqual({ ok: false, reason: '值不得为空' });
    }
  });

  it('smtp.host：合法主机名（字母/数字/点/横线）⇒ canonical = trim 原文（大小写逐字保留）', () => {
    const cases: Array<[string, string]> = [
      ['smtp.example.com', 'smtp.example.com'],
      ['smtp.qq.com', 'smtp.qq.com'],
      ['a-b.example', 'a-b.example'], // 标签内横线合法（非首尾）
      ['smtp.invalid', 'smtp.invalid'],
      ['mail.example.co.uk', 'mail.example.co.uk'],
      ['localhost', 'localhost'], // 单标签：≥1 字母数字即可（v1.7 未要求含点）
      ['127.0.0.1', '127.0.0.1'],
      ['A-B.example.com', 'A-B.example.com'],
      ['SMTP.Example.COM', 'SMTP.Example.COM'], // canonical 不改写大小写（唯一变换 = trim）
      ['  smtp.example.com  ', 'smtp.example.com'], // 先 trim
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize('notify.smtp.host', raw)), raw).toBe(canonical);
    }
  });

  it('smtp.host：非法字符（下划线/空格/冒号/中文/符号）⇒ 拒', () => {
    const bad = [
      'smtp_example.com',
      'smtp example.com',
      'smtp.example.com:465',
      '中文.example.cn',
      'smtp!example.com',
      'smtp~example.com',
      'smtp/example.com',
    ];
    for (const raw of bad) {
      expect(validateAndNormalize('notify.smtp.host', raw)).toEqual({
        ok: false,
        reason: '必须是合法主机名（字母/数字/点/横线）',
      });
    }
  });

  it('smtp.host：v1.7 收紧判别性负例——裸点串/首尾点/首尾横线 ⇒ 拒（W3 勘误；旧式正则全部放行）', () => {
    // 旧式 `^[A-Za-z0-9.-]+$` 对这 7 个串全放行（W3 深扫实证 `...` ⇒ 邮件静默死且完整性规则不响）；
    // 新式要求每标签 ≥1 字母数字、首尾均字母数字（点仅作标签分隔）⇒ 全部拒。
    const bad = ['...', '..', '-', '.a', 'a.', 'a..b', 'a-.b'];
    for (const raw of bad) {
      expect(validateAndNormalize('notify.smtp.host', raw), raw).toEqual({
        ok: false,
        reason: '必须是合法主机名（字母/数字/点/横线）',
      });
    }
  });

  it('smtp.host：长度边界——253 过 / 254 拒（「长度超过上限 253」）', () => {
    const atLimit = 'a'.repeat(253);
    expect(expectOk(validateAndNormalize('notify.smtp.host', atLimit))).toBe(atLimit);
    expect(validateAndNormalize('notify.smtp.host', 'a'.repeat(254))).toEqual({
      ok: false,
      reason: '长度超过上限 253',
    });
  });

  it('smtp.port：1–65535 数字串 ⇒ canonical = trim 原文（前导零不改写）', () => {
    const cases: Array<[string, string]> = [
      ['1', '1'],
      ['80', '80'],
      ['465', '465'],
      ['587', '587'],
      ['65535', '65535'],
      [' 465 ', '465'],
      ['0465', '0465'], // canonical = trim 原文数字串——不做数值归一（「唯一变换 = trim」）
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize('notify.smtp.port', raw)), raw).toBe(canonical);
    }
  });

  it('smtp.port：0/超范围/超 5 位/非数字/小数/符号/全角 ⇒ 拒（「必须是 1-65535 的端口号」）', () => {
    const bad = ['0', '00', '00000', '65536', '99999', '123456', '465.0', '4650a', 'a465', '-1', '+465', '４６５'];
    for (const raw of bad) {
      expect(validateAndNormalize('notify.smtp.port', raw)).toEqual({
        ok: false,
        reason: '必须是 1-65535 的端口号',
      });
    }
  });

  it('smtp.user：非空、无空白、≤254 ⇒ canonical = trim 原文', () => {
    const cases: Array<[string, string]> = [
      ['probe@example.invalid', 'probe@example.invalid'],
      ['user.name+tag', 'user.name+tag'],
      ['u$er"quote', 'u$er"quote'],
      ['  probe@example.invalid  ', 'probe@example.invalid'],
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize('notify.smtp.user', raw)), raw).toBe(canonical);
    }
    const atLimit = 'a'.repeat(254);
    expect(expectOk(validateAndNormalize('notify.smtp.user', atLimit))).toBe(atLimit);
  });

  it('smtp.user：含空白（空格/制表/换行/NBSP——逐字 `\\s`）⇒ 拒；255 位 ⇒ 超长理由', () => {
    for (const raw of ['probe @example.invalid', 'a\tb', 'a\nb', 'a\u00a0b']) {
      expect(validateAndNormalize('notify.smtp.user', raw)).toEqual({
        ok: false,
        reason: '不得包含空白字符',
      });
    }
    expect(validateAndNormalize('notify.smtp.user', 'a'.repeat(255))).toEqual({
      ok: false,
      reason: '长度超过上限 254',
    });
  });

  it('smtp.pass：无控制字符 ⇒ 接受（**含空格**——空格非控制字符）；canonical = trim 原文', () => {
    const cases: Array<[string, string]> = [
      ['abcdefg', 'abcdefg'],
      ['p@ss w0rd!', 'p@ss w0rd!'], // 空格（ ）不是控制字符 ⇒ 授权码合法
      ['  secret code  ', 'secret code'],
      ['!@#$%^&*()_-+=~.,<>?/|', '!@#$%^&*()_-+=~.,<>?/|'],
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize('notify.smtp.pass', raw)), raw).toBe(canonical);
    }
    const atLimit = 'a'.repeat(512);
    expect(expectOk(validateAndNormalize('notify.smtp.pass', atLimit))).toBe(atLimit);
  });

  it('smtp.pass：控制字符（\\t\\n\\r / \\u0000 / \\u007f / \\u001f）⇒ 拒；513 位 ⇒ 超长', () => {
    const controls = ['line1\nline2', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u001fb'];
    for (const raw of controls) {
      expect(validateAndNormalize('notify.smtp.pass', raw)).toEqual({
        ok: false,
        reason: '授权码不得包含换行或控制字符',
      });
    }
    expect(validateAndNormalize('notify.smtp.pass', 'a'.repeat(513))).toEqual({
      ok: false,
      reason: '长度超过上限 512',
    });
  });

  it('email.to：逗号分隔逐项 ⇒ canonical = 逐项 trim 后 "," 连接', () => {
    const cases: Array<[string, string]> = [
      ['probe@example.invalid', 'probe@example.invalid'],
      ['a@b.c,d@e.f', 'a@b.c,d@e.f'],
      [' a@b.c , d@e.f ', 'a@b.c,d@e.f'],
      ['x1@example.com, x2@example.com,x3@example.com', 'x1@example.com,x2@example.com,x3@example.com'],
      ['a@b', 'a@b'], // 无 TLD 也过（`^[^\s@,]+@[^\s@,]+$` 逐字——保留今天 to: 直填语义）
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize('notify.email.to', raw)), raw).toBe(canonical);
    }
  });

  it('email.to：坏项（缺 @/多 @/空项/含空白/逗号内嵌）⇒ 拒「收件地址格式不合法（单个或逗号分隔列表）」', () => {
    const bad = [
      'not-an-email',
      'a@',
      '@b.c',
      'a@b@c.d',
      'a b@c.d',
      'a@b c.d',
      ',a@b.c',
      'a@b.c,',
      'a@b.c,,d@e.f',
      'a,b@c.d',
    ];
    for (const raw of bad) {
      expect(validateAndNormalize('notify.email.to', raw)).toEqual({
        ok: false,
        reason: '收件地址格式不合法（单个或逗号分隔列表）',
      });
    }
  });

  it('email.to：项长度 ≤254（逐项）——254 过 / 255 拒 / 列表第二项超长同拒', () => {
    const atLimit = 'a'.repeat(252) + '@b'; // 恰 254
    expect(expectOk(validateAndNormalize('notify.email.to', atLimit))).toBe(atLimit);
    expect(validateAndNormalize('notify.email.to', 'a'.repeat(253) + '@b')).toEqual({
      ok: false,
      reason: '长度超过上限 254',
    });
    expect(validateAndNormalize('notify.email.to', 'ok@b.c,' + 'a'.repeat(253) + '@b')).toEqual({
      ok: false,
      reason: '长度超过上限 254',
    });
  });

  it('三 URL 键：http(s) 合法 ⇒ canonical = trim 原文（**不**剥尾斜杠、**不**低改大小写）', () => {
    const cases: Array<[string, string]> = [
      [
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
      ],
      ['http://ftl-stub:8801/hook', 'http://ftl-stub:8801/hook'],
      ['  https://example.com/hook  ', 'https://example.com/hook'],
      ['https://example.com/hook/', 'https://example.com/hook/'], // 尾斜杠保留（≠ 支付片剥尾斜杠规则——URL 不改写）
      ['HTTPS://EXAMPLE.com/A', 'HTTPS://EXAMPLE.com/A'], // 不低改协议/主机大小写
    ];
    for (const key of URL_KEYS) {
      for (const [raw, canonical] of cases) {
        expect(expectOk(validateAndNormalize(key, raw)), `${key} ${raw}`).toBe(canonical);
      }
    }
  });

  it('三 URL 键：坏 URL / 非 http(s) 协议 ⇒ 拒「必须是 http/https 协议的合法 URL」', () => {
    const bad = [
      'not-a-url',
      'ftp://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:a@b.c',
      '//example.com/hook',
      'https://',
      'qyapi.weixin.qq.com',
    ];
    for (const key of URL_KEYS) {
      for (const raw of bad) {
        expect(validateAndNormalize(key, raw), `${key} ${raw}`).toEqual({
          ok: false,
          reason: '必须是 http/https 协议的合法 URL',
        });
      }
    }
  });

  it('三 URL 键：2048 边界——2048 过 / 2049 拒（「长度超过上限 2048」）', () => {
    const prefix = 'https://e.co/'; // 13 字符
    const atLimit = prefix + 'a'.repeat(2048 - prefix.length);
    const overLimit = prefix + 'a'.repeat(2049 - prefix.length);
    for (const key of URL_KEYS) {
      expect(expectOk(validateAndNormalize(key, atLimit)).length).toBe(2048);
      expect(validateAndNormalize(key, overLimit)).toEqual({
        ok: false,
        reason: '长度超过上限 2048',
      });
    }
  });

  it('dingtalkSecret：非空、无空白、≤256 ⇒ canonical = trim 原文', () => {
    const cases: Array<[string, string]> = [
      ['SEC0123456789abcdef0123456789abcdef', 'SEC0123456789abcdef0123456789abcdef'],
      ['  SECabc  ', 'SECabc'],
      ['s3cr3t!@#$%^&*()', 's3cr3t!@#$%^&*()'],
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize('notify.webhook.dingtalkSecret', raw)), raw).toBe(canonical);
    }
    const atLimit = 'a'.repeat(256);
    expect(expectOk(validateAndNormalize('notify.webhook.dingtalkSecret', atLimit))).toBe(atLimit);
  });

  it('dingtalkSecret：含空白 ⇒ 拒「不得包含空白字符」；257 位 ⇒ 「长度超过上限 256」', () => {
    for (const raw of ['abc def', 'a\tb', 'a\nb']) {
      expect(validateAndNormalize('notify.webhook.dingtalkSecret', raw)).toEqual({
        ok: false,
        reason: '不得包含空白字符',
      });
    }
    expect(validateAndNormalize('notify.webhook.dingtalkSecret', 'a'.repeat(257))).toEqual({
      ok: false,
      reason: '长度超过上限 256',
    });
  });

  it('理由文案不含输入值（§2.9）：九键坏值（含标记串）⇒ reason 无任何输入片段', () => {
    const marked: Array<[NotifyChannelKey, string]> = [
      ['notify.smtp.host', 'ZZMARKERZZ!'],
      ['notify.smtp.host', 'ZZMARKERZZ.'.repeat(23) + 'ZZMARKERZZ'], // 正则过、超长支路（v1.7：尾点构造已过不了新正则 ⇒ 改为无尾点 263 长）
      ['notify.smtp.port', 'ZZMARKERZZ'],
      ['notify.smtp.user', 'ZZMARKERZZ ZZ'],
      ['notify.smtp.user', 'ZZMARKERZZ'.repeat(30)], // 无空白、超长支路
      ['notify.smtp.pass', 'ZZMARKERZZ\nZZ'],
      ['notify.smtp.pass', 'ZZMARKERZZ'.repeat(60)], // 超长支路
      ['notify.email.to', 'ZZMARKERZZ'],
      ['notify.email.to', 'ok@b.c,' + 'ZZMARKERZZ' + 'a'.repeat(288) + '@b'], // 第二项超长支路
      ['notify.webhook.feishuUrl', 'ZZMARKERZZ'],
      ['notify.webhook.feishuUrl', 'https://e.co/' + 'ZZMARKERZZ' + 'a'.repeat(2100)], // 超长支路
      ['notify.webhook.wecomUrl', 'ZZMARKERZZ://host/'], // 可解析但协议非 http(s)
      ['notify.webhook.dingtalkUrl', 'ZZMARKERZZ'],
      ['notify.webhook.dingtalkSecret', 'ZZMARKERZZ ZZ'],
      ['notify.webhook.dingtalkSecret', 'ZZMARKERZZ'.repeat(30)],
    ];
    for (const [key, raw] of marked) {
      const reason = expectReject(validateAndNormalize(key, raw)); // expectReject 内含 not.toContain(标记)
      expect(reason).not.toContain(raw); // 更强：整条输入也不在理由里
    }
    // 超长支路的分支证明（理由指向上限而非解析/格式/空白失败）：
    expectReject(validateAndNormalize('notify.smtp.host', 'ZZMARKERZZ.'.repeat(23) + 'ZZMARKERZZ'), '253');
    expectReject(validateAndNormalize('notify.smtp.pass', 'ZZMARKERZZ'.repeat(60)), '512');
    expectReject(validateAndNormalize('notify.webhook.feishuUrl', 'https://e.co/' + 'ZZMARKERZZ' + 'a'.repeat(2100)), '2048');
    expectReject(validateAndNormalize('notify.webhook.dingtalkSecret', 'ZZMARKERZZ'.repeat(30)), '256');
  });

  it('幂等：对 canonical 再校验 ⇒ 同 canonical（九键样例）', () => {
    const samples: Array<[NotifyChannelKey, string]> = [
      ['notify.smtp.host', '  smtp.example.com  '],
      ['notify.smtp.port', ' 465 '],
      ['notify.smtp.user', ' probe@example.invalid '],
      ['notify.smtp.pass', ' secret code '],
      ['notify.email.to', ' a@b.c , d@e.f '],
      ['notify.webhook.feishuUrl', ' https://open.feishu.cn/hook '],
      ['notify.webhook.wecomUrl', ' http://ftl-stub:8801/wecom '],
      ['notify.webhook.dingtalkUrl', ' https://oapi.dingtalk.com/robot/send?access_token=t '],
      ['notify.webhook.dingtalkSecret', ' SECabc '],
    ];
    for (const [key, raw] of samples) {
      const first = expectOk(validateAndNormalize(key, raw));
      expect(expectOk(validateAndNormalize(key, first)), key).toBe(first);
    }
  });
});

describe('urlHint（§2.4 hint 规则逐字：三平台 allowlist 全等 ⇒ origin；否则「外部地址」）', () => {
  it('三平台域 ⇒ origin（WHATWG 小写归一；默认端口被删——含端口形态仍命中）', () => {
    expect(urlHint('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc')).toBe('https://qyapi.weixin.qq.com');
    expect(urlHint('http://qyapi.weixin.qq.com/hook')).toBe('http://qyapi.weixin.qq.com');
    expect(urlHint('https://open.feishu.cn/open-apis/bot/v2/hook/xyz')).toBe('https://open.feishu.cn');
    expect(urlHint('https://oapi.dingtalk.com/robot/send?access_token=t')).toBe('https://oapi.dingtalk.com');
    expect(urlHint('https://QYAPI.WEIXIN.QQ.COM/hook')).toBe('https://qyapi.weixin.qq.com'); // host 小写归一后全等
    expect(urlHint('https://qyapi.weixin.qq.com:443/hook')).toBe('https://qyapi.weixin.qq.com'); // https 默认端口被 WHATWG 删 ⇒ 仍全等
    expect(urlHint('http://qyapi.weixin.qq.com:80/hook')).toBe('http://qyapi.weixin.qq.com'); // http 默认端口同理
  });

  it('非三平台（含显式非默认端口使 .host 带端口）⇒「外部地址」', () => {
    expect(urlHint('https://example.com/hook')).toBe('外部地址');
    expect(urlHint('http://ftl-stub:8801/hook')).toBe('外部地址');
    expect(urlHint('https://qyapi.weixin.qq.com:8443/hook')).toBe('外部地址'); // 规格逐字 = `.host` 全等 ⇒ 非默认端口不命中
    expect(urlHint('https://open.feishu.cn:8443/hook')).toBe('外部地址');
  });

  it('仿冒变体负例（endsWith/includes 类）⇒「外部地址」（allowlist 全等）', () => {
    expect(urlHint('https://evilqyapi.weixin.qq.com.hk/h')).toBe('外部地址'); // 后缀域
    expect(urlHint('https://qyapi.weixin.qq.com.evil.com/h')).toBe('外部地址'); // 前缀子域式
    expect(urlHint('https://sub.qyapi.weixin.qq.com/h')).toBe('外部地址'); // 真子域：全等 ⇒ 同样不命中
    expect(urlHint('https://evqyapi.weixin.qq.com/h')).toBe('外部地址');
    expect(urlHint('https://notopen.feishu.cn/h')).toBe('外部地址');
    expect(urlHint('https://oapi.dingtalk.com.evil.hk/h')).toBe('外部地址');
  });

  it('非 URL / 解析失败 ⇒ null（防御支路；调用侧只对三 URL 键调用）', () => {
    for (const v of ['', 'not-a-url', '/relative/path', 'https://', 'qyapi.weixin.qq.com', 'ZZMARKERZZ']) {
      expect(urlHint(v), v).toBeNull();
    }
  });
});

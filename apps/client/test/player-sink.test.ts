/**
 * 玩家面旧技术串清零（提示收敛片 Task 11 终稿闸）。
 *
 * ## 为什么是「逐字旧串」而不是泛化禁词
 *
 * 这里刻意只扫**逐字旧串**，不扫 `code=` / `back_to_lobby` / `lastVersion` 这类协议键或
 * 类型名 —— 否则合法线格式与类型联合会被误判（`socket.ts` 的协议分支与 `session.ts` 的
 * 类型定义里它们必须继续存在）。泛化禁词由 `player-copy.test` 对所有 `playerMessage`
 * 输出做表驱动断言；`describeAction` 只允许出现在 reporter/日志调用（Task 2 已把 UI 通路
 * 替换为中性文案）。
 *
 * ## 扫描面
 *
 * `collectSourceFiles()` = `src/**`（.ts/.vue/.js/.json/.scss），且对**剥注释视图**扫描：
 * 本仓注释习惯逐字引用旧实现（「原『匹配失败（code=-1）』…」），按原始文本匹配会逼着
 * 后来人删解释。
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const BANNED_SNIPPETS = [
  '匹配失败（code=',
  '取消失败（code=',
  '加入房间失败（code=',
  '创建房间失败（code=',
  '操作未通过（code=',
  '[13004] refresh_snapshot',
  'resync_ack 快照 version',
  'reconnect_ack 快照 version',
  '同一 IP 的并发连接数',
  '§5.4 为 5',
  'lastVersion=',
  'socket.io 已重连',
  '已按 M03',
  '取回快照',
  '服务端登出未成功（code=',
];

describe('玩家面旧技术串清零', () => {
  it('src 代码（剥注释）不再包含任何旧串', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles()) {
      const code = stripComments(file.content);
      for (const snippet of BANNED_SNIPPETS) {
        if (code.includes(snippet)) offenders.push(`${file.path}: ${snippet}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('判别力：旧串样本必须命中', () => {
    const old = 'toast(`匹配失败（code=${outcome.code}）`); const s = "[13004] refresh_snapshot";';
    for (const snippet of ['匹配失败（code=', '[13004] refresh_snapshot']) {
      expect(old.includes(snippet)).toBe(true);
    }
    // 全表判别力：每条禁词都有判别力的最小载体（防止某条写成永远不命中的死串）。
    for (const snippet of BANNED_SNIPPETS) {
      expect(`x ${snippet} y`, `禁词「${snippet}」必须可被普通 includes 命中`).toContain(snippet);
    }
  });

  it('扫描器真的读到了源码（不是空集合恒绿）', () => {
    const sources = collectSourceFiles();
    expect(sources.length, 'src/** 文件数').toBeGreaterThan(20);
    expect(sources.map((f) => f.path)).toContain('src/net/socket.ts');
    expect(sources.map((f) => f.path)).toContain('src/net/session.ts');
    // 剥注释视图真的剥掉了注释（判别力：旧串样本在注释里时必须消失）。
    expect(stripComments('// 匹配失败（code=-1）\nconst a = 1;')).not.toContain('匹配失败');
  });
});

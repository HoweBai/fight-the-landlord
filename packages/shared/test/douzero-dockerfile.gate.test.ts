/**
 * **J31 机械闸（片② D7 层 1）**：`douzero/Dockerfile` 的九条 `test -f` 断言必须落在
 * **runtime 段**（最后一段）的 `COPY --from=builder /app/models` **之后**。
 *
 * ─── 它守的是什么（设计层 v8-6）─────────────────────────────────────────
 * `COPY` 是**目录拷贝，缺文件不报错** —— 构建期文件系统断言是出货前的唯一防线。
 * 但放进 builder 段只验「**构建上下文**里的 models/」；真正出货的是 runtime 段
 * `COPY --from=builder /app/models` **拷过去的那一份**。落点写错（builder 段）
 * 断言照样绿、缺文件照样出货 ⇒ 逐条来源的错实现，必须用机械闸钉住。
 *
 * ─── 判据 ──────────────────────────────────────────────────────────────
 *  ① brief 口径：`test -f /app/models/sl/landlord.onnx` 在最后一段的
 *     `COPY --from=builder /app/models` 之后（indexOf 比较）；
 *  ② 设计层口径：**九条路径**（3 档 × 3 位置）逐条点名，全部在 runtime 段；
 *     且全文件的 `test -f` 数量 == runtime 段的数量（builder/更早段**零命中**）。
 *
 * ─── 判别力自证 ────────────────────────────────────────────────────────
 *  - stage 切分按行首 `FROM `；**先剥 `#` 注释行**（注释里的 `FROM ` 不得切开分层）；
 *  - 喂「错实现」样本：`test -f` 留在 builder 段 ⇒ 必红（runtime 段找不到它）；
 *  - 喂「段内顺序错」样本：`test -f` 写在 COPY 之前 ⇒ indexOf 比较必红。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 从本文件所在目录向上找仓库根（锚 = `packages/shared` + `packages/protocol`；找不到抛错）。 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const anchor = join(dir, 'packages', 'shared', 'package.json');
    const second = join(dir, 'packages', 'protocol', 'package.json');
    if (
      existsSync(anchor) &&
      existsSync(second) &&
      statSync(anchor).isFile() &&
      readFileSync(anchor, 'utf-8').includes('"name": "@fight-the-landlord/shared"')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（锚 = packages/shared/package.json 且 name 校验通过 + packages/protocol）');
}

const REPO = findRepoRoot();
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8');

/** 剥 Dockerfile 的整行注释（`#` 起头，含缩进）——注释里的 `FROM ` / `test -f` 不得参与判据。 */
function stripDockerComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, ''))
    .join('\n');
}

/** 最后一个 stage（runtime 段）的全文：按**行首** `FROM ` 切分，取最后一段。 */
function lastStageOf(dockerfile: string): string {
  const stages = stripDockerComments(dockerfile).split(/^FROM /m);
  return stages[stages.length - 1];
}

/** 九条出货断言（3 档 × 3 位置），逐条点名。 */
const NINE_MODEL_PATHS = (['sl', 'douzero_WP', 'douzero_ADP'] as const).flatMap((model) =>
  (['landlord', 'landlord_down', 'landlord_up'] as const).map(
    (position) => `test -f /app/models/${model}/${position}.onnx`,
  ),
);

const DOCKERFILE = read('douzero/Dockerfile');

describe('J31：douzero 的九条 test -f 必须落在 runtime 段（片② D7 层 1）', () => {
  it('brief 口径：`test -f /app/models/sl/landlord.onnx` 在最后一段的 `COPY --from=builder /app/models` 之后', () => {
    const last = lastStageOf(DOCKERFILE);
    expect(last).toMatch(/COPY --from=builder \/app\/models/);
    expect(last.indexOf('test -f /app/models/sl/landlord.onnx')).toBeGreaterThan(
      last.indexOf('COPY --from=builder /app/models'),
    );
  });

  it('设计层口径：九条路径逐条点名且都在 runtime 段（更早段零命中）', () => {
    const last = lastStageOf(DOCKERFILE);
    for (const assertion of NINE_MODEL_PATHS) {
      expect(last, `runtime 段缺 ${assertion}`).toContain(assertion);
    }
    const all = DOCKERFILE.match(/test -f \/app\/models\//g) ?? [];
    const inLast = last.match(/test -f \/app\/models\//g) ?? [];
    expect(inLast).toHaveLength(9);
    // 全文件的 test -f 都在这段 ⇒ builder/更早段零命中（放进 builder 段 = 逐条来源的错实现）
    expect(all).toHaveLength(inLast.length);
  });

  it('判别力自证：错实现样本（test -f 留在 builder 段 / 段内顺序错）各自必红；注释不干扰分层', () => {
    // 正对照：正确形态
    const good = [
      'FROM python AS builder',
      'COPY models/ ./models/',
      'FROM python',
      'COPY --from=builder /app/models /app/models',
      'RUN test -f /app/models/sl/landlord.onnx',
    ].join('\n');
    const lastGood = lastStageOf(good);
    expect(lastGood).toContain('COPY --from=builder /app/models');
    expect(lastGood).toContain('test -f /app/models/sl/landlord.onnx');

    // 错实现①：断言留在 builder 段（只验构建上下文）⇒ runtime 段找不到它 ⇒ indexOf = -1 ⇒ 必红
    const inBuilder = [
      'FROM python AS builder',
      'COPY models/ ./models/',
      'RUN test -f /app/models/sl/landlord.onnx',
      'FROM python',
      'COPY --from=builder /app/models /app/models',
    ].join('\n');
    expect(lastStageOf(inBuilder)).not.toContain('test -f /app/models/sl/landlord.onnx');

    // 错实现②：段内顺序错（test -f 写在 COPY 之前）⇒ indexOf 比较必红
    const wrongOrder = [
      'FROM python',
      'RUN test -f /app/models/sl/landlord.onnx',
      'COPY --from=builder /app/models /app/models',
    ].join('\n');
    const lastWrong = lastStageOf(wrongOrder);
    expect(lastWrong.indexOf('test -f /app/models/sl/landlord.onnx')).toBeLessThan(
      lastWrong.indexOf('COPY --from=builder /app/models'),
    );

    // 注释行里的 `FROM ` 不得切开分层（剥注释先行）
    const commented = ['FROM python AS builder', '# FROM fake-stage', 'FROM python', 'RUN keepme'].join('\n');
    expect(stripDockerComments(commented).split(/^FROM /m)).toHaveLength(3); // 两个 FROM ⇒ 三段（含首段空）
    expect(lastStageOf(commented)).toContain('RUN keepme');
  });
});

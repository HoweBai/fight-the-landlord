/**
 * 仓库相对路径的**跨平台归一化**（分隔符恒为 `/`）。
 *
 * ## 为什么需要它
 *
 * 本目录下的机械闸（`*.gate.test.ts`）普遍这样取相对路径：
 *
 * ```ts
 * const REPO = fileURLToPath(new URL('../../..', import.meta.url)); // 恒以分隔符结尾
 * walk(join(REPO, 'packages', pkg, 'src')).map((f) => f.slice(REPO.length));
 * ```
 *
 * 这在 **Linux 上得到 `/` 分隔**，而判据里的白名单与期望清单**正是按 `/` 写成的**：
 *
 * - `no-raw-console.test.ts` 的 `ALLOWED.has(rel)`（白名单是 `packages/…/main.ts`）
 * - `container-assembly.gate.test.ts` 的 `expect(…map(m => m.file).sort()).toEqual([…])`
 * - `outbound-timeout.gate.test.ts` 的 `fetchSources()` 与 `MIGRATED_TO_RPC` 比对
 *
 * **Windows 上切片得到 `packages\api-gateway\src\main.ts`**（实测确认）⇒
 * `Set.has()` / `toContain()` / `toEqual([...])` **全部落空**，
 * 症状是「把合法文件判成违规」——实测 `no-raw-console` 把 5 个 `main.ts` **全报了出来**：
 *
 * ```
 * expected [ …(5) ] to deeply equal []
 * + "packages\\api-gateway\\src\\main.ts"   ← 正是白名单里的那 5 个
 * ```
 *
 * ## 它**不**做什么
 *
 * 归一化只改**表示**，不改判据强度：真违规的文件在两种平台下都仍会被报出，
 * 各闸原有的「正对照 / 判别力自证」一条都不放宽（R435 的约束）。
 *
 * ## 为什么是 `.split('\\')` 而不是 `split(sep)`
 *
 * 与既有的可用范例 `apps/client/test/helpers/source-scan.ts:44` 逐字一致
 * （那边一直是 `relative(APP_ROOT, full).split('\\').join('/')`，这也是客户端测试
 * 在 Windows 上能过的原因）。`\` 在 POSIX 路径里不是分隔符 ⇒ 该变换在 Linux 上是**恒等**的，
 * 因此同一份代码两个平台都对。
 *
 * ⚠️ **只用于「已经是仓库相对路径」的字符串**，不要把它当成 `path.relative()` 的替代：
 * 本函数**不做切片**。调用方各自负责先把绝对路径变成相对路径
 * （`slice(REPO.length)` 或 `relative(REPO_ROOT, f)`——后者更稳，不依赖结尾分隔符）。
 */
export const toPosixPath = (repoRelative: string): string => repoRelative.split('\\').join('/');

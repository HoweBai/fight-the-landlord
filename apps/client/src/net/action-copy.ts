/**
 * 对局动作文案：保留既有导出名，实际由 `copy.ts` 的统一表派生。
 * 只允许 import protocol + `./copy`（不得 import store/页面/规则面）。
 */
export { actionCopyFor, actionErrorMessage } from './copy';

import type { LogRecord } from './log-record';

/**
 * 测试用捕获 sink：把所有记录留在数组里。
 * 判据"这条日志带没带上上下文"就靠它（不需要真的去抓 stdout）。
 */
export function createCapturingSink(): { sink: (record: LogRecord) => void; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (record) => void records.push(record), records };
}

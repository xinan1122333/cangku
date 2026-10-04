import type { DatabaseSync } from 'node:sqlite';
import { getDb } from './db';

/**
 * 单调递增业务序号发号器。
 * 必须在事务内调用（lib/db.ts 的 tx），保证取号与流水插入原子。
 */
export function nextSeq(db: DatabaseSync = getDb(), name = 'movement'): number {
  db.prepare(
    `INSERT INTO seq_counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
  ).run(name);
  const row = db.prepare('SELECT value FROM seq_counters WHERE name = ?').get(name) as
    | { value: number }
    | undefined;
  return row?.value ?? 1;
}

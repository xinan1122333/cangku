import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from './schema-sql';

const here = dirname(fileURLToPath(import.meta.url));

/** wms 项目根目录（src/lib -> 项目根） */
export const projectRoot = resolve(here, '..', '..');

/** 数据库文件绝对路径：DATABASE_PATH（相对项目根解析）或默认 <项目根>/data/wms.db */
export function databasePath(): string {
  const raw = process.env.DATABASE_PATH?.trim();
  if (!raw) return resolve(projectRoot, 'data', 'wms.db');
  return resolve(projectRoot, raw);
}

let cached: DatabaseSync | null = null;
let warnedSecret = false;

export type Db = DatabaseSync;

/** 建表（幂等）。DDL 内联在 schema-sql.ts，避免打包后读不到文件。 */
export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}

/**
 * 取得数据库单例（惰性打开）。
 * ⚠️ 绝不能在模块顶层打开：否则 `next build` 期间会创建 data/wms.db。
 */
export function getDb(): DatabaseSync {
  if (cached) return cached;
  const file = databasePath();
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  applySchema(db);
  cached = db;
  return db;
}

/** 关闭并清空单例（测试收尾用） */
export function closeDb(): void {
  if (!cached) return;
  try {
    cached.close();
  } catch {
    /* 忽略重复关闭 */
  }
  cached = null;
}

/** 当前数据库是否已打开（不触发打开动作） */
export function isDbOpen(): boolean {
  return cached !== null;
}

/** 把布尔值/undefined 归一化成 node:sqlite 可绑定的值（只接受 null/number/string/bigint/Uint8Array） */
export function bindValue(value: unknown): null | number | string | bigint | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.getTime();
  return String(value);
}

/** 把绑定对象里的 undefined/boolean 归一化 */
export function bindParams(params: unknown[]): (null | number | string | bigint | Uint8Array)[] {
  return params.map(bindValue);
}

/**
 * 事务包装：所有写操作必须走这里，保证「流水插入 + 结存计算」原子。
 * node:sqlite 没有 db.transaction 辅助函数，这里手写 BEGIN/COMMIT/ROLLBACK。
 * 支持嵌套（内层用 SAVEPOINT），因为过账等流程会组合调用。
 */
let txDepth = 0;

export function tx<T>(fn: () => T): T {
  const db = getDb();
  const nested = txDepth > 0;
  const name = `sp_${txDepth}`;
  if (nested) db.exec(`SAVEPOINT ${name}`);
  else db.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
    return result;
  } catch (err) {
    txDepth -= 1;
    try {
      db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
      if (nested) db.exec(`RELEASE ${name}`);
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

/**
 * 异步事务：签会话需要 await 签名，跨 await 保持事务边界。
 * driver 执行是同步的，回调内不产生并发写入。
 */
export async function txAsync<T>(fn: () => Promise<T> | T): Promise<T> {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
}

/**
 * JWT 密钥。未配置时给开发默认值，并只 warn 一次（构建期不会打开数据库）。
 */
export function jwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return new TextEncoder().encode(secret);
  if (!warnedSecret) {
    warnedSecret = true;
    console.warn('[wms] 未设置 JWT_SECRET，正在使用开发默认密钥，生产环境必须替换。');
  }
  return new TextEncoder().encode('dev-only-change-me');
}

/** 会话有效期（天），默认 7 */
export function sessionDays(): number {
  const n = Number(process.env.SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

/** 判断是否 SQLite 唯一约束冲突（SKU / barcode 重复 -> 409） */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; errcode?: number; message?: string } | null;
  if (e?.errcode === 2067 || e?.errcode === 1555) return true;
  const code = String(e?.code ?? '');
  if (code.includes('CONSTRAINT_UNIQUE') || code.includes('SQLITE_CONSTRAINT')) {
    return /UNIQUE/i.test(String(e?.message ?? '')) || code.includes('UNIQUE');
  }
  return /UNIQUE constraint failed/i.test(String(e?.message ?? ''));
}

/** 从唯一约束错误里取冲突字段名：`items.sku` -> `sku` */
export function uniqueViolationField(err: unknown): string | null {
  const msg = String((err as { message?: string } | null)?.message ?? '');
  const m = /UNIQUE constraint failed:\s*([\w.]+)/i.exec(msg);
  if (!m) return null;
  const parts = m[1].split('.');
  return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

/** 查询结果浅拷贝（node:sqlite 返回 null-prototype 对象） */
export function plain<T extends object>(row: T | undefined): T | undefined {
  return row ? ({ ...row } as T) : undefined;
}

/**
 * 查询辅助：node:sqlite 的 get/all 返回 `Record<string, SQLOutputValue>`，
 * 这里统一收口类型转换，避免每处 `as unknown as X`。
 */
export function queryOne<T>(stmt: StatementSync, ...params: unknown[]): T | undefined {
  return stmt.get(...bindParams(params)) as unknown as T | undefined;
}

export function queryAll<T>(stmt: StatementSync, ...params: unknown[]): T[] {
  return stmt.all(...bindParams(params)) as unknown as T[];
}

/** 直接按 SQL 查询一行 */
export function selectOne<T>(sql: string, ...params: unknown[]): T | undefined {
  return queryOne<T>(getDb().prepare(sql), ...params);
}

/** 直接按 SQL 查询多行 */
export function selectAll<T>(sql: string, ...params: unknown[]): T[] {
  return queryAll<T>(getDb().prepare(sql), ...params);
}

/**
 * 初始化数据库：创建 data/wms.db 并建表（幂等）。
 * 用法：pnpm db:init
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 与 src/lib/db.ts 保持一致：DATABASE_PATH 相对项目根解析 */
export function resolveDbPath() {
  const raw = process.env.DATABASE_PATH?.trim();
  if (!raw) return resolve(projectRoot, 'data', 'wms.db');
  return resolve(projectRoot, raw);
}

export function readSchema() {
  return readFileSync(resolve(projectRoot, 'src', 'lib', 'schema.sql'), 'utf8');
}

/** 打开数据库并套用 PRAGMA + schema（供 db-init / seed / 测试复用） */
export function openDatabase(dbPath = resolveDbPath()) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(readSchema());
  return db;
}

// 直接执行时（pnpm db:init）才真正建库
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const dbPath = resolveDbPath();
  const db = openDatabase(dbPath);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const version = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close();
  console.log(`[db:init] 数据库就绪：${dbPath}`);
  console.log(`[db:init] SQLite 版本：${version}`);
  console.log(`[db:init] 表（${tables.length}）：${tables.join(', ')}`);
}

/**
 * 测试公共辅助。
 *
 * ⚠️ 沙箱约束：本机禁止管道 spawn 子进程，`node --test` 的默认「每文件一个子进程」
 * 会直接 `EPERM: spawn`。因此 package.json 用 `--test-isolation=none` 单进程跑全部测试文件。
 *
 * 由此带来两个设计决定：
 *  1) **全部测试文件共享同一个 DB 连接**（模块单例）：绝不能用 `import('...?x')` 这种
 *     cache-bust 技巧，否则 auth.ts 内部 import 的 db.ts 会与测试拿到的不是同一个单例。
 *  2) 测试数据用 `uniq()` 生成唯一 SKU / 用户名，保证跨文件、任意顺序都可重复运行。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

/** bcryptjs 用 createRequire 加载最稳（纯 JS，无原生依赖） */
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

let initialized = false;
let tempDir = null;

/**
 * 准备测试数据库（幂等：同进程内只建一次）。
 * 必须在 import store/db 之前调用。
 */
export function useTempDb(label = 'suite') {
  if (!initialized) {
    tempDir = mkdtempSync(join(tmpdir(), 'wms-tests-'));
    process.env.DATABASE_PATH = join(tempDir, 'wms-test.db');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';
    initialized = true;
  }
  return {
    path: process.env.DATABASE_PATH,
    label,
    cleanup() {
      // 单进程共享 DB，由最后一个文件负责清理；这里只在显式调用时删目录
      if (!tempDir) return;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* Windows 上偶发文件占用，忽略 */
      }
      tempDir = null;
    },
  };
}

/** 唯一后缀，保证跨文件、任意顺序都能重复运行 */
let counter = 0;
export function uniq(prefix = 'X') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${randomUUID().slice(0, 4)}`;
}

/**
 * 动态加载领域层。**不带 cache-bust**：必须与 src/lib 内部互相 import 的是同一批单例。
 */
export async function loadStore() {
  return import('../src/lib/store.ts');
}

export async function loadDb() {
  return import('../src/lib/db.ts');
}

export async function loadAuth() {
  return import('../src/lib/auth.ts');
}

export async function loadRbac() {
  return import('../src/lib/rbac.ts');
}

/** 初始化 schema + 权限字典 + 四个内置角色 + 一个管理员（幂等） */
export function bootstrap(db, { password = 'admin-pass-123' } = {}) {
  const now = Date.now();
  const roles = [
    ['admin', '系统管理员', ['*']],
    ['keeper', '仓管员', ['item:read', 'item:write', 'stock:read', 'stock:write', 'movement:read', 'movement:write', 'stocktake:read', 'stocktake:write']],
    ['auditor', '审计查看', ['item:read', 'stock:read', 'movement:read', 'movement:export', 'stocktake:read', 'audit:read']],
    ['viewer', '只读', ['item:read', 'stock:read']],
  ];
  const roleIds = {};
  const findRole = db.prepare('SELECT id FROM roles WHERE code = ?');
  const insertRole = db.prepare(
    'INSERT INTO roles (id, code, name, description, is_system, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  );
  for (const [code, name, perms] of roles) {
    const existing = findRole.get(code);
    const id = existing?.id ?? randomUUID();
    roleIds[code] = id;
    if (!existing) insertRole.run(id, code, name, `${name}（测试）`, now);
    for (const p of perms) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)').run(id, p);
    }
  }

  const perms = [
    ['item:read', '物料查看', '物料'],
    ['item:write', '物料维护', '物料'],
    ['stock:read', '结存查看', '库存'],
    ['stock:write', '结存调整', '库存'],
    ['movement:read', '流水查看', '出入库'],
    ['movement:write', '出入库登记', '出入库'],
    ['movement:export', '流水导出', '出入库'],
    ['stocktake:read', '盘点查看', '盘点'],
    ['stocktake:write', '盘点录入', '盘点'],
    ['stocktake:post', '盘点过账', '盘点'],
    ['user:read', '用户查看', '系统'],
    ['user:write', '用户维护', '系统'],
    ['role:read', '角色查看', '系统'],
    ['role:write', '角色维护', '系统'],
    ['audit:read', '审计查看', '系统'],
  ];
  for (const [code, name, group] of perms) {
    db.prepare('INSERT OR IGNORE INTO permissions (code, name, group_name) VALUES (?, ?, ?)').run(code, name, group);
  }

  // 管理员：已存在则复用（保证幂等，重复 bootstrap 不冲突）
  const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  const adminId = existingAdmin?.id ?? randomUUID();
  if (!existingAdmin) {
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(adminId, 'admin', '系统管理员', bcrypt.hashSync(password, 10), roleIds.admin, now, now);
  }

  return { roleIds, adminId, adminPassword: password };
}

/** 建一个测试用户（用户名建议用 uniq() 生成） */
export function addUser(db, { username, password = 'pass-123456', roleId, status = 'active' }) {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, username, username, bcrypt.hashSync(password, 10), roleId, status, now, now);
  return id;
}

/** 测试用 actor */
export const actor = (name = '测试员') => ({ userId: null, displayName: name });

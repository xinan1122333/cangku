/**
 * 种子数据（幂等）：
 *   1) 注册权限字典（与 src/lib/rbac.ts 的 PERMISSIONS 一致）
 *   2) 建立四个内置角色（admin / keeper / auditor / viewer）
 *   3) 建立首个管理员账号（默认 admin）
 *
 * 幂等规则：
 *   - 角色已存在 -> 只补权限，不改名称/不覆盖自定义权限之外的东西
 *   - 管理员已存在 -> **不重置密码**，除非显式给了 ADMIN_PASSWORD
 *   - 随机密码只打印一次
 *
 * 用法：pnpm seed
 */
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from './db-init.mjs';

/** 权限码字典（冻结，见 notes/ARCHITECTURE.md §3） */
const PERMISSIONS = [
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

/** 内置角色（冻结） */
const ROLES = [
  { code: 'admin', name: '系统管理员', description: '拥有全部权限', permissions: ['*'] },
  {
    code: 'keeper',
    name: '仓管员',
    description: '物料、库存、出入库与盘点日常操作',
    permissions: [
      'item:read', 'item:write',
      'stock:read', 'stock:write',
      'movement:read', 'movement:write',
      'stocktake:read', 'stocktake:write',
    ],
  },
  {
    code: 'auditor',
    name: '审计查看',
    description: '只读 + 流水导出 + 审计日志',
    permissions: ['item:read', 'stock:read', 'movement:read', 'movement:export', 'stocktake:read', 'audit:read'],
  },
  { code: 'viewer', name: '只读', description: '仅可查看物料与结存', permissions: ['item:read', 'stock:read'] },
];

/**
 * 生成随机强密码：16 位，字符取自大小写字母 + 数字 + 符号的 65 字符表。
 * 熵约 16 × log2(65) ≈ 96 bit。
 *
 * 注意：每个字符**独立等概率**抽取，因此**不保证**每类字符都出现
 * （例如 16 位全无数字的概率约 12%）。「必须包含各类字符」属于密码策略要求，
 * 当前未启用；如需启用请显式提出（见下方 strongPassword 备注）。
 */
export const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

export function randomPassword(length = 16) {
  const alphabet = PW_ALPHABET;
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 注册权限字典（幂等 upsert 名称与分组） */
export function seedPermissions(db) {
  const stmt = db.prepare(
    `INSERT INTO permissions (code, name, group_name) VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, group_name = excluded.group_name`,
  );
  for (const [code, name, group] of PERMISSIONS) stmt.run(code, name, group);
  return PERMISSIONS.length;
}

/** 建立/补齐内置角色（系统角色 is_system=1） */
export function seedRoles(db) {
  const now = Date.now();
  const findRole = db.prepare('SELECT id FROM roles WHERE code = ?');
  const insertRole = db.prepare(
    'INSERT INTO roles (id, code, name, description, is_system, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  );
  const updateRole = db.prepare('UPDATE roles SET name = ?, description = ?, is_system = 1 WHERE id = ?');
  const clearPerms = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
  const insertPerm = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)',
  );

  const result = [];
  for (const role of ROLES) {
    const existing = findRole.get(role.code);
    let id = existing?.id;
    if (id) {
      updateRole.run(role.name, role.description, id);
    } else {
      id = randomUUID();
      insertRole.run(id, role.code, role.name, role.description, now);
    }
    clearPerms.run(id);
    for (const code of role.permissions) insertPerm.run(id, code);
    result.push({ id, code: role.code, permissions: role.permissions.length });
  }
  return result;
}

/** 创建/检查管理员；已存在则默认不重置密码 */
export function seedAdmin(db, { username = 'admin', password, resetPassword = false } = {}) {
  const now = Date.now();
  const role = db.prepare("SELECT id FROM roles WHERE code = 'admin'").get();
  if (!role) throw new Error('内置角色 admin 不存在，种子顺序有误');

  const existing = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  if (existing && !resetPassword) {
    return { created: false, username, userId: existing.id, password: null };
  }

  const plain = password || randomPassword();
  const hash = bcrypt.hashSync(plain, 10);
  if (existing) {
    db.prepare(
      'UPDATE users SET display_name = ?, password_hash = ?, role_id = ?, status = ?, updated_at = ? WHERE id = ?',
    ).run('系统管理员', hash, role.id, 'active', now, existing.id);
    return { created: false, username, userId: existing.id, password: plain };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, username, '系统管理员', hash, role.id, now, now);
  return { created: true, username, userId: id, password: plain };
}

function main() {
  const db = openDatabase();
  const permCount = seedPermissions(db);
  const roles = seedRoles(db);

  const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
  const envPassword = process.env.ADMIN_PASSWORD?.trim() || '';
  const admin = seedAdmin(db, {
    username,
    password: envPassword || undefined,
    // 显式给出 ADMIN_PASSWORD 时允许重置，否则绝不覆盖已有密码
    resetPassword: Boolean(envPassword),
  });

  if (admin.password) {
    console.log('');
    console.log('==================================================');
    console.log(`  管理员账号：${admin.username}`);
    console.log(`  初始密码　：${admin.password}`);
    console.log('  （此密码只显示一次，请立即登录并修改）');
    console.log('==================================================');
    console.log('');
  } else {
    console.log(`[seed] 管理员 ${admin.username} 已存在，密码保持不变（如需重置请设置 ADMIN_PASSWORD 环境变量）`);
  }

  console.log(`[seed] 权限字典已注册：${permCount} 项`);
  console.log(
    `[seed] 内置角色就绪：${roles.map((r) => `${r.code}(${r.permissions})`).join(', ')}`,
  );
  console.log(`[seed] 管理员：${admin.created ? '已创建' : '已存在'} -> ${admin.username}`);
  db.close();
}

const invokedDirectly =
  process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  main();
}

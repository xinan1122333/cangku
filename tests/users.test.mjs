/**
 * 用户 / 角色 / 权限字典 测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { addUser, bootstrap, loadDb, loadStore, uniq, useTempDb } from './helpers.mjs';

/** 同 helpers.mjs：bcryptjs 用 createRequire 加载最稳 */
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const tmp = useTempDb('users');
const store = await loadStore();
const db = (await loadDb()).getDb();
const { roleIds } = bootstrap(db);

/** 本次运行唯一前缀：多文件共享一个 DB，标识符必须全局唯一 */
const P = uniq('U');
const S = (n) => `${P}-${n}`;

test('用户列表返回角色信息，且不泄露密码哈希', () => {
  // 用相对断言：所有测试文件共享同一个 DB，总数不可写死
  const before = store.listUsers({ page: 1, pageSize: 1, offset: 0 }).total;
  const username = S(1);
  addUser(db, { username, roleId: roleIds.keeper });

  const { rows, total } = store.listUsers({ page: 1, pageSize: 200, offset: 0 });
  assert.equal(total, before + 1, '应恰好新增 1 个用户');

  const u1 = rows.find((r) => r.username === username);
  assert.ok(u1, '必须能查到刚创建的用户');
  assert.equal(u1.roleCode, 'keeper');
  assert.equal(u1.roleName, '仓管员');
  assert.equal(u1.status, 'active');
  assert.equal('passwordHash' in u1, false, 'DTO 不得包含密码哈希');
  assert.equal('password_hash' in u1, false);
});

test('角色列表带权限码与用户数', () => {
  const roles = store.listRoles();
  assert.equal(roles.length, 4);
  const admin = roles.find((r) => r.code === 'admin');
  assert.equal(admin.isSystem, true);
  assert.deepEqual(admin.permissions, ['*']);
  assert.ok(admin.userCount >= 1, '至少应有 seed 的 admin');

  const keeper = roles.find((r) => r.code === 'keeper');
  assert.ok(keeper.permissions.includes('movement:write'));
  assert.ok(!keeper.permissions.includes('user:write'), 'keeper 不应有 user:write');

  // 用户数必须与 users 表实际情况一致（相对断言）
  for (const r of roles) {
    const actual = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(r.id).c;
    assert.equal(r.userCount, actual, `角色 ${r.code} 的 userCount 应与库内一致`);
  }
});

test('权限字典按分组返回 15 项', () => {
  const dict = store.listPermissionDict();
  assert.equal(dict.length, 15);
  const groups = new Set(dict.map((d) => d.groupName));
  assert.deepEqual([...groups].sort(), ['出入库', '库存', '盘点', '系统', '物料'].sort());
  for (const p of dict) {
    assert.ok(p.code && p.name && p.groupName);
  }
});

test('停用用户后其会话全部撤销', async () => {
  const auth = await import('../src/lib/auth.ts');
  const username = S(2);
  const uid = addUser(db, { username, password: 'pass-123456', roleId: roleIds.viewer });
  const login = await auth.authenticate(username, 'pass-123456', '');
  assert.equal(login.ok, true);

  const found = await auth.sessionFromToken(login.data.token);
  assert.ok(found);

  const revoked = auth.revokeUserSessions(uid);
  assert.ok(revoked >= 1);
  assert.equal(await auth.sessionFromToken(login.data.token), null, '停用后会话必须失效');
});

test('管理员权限判定覆盖全部权限码（含 audit:read）', async () => {
  const auth = await import('../src/lib/auth.ts');
  const perms = auth.rolePermissions(roleIds.admin);
  assert.deepEqual(perms, ['*']);
  assert.equal(auth.hasPermission(perms, 'audit:read'), true);
  assert.equal(auth.hasPermission(perms, 'role:write'), true);
});

test('用户名唯一约束生效', () => {
  assert.throws(() => addUser(db, { username: S(1), roleId: roleIds.viewer }), /UNIQUE/i);
});

test('用户密码在库中始终为 bcrypt 哈希', () => {
  const uid = addUser(db, { username: S(3), password: 'secret-123456', roleId: roleIds.keeper });
  const row = db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(uid);
  assert.ok(row.h.startsWith('$2'));
  assert.equal(bcrypt.compareSync('secret-123456', row.h), true);
});

test.after(() => tmp.cleanup());

/**
 * 认证与权限测试（验收 §7.5）：
 *   密码哈希与校验、登录签发 JWT（HttpOnly Cookie 由路由负责）
 *   会话撤销、权限判定（管理员 "*"、仓管员、只读）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addUser, bootstrap, loadAuth, loadDb, loadRbac, uniq, useTempDb } from './helpers.mjs';

const tmp = useTempDb('auth');
const auth = await loadAuth();
const rbac = await loadRbac();
const db = (await loadDb()).getDb();
const { roleIds, adminId, adminPassword } = bootstrap(db);

test('密码用 bcrypt 哈希存储，明文不落库', () => {
  const row = db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get(adminId);
  assert.ok(row.h.startsWith('$2'), '必须是 bcrypt 哈希');
  assert.notEqual(row.h, adminPassword, '不得存明文');
  assert.equal(auth.verifyPassword(adminPassword, row.h), true);
  assert.equal(auth.verifyPassword('wrong-password', row.h), false);
});

test('登录成功签发 7 天 JWT，并写入 sessions 表（token_hash 可撤销）', async () => {
  const result = await auth.authenticate('admin', adminPassword, '127.0.0.1');
  assert.equal(result.ok, true, '管理员应能登录');
  assert.ok(result.data.token.split('.').length === 3, '必须是 JWT 三段式');

  const days = (result.data.expiresAt - Date.now()) / (24 * 3600 * 1000);
  assert.ok(days > 6.9 && days <= 7.01, `有效期应约 7 天，实际 ${days}`);

  // token_hash 落库且为 sha256（不存原始 token）
  const stored = db
    .prepare('SELECT token_hash AS h, revoked_at AS r FROM sessions WHERE user_id = ?')
    .get(adminId);
  assert.equal(stored.h, auth.sha256(result.data.token));
  assert.notEqual(stored.h, result.data.token);
  assert.equal(stored.r, null);

  // 管理员权限包含 *
  assert.deepEqual(result.data.user.permissions, ['*']);
});

test('密码错误 / 用户不存在 / 账号停用 都拒绝登录', async () => {
  assert.equal((await auth.authenticate('admin', 'bad', '')).ok, false);
  assert.equal((await auth.authenticate('nobody', 'x', '')).ok, false);

  const disabledId = addUser(db, { username: 'off', password: 'pass-123456', roleId: roleIds.viewer, status: 'disabled' });
  const denied = await auth.authenticate('off', 'pass-123456', '');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /停用/);
  assert.ok(disabledId);
});

test('会话撤销后 token 失效', async () => {
  const result = await auth.authenticate('admin', adminPassword, '');
  const found = await auth.sessionFromToken(result.data.token);
  assert.ok(found, '撤销前应有效');

  auth.revokeSession(found.sessionId);
  assert.equal(await auth.sessionFromToken(result.data.token), null, '撤销后必须失效');
});

test('伪造/篡改 token 一律拒绝', async () => {
  assert.equal(await auth.sessionFromToken('not-a-jwt'), null);
  const result = await auth.authenticate('admin', adminPassword, '');
  const tampered = `${result.data.token.slice(0, -3)}xyz`;
  assert.equal(await auth.sessionFromToken(tampered), null);
});

test('权限判定：admin 通配、keeper 有写权限、viewer 只读；用户权限码决定 403', () => {
  const admin = ['*'];
  const keeper = rbac.SYSTEM_ROLES.find((r) => r.code === 'keeper').permissions.slice();
  const viewer = rbac.SYSTEM_ROLES.find((r) => r.code === 'viewer').permissions.slice();

  // 管理员 "*"
  assert.equal(auth.hasPermission(admin, 'user:write'), true);
  assert.equal(auth.hasPermission(admin, 'anything:at:all'), true);

  // 仓管员：有出入库写权限，无用户管理权限 -> 调 user:write 必须 403
  assert.equal(auth.hasPermission(keeper, 'movement:write'), true);
  assert.equal(auth.hasPermission(keeper, 'item:write'), true);
  assert.equal(auth.hasPermission(keeper, 'user:write'), false, 'keeper 调 user:write 应为 false -> 路由返回 403');
  assert.equal(auth.hasPermission(keeper, 'user:read'), false);

  // 只读
  assert.equal(auth.hasPermission(viewer, 'item:read'), true);
  assert.equal(auth.hasPermission(viewer, 'stock:read'), true);
  assert.equal(auth.hasPermission(viewer, 'item:write'), false);
  assert.equal(auth.hasPermission(viewer, 'movement:write'), false);

  // 审计
  const auditor = rbac.SYSTEM_ROLES.find((r) => r.code === 'auditor').permissions.slice();
  assert.equal(auth.hasPermission(auditor, 'movement:export'), true);
  assert.equal(auth.hasPermission(auditor, 'audit:read'), true);
  assert.equal(auth.hasPermission(auditor, 'movement:write'), false);
});

test('权限字典与 rbac 声明一致（不遗漏 audit:read）', () => {
  const codes = db.prepare('SELECT code FROM permissions ORDER BY code').all().map((r) => r.code);
  assert.deepEqual(codes, [...rbac.PERMISSION_CODES].sort());
  assert.equal(rbac.PERMISSION_CODES.length, 15);
  assert.ok(rbac.PERMISSION_CODES.includes('audit:read'));
});

test('用户改密后可用新密码登录', async () => {
  const uid = addUser(db, { username: 'keeper1', password: 'old-pass-123', roleId: roleIds.keeper });
  assert.equal((await auth.authenticate('keeper1', 'old-pass-123', '')).ok, true);

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword('new-pass-456'), uid);
  assert.equal((await auth.authenticate('keeper1', 'old-pass-123', '')).ok, false, '旧密码必须失效');
  assert.equal((await auth.authenticate('keeper1', 'new-pass-456', '')).ok, true, '新密码可用');
});

test.after(() => tmp.cleanup());

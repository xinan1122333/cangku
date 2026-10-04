/**
 * 种子脚本测试：
 *   幂等性（重复 seed 不重置密码）、权限字典全量、四个内置角色。
 * 直接子进程运行 scripts/seed.mjs —— 沙箱禁止管道 spawn，这里用 stdio 继承 + `--test-isolation=none`
 * 仍会走 child_process，因此改为**直接 import** 脚本导出的函数，最稳。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/** 同 helpers.mjs：bcryptjs 用 createRequire 加载最稳 */
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const dir = mkdtempSync(join(tmpdir(), 'wms-seed-'));
const dbPath = join(dir, 'seed.db');
process.env.DATABASE_PATH = dbPath;

const seed = await import('../scripts/seed.mjs');
const { openDatabase } = await import('../scripts/db-init.mjs');

test('seed: 权限字典 15 项、四个内置角色', () => {
  const db = openDatabase(dbPath);
  const permCount = seed.seedPermissions(db);
  const roles = seed.seedRoles(db);
  assert.equal(permCount, 15);

  const codes = roles.map((r) => r.code).sort();
  assert.deepEqual(codes, ['admin', 'auditor', 'keeper', 'viewer']);

  const roleCodes = db.prepare('SELECT code FROM roles ORDER BY code').all().map((r) => r.code);
  assert.deepEqual(roleCodes, ['admin', 'auditor', 'keeper', 'viewer']);

  // 管理员拥有 "*"
  const adminId = db.prepare("SELECT id FROM roles WHERE code = 'admin'").get().id;
  const adminPerms = db
    .prepare('SELECT permission_code AS c FROM role_permissions WHERE role_id = ?')
    .all(adminId)
    .map((r) => r.c);
  assert.deepEqual(adminPerms, ['*']);

  // 权限码全量
  const permCodes = db.prepare('SELECT code FROM permissions ORDER BY code').all().map((r) => r.code);
  for (const expected of [
    'item:read', 'item:write', 'stock:read', 'stock:write',
    'movement:read', 'movement:write', 'movement:export',
    'stocktake:read', 'stocktake:write', 'stocktake:post',
    'user:read', 'user:write', 'role:read', 'role:write', 'audit:read',
  ]) {
    assert.ok(permCodes.includes(expected), `权限字典缺少 ${expected}`);
  }
  db.close();
});

test('seed: 首次创建 admin 并返回一次性密码；二次运行不重置密码（幂等）', () => {
  const db = openDatabase(dbPath);

  const first = seed.seedAdmin(db, { username: 'admin' });
  assert.equal(first.created, true, '首次应创建');
  assert.ok(typeof first.password === 'string' && first.password.length >= 12, '必须生成强随机密码');

  const hash1 = db.prepare('SELECT password_hash AS h FROM users WHERE username = ?').get('admin').h;
  assert.equal(bcrypt.compareSync(first.password, hash1), true, '打印的密码必须能登录');

  // 第二次：不带 ADMIN_PASSWORD -> 不重置
  const second = seed.seedAdmin(db, { username: 'admin' });
  assert.equal(second.created, false);
  assert.equal(second.password, null, '不得再打印密码');
  const hash2 = db.prepare('SELECT password_hash AS h FROM users WHERE username = ?').get('admin').h;
  assert.equal(hash2, hash1, '密码哈希必须保持不变');

  // 显式给 ADMIN_PASSWORD -> 允许重置
  const forced = seed.seedAdmin(db, { username: 'admin', password: 'Forced-Pass-123', resetPassword: true });
  assert.equal(forced.password, 'Forced-Pass-123');
  const hash3 = db.prepare('SELECT password_hash AS h FROM users WHERE username = ?').get('admin').h;
  assert.equal(bcrypt.compareSync('Forced-Pass-123', hash3), true);

  // 重复 seed 整个流程仍然幂等（用户数不增长）
  seed.seedPermissions(db);
  seed.seedRoles(db);
  seed.seedAdmin(db, { username: 'admin' });
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  assert.equal(users, 1, '重复 seed 不得产生重复用户');
  db.close();
});

/**
 * 随机密码强度用例（BUG-5 修复版）。
 *
 * 原写法 `assert.match(randomPassword(), /[0-9]/)` 是**过强假设**，会概率性失败：
 * 每个字符独立从 65 字符表等概率抽取（其中只有 8 个是数字），
 * 因此「16 位里一个数字都没有」的概率 = (57/65)^16 ≈ 12.23% —— 约每 8 次跑一次红。
 *
 * 正确做法：**多次采样**后断言「至少出现过一次」，而不是对单次采样做确定性断言。
 * 注意：`randomPassword` 本身不保证含各类字符，这是有意为之（高熵随机）；
 * 「必须包含数字」属于密码策略，不属于当前产品行为。
 */
test('seed: 随机密码足够强（长度、字符集与多类别覆盖）', () => {
  const SAMPLES = 300;
  const samples = Array.from({ length: SAMPLES }, () => seed.randomPassword());

  // 1) 长度恒定
  assert.ok(
    samples.every((p) => p.length === 16),
    '每个密码长度都必须是 16',
  );

  // 2) 字符集合法：只允许来自真实字母表（按 PW_ALPHABET 动态构造，避免与实现脱节）
  const allowed = new Set([...seed.PW_ALPHABET]);
  const illegal = samples.filter((p) => [...p].some((c) => !allowed.has(c)));
  assert.equal(illegal.length, 0, `出现了字母表之外的字符：${illegal.slice(0, 3).join(', ')}`);

  // 3) 字母表本身的构成（数字 8 / 大写 24 / 小写 25 / 符号 8 = 65）
  assert.equal(seed.PW_ALPHABET.length, 65, '字母表长度应为 65');
  assert.equal([...seed.PW_ALPHABET].filter((c) => /[0-9]/.test(c)).length, 8);

  // 4) 多类别覆盖：采样中应出现过大写/小写/数字（而非要求单个密码必含）
  assert.ok(
    samples.some((p) => /[0-9]/.test(p)),
    `${SAMPLES} 次采样中应至少出现过一次数字（单次必含数字不是产品保证）`,
  );
  assert.ok(samples.some((p) => /[A-Z]/.test(p)), `${SAMPLES} 次采样中应至少出现过一次大写`);
  assert.ok(samples.some((p) => /[a-z]/.test(p)), `${SAMPLES} 次采样中应至少出现过一次小写`);

  // 5) 随机性：不应出现大量重复
  const unique = new Set(samples);
  assert.ok(unique.size > SAMPLES * 0.99, `300 次采样几乎不应重复，实际唯一值 ${unique.size}`);
});

test('seed: 随机密码的统计特性与理论一致（不保证单次必含数字）', () => {
  const N = 5000;
  const pool = Array.from({ length: N }, () => seed.randomPassword());
  const withDigit = pool.filter((p) => /[0-9]/.test(p)).length;
  const rate = withDigit / N;

  // 理论含数字概率 = 1 - (57/65)^16 ≈ 87.77%
  assert.ok(rate > 0.8 && rate < 0.95, `含数字比例应接近 87.8%，实际 ${(rate * 100).toFixed(1)}%`);

  // 明确固化「无数字」是合法输出：这正是原用例误判的情形
  const withoutDigit = pool.find((p) => !/[0-9]/.test(p));
  assert.ok(withoutDigit, '按当前实现，必然能采到不含数字的密码（说明它不是产品保证）');
  assert.equal(withoutDigit.length, 16, '不含数字的密码长度同样合法');
});

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

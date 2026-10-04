/** 校验正式数据库内容（Lead 交付前检查）。 */
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2] || './data/wms.db';
const db = new DatabaseSync(path);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`数据库: ${path}`);
console.log(`表(${tables.length}): ${tables.join(', ')}`);

const users = db.prepare('SELECT username, display_name, status FROM users').all().map((r) => ({ ...r }));
console.log('用户:', JSON.stringify(users));
console.log('角色数:', db.prepare('SELECT count(*) AS c FROM roles').get().c);
console.log('权限数:', db.prepare('SELECT count(*) AS c FROM permissions').get().c);
console.log('物料数:', db.prepare('SELECT count(*) AS c FROM items').get().c);
console.log('流水数:', db.prepare('SELECT count(*) AS c FROM movements').get().c);
const roles = db.prepare('SELECT code, name FROM roles ORDER BY code').all().map((r) => `${r.code}(${r.name})`);
console.log('角色:', roles.join(', '));
db.close();

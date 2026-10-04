/**
 * 页面可达性检查（对真实 Next 服务）。
 * 用法：node scripts/check-pages.mjs [BASE]
 */
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:3105';

const PAGES = ['/login', '/scan', '/items', '/movements', '/stocktakes', '/users', '/roles', '/'];

let fail = 0;
console.log(`\n=== 页面可达性 @ ${BASE} ===`);
for (const p of PAGES) {
  try {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    const t = await r.text();
    const errorPage = /Application error|Internal Server Error|useSession 必须|Unhandled Runtime Error/.test(t);
    const okStatus = r.status === 200 || (r.status >= 300 && r.status < 400);
    const good = okStatus && !errorPage;
    if (!good) fail += 1;
    console.log(
      `  ${good ? 'PASS' : 'FAIL'}  ${p.padEnd(13)} status=${r.status} len=${String(t.length).padEnd(6)} errorPage=${errorPage}`,
    );
  } catch (e) {
    fail += 1;
    console.log(`  FAIL  ${p.padEnd(13)} ${e.message}`);
  }
}
console.log(`\n页面检查：${PAGES.length - fail}/${PAGES.length} 通过`);
process.exit(fail > 0 ? 1 : 0);

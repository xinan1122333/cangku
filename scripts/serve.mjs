/**
 * 在**单进程内**启动 Next 服务器（不 fork 子进程）。
 *
 * 为什么需要这个文件：本机 DSH 沙箱禁止通过管道 spawn 子进程，
 * Next 的 CLI（`next dev` / `next start`）内部会 `fork()` 一个 server 子进程，
 * 因此在沙箱内必然 `EPERM: spawn`。这里改走 Next 的编程式 API，
 * `next({ dev })` 返回的 app 可直接 `getRequestHandler()` 交给 http server，
 * 全程不创建子进程。
 *
 * 用法：
 *   node scripts/serve.mjs               # 生产模式（需先 next build 出 .next）
 *   node scripts/serve.mjs --dev         # 开发模式（按需编译）
 *   PORT=3100 node scripts/serve.mjs
 */
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT || 3100);
const hostname = process.env.HOST || '0.0.0.0';

const next = require('next');
const app = next({ dev, hostname, port, dir: process.cwd() });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  handle(req, res, parse(req.url, true));
});

server.listen(port, hostname, () => {
  console.log(`[serve] WMS ready on http://${hostname}:${port} (${dev ? 'dev' : 'production'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[serve] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
  });
}

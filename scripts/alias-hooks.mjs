/**
 * node module resolve 钩子（仅测试/脚本使用，Next.js 不使用）：
 *   1) `@/x`   -> `<项目根>/src/x`（补 .ts/.tsx/.mjs/.js 扩展名）
 *   2) `./x`   （父模块在 src/ 内）-> 补扩展名
 *   3) 裸包名  -> 默认解析失败时用 require.resolve 兜底（应对 next/headers 这类无 exports 的子路径）
 * 目的：让 `node --test` 能以 strip-only 模式直接加载 src/lib 的 TS。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const TRY_EXT = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.js'];

function firstExisting(base) {
  for (const ext of TRY_EXT) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function toFileUrl(path) {
  return new URL(`file://${path.replace(/\\/g, '/')}`).href;
}

function isBare(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:') &&
    !specifier.startsWith('file:')
  );
}

export async function resolve(specifier, context, nextResolveHook) {
  // 1) 路径别名 @/...
  if (specifier.startsWith('@/')) {
    const found = firstExisting(resolvePath(srcRoot, specifier.slice(2)));
    if (found) return { url: toFileUrl(found), shortCircuit: true };
  }

  // 2) src 内的相对导入（TS 源码里通常不带扩展名）
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL);
    if (parentPath.startsWith(srcRoot) && !parentPath.includes('.ts?')) {
      const found = firstExisting(resolvePath(dirname(parentPath), specifier));
      if (found) return { url: toFileUrl(found), shortCircuit: true };
    }
  }

  // 3) 裸包名：先走默认解析，失败再回落到 CommonJS 解析
  if (isBare(specifier)) {
    try {
      return await nextResolveHook(specifier, context);
    } catch (err) {
      try {
        const require = createRequire(context.parentURL ?? import.meta.url);
        const resolved = require.resolve(specifier);
        if (resolved) return { url: toFileUrl(resolved), shortCircuit: true };
      } catch {
        /* 回落失败则抛出原始错误 */
      }
      throw err;
    }
  }

  return nextResolveHook(specifier, context);
}

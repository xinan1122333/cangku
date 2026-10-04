/**
 * 预加载脚本（仅用于 node/tsx 直接执行 TS）：把 `@/...` 解析到 `src/...`。
 * Next.js 自身不需要它（tsconfig paths 由 Next 处理）。
 * 用法：node --import ./scripts/alias-register.mjs ...
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./alias-hooks.mjs', pathToFileURL(import.meta.filename));

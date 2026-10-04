import { getSession, hasPermission } from '@/lib/auth';
import { fail, ok, toErrorResponse } from '@/lib/http';
import { resolveScanCode } from '@/lib/store';

/**
 * GET /api/scan/resolve?code=
 * 契约 §4 §6：权限 item:read
 *   - 命中：{ kind: "item", item, onHand }
 *   - 未命中：{ kind: "unknown", code }
 * 匹配顺序：barcode 精确 → sku 精确（由 lib/store.resolveScanCode 实现）。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return fail(401, 'UNAUTHORIZED', '未登录或会话已过期');
    if (!hasPermission(session.permissions, 'item:read')) {
      return fail(403, 'FORBIDDEN', '无权限执行该操作');
    }

    const url = new URL(request.url);
    const code = (url.searchParams.get('code') ?? '').trim();
    if (!code) return fail(400, 'BAD_REQUEST', '缺少条码参数 code');

    const item = resolveScanCode(code);
    if (!item) return ok({ kind: 'unknown' as const, code });

    const { onHand, ...rest } = item;
    return ok({ kind: 'item' as const, item: rest, onHand });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { badRequest, invalidBody, ok, parsePaging, toErrorResponse } from '@/lib/http';
import { stocktakeCreateSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { applySchema, getDb, tx } from '@/lib/db';
import { createStocktake, listStocktakes } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/stocktakes?status=&q=&page=&pageSize= —— 权限：stocktake:read */
export async function GET(req: NextRequest) {
  const guard = await requirePermission('stocktake:read');
  if (!guard.ok) return guard.response;
  const url = new URL(req.url);
  const { page, pageSize, offset } = parsePaging(url);
  try {
    applySchema(getDb());
    const { rows, total } = listStocktakes({
      status: url.searchParams.get('status')?.trim() || undefined,
      q: url.searchParams.get('q')?.trim() || undefined,
      page,
      pageSize,
      offset,
    });
    return ok({ rows, total, page, pageSize });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/stocktakes —— 创建盘点单（可带 lines；不带则全量生成）—— 权限：stocktake:write
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('stocktake:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;

  let body: unknown;
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = stocktakeCreateSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidBody(parsed.error);

  try {
    applySchema(getDb());
    const sheet = tx(() =>
      createStocktake(parsed.data, { userId: user.userId, displayName: user.displayName }, clientIp(req)),
    );
    return ok(sheet, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}

import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { badRequest, invalidBody, ok, parsePaging, toErrorResponse } from '@/lib/http';
import { itemCreateSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { applySchema, getDb, tx } from '@/lib/db';
import { createItem, listItems } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/items?q=&page=&pageSize=&category=&status=
 * 权限：item:read
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission('item:read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const { page, pageSize, offset } = parsePaging(url);
  try {
    applySchema(getDb());
    const { rows, total } = listItems({
      q: url.searchParams.get('q')?.trim() || undefined,
      category: url.searchParams.get('category')?.trim() || undefined,
      status: url.searchParams.get('status')?.trim() || undefined,
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
 * POST /api/items
 * 权限：item:write；body 可选 initQty 记期初库存（同一事务内写入流水）
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('item:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }

  const withInit = body as { initQty?: unknown };
  const initRaw = withInit?.initQty as { quantity?: number; unitCost?: number; occurredAt?: number } | undefined;
  const parsed = itemCreateSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);

  try {
    applySchema(getDb());
    const item = tx(() =>
      createItem(
        parsed.data,
        { userId: user.userId, displayName: user.displayName },
        initRaw && Number(initRaw.quantity) > 0
          ? {
              quantity: Math.floor(Number(initRaw.quantity)),
              unitCost: initRaw.unitCost ?? null,
              occurredAt: initRaw.occurredAt,
            }
          : undefined,
        clientIp(req),
      ),
    );
    return ok(item, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}

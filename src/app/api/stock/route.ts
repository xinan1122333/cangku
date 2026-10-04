import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { ok, parseBool, parsePaging, toErrorResponse } from '@/lib/http';
import { applySchema, getDb } from '@/lib/db';
import { listStock } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/stock?q=&lowOnly=&page=&pageSize=
 * 权限：stock:read；结存 = movements.signed_quantity 之和（唯一真源）
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission('stock:read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const { page, pageSize, offset } = parsePaging(url);
  try {
    applySchema(getDb());
    const { rows, total } = listStock({
      q: url.searchParams.get('q')?.trim() || undefined,
      category: url.searchParams.get('category')?.trim() || undefined,
      lowOnly: parseBool(url.searchParams.get('lowOnly')),
      page,
      pageSize,
      offset,
    });
    return ok({ rows, total, page, pageSize });
  } catch (err) {
    return toErrorResponse(err);
  }
}

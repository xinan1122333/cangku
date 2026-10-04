import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { notFound, ok, toErrorResponse } from '@/lib/http';
import { applySchema, getDb } from '@/lib/db';
import { getMovement } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/movements/[id] —— 权限：movement:read */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('movement:read');
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    applySchema(getDb());
    const movement = getMovement(id);
    if (!movement) return notFound('流水不存在');
    return ok(movement);
  } catch (err) {
    return toErrorResponse(err);
  }
}

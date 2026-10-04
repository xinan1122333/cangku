import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { badRequest, invalidBody, notFound, ok, toErrorResponse } from '@/lib/http';
import { itemPatchSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { getDb, tx } from '@/lib/db';
import { disableItem, getItem, onHandOf, updateItem } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/items/[id] —— 权限：item:read */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('item:read');
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    getDb();
    const item = getItem(id);
    if (!item) return notFound('物料不存在');
    return ok({ ...item, onHand: onHandOf(id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH /api/items/[id] —— 权限：item:write */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('item:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = itemPatchSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);

  try {
    const updated = tx(() =>
      updateItem(id, parsed.data, { userId: user.userId, displayName: user.displayName }, clientIp(req)),
    );
    return ok(updated);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE /api/items/[id] —— 权限：item:write；软删（停用） */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('item:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;
  const { id } = await params;
  try {
    const item = tx(() =>
      disableItem(id, { userId: user.userId, displayName: user.displayName }, clientIp(req)),
    );
    return ok({ ...item, onHand: onHandOf(id), disabled: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

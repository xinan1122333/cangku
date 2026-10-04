import type { NextRequest } from 'next/server';
import { requireAnyPermission, requirePermission } from '@/lib/rbac';
import { badRequest, invalidBody, notFound, ok, toErrorResponse } from '@/lib/http';
import { stocktakePatchSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { applySchema, getDb, tx } from '@/lib/db';
import { cancelStocktake, getStocktake, postStocktake, updateStocktake } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/stocktakes/[id] —— 详情（含明细），权限：stocktake:read */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requireAnyPermission(['stocktake:read', 'stocktake:write']);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    applySchema(getDb());
    const sheet = getStocktake(id);
    if (!sheet) return notFound('盘点单不存在');
    return ok(sheet);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH /api/stocktakes/[id] —— 录入实盘 / {action:"cancel"}，权限：stocktake:write */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('stocktake:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = stocktakePatchSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidBody(parsed.error);
  if (parsed.data.action === 'post') return badRequest('过账请调用 POST /api/stocktakes/[id] 并传 {"action":"post"}');

  const actor = { userId: user.userId, displayName: user.displayName };
  try {
    applySchema(getDb());
    const sheet = tx(() =>
      parsed.data.action === 'cancel'
        ? cancelStocktake(id, actor, clientIp(req))
        : updateStocktake(id, parsed.data, actor, clientIp(req)),
    );
    return ok(sheet);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/stocktakes/[id] —— {action:"post"} 过账，权限：stocktake:post */
export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('stocktake:post');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;
  const { id } = await params;

  let body: unknown = {};
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const action = (body as { action?: string } | null)?.action;
  if (action && action !== 'post') return badRequest('仅支持 {"action":"post"}');

  try {
    applySchema(getDb());
    const sheet = tx(() =>
      postStocktake(id, { userId: user.userId, displayName: user.displayName }, clientIp(req)),
    );
    return ok(sheet);
  } catch (err) {
    return toErrorResponse(err);
  }
}

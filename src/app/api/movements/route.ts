import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { badRequest, invalidBody, ok, parsePaging, parseTimeParam, toErrorResponse } from '@/lib/http';
import { movementCreateSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { applySchema, getDb, tx } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { insertMovement, listMovements } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/movements?itemId=&type=&from=&to=&page=&pageSize=
 * 权限：movement:read
 */
export async function GET(req: NextRequest) {
  const guard = await requirePermission('movement:read');
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const { page, pageSize, offset } = parsePaging(url);
  try {
    applySchema(getDb());
    const { rows, total } = listMovements({
      itemId: url.searchParams.get('itemId')?.trim() || undefined,
      type: url.searchParams.get('type')?.trim() || undefined,
      from: parseTimeParam(url.searchParams.get('from')),
      to: parseTimeParam(url.searchParams.get('to'), true),
      refNo: url.searchParams.get('refNo')?.trim() || undefined,
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
 * POST /api/movements —— 出入库/调整登记
 * 权限：movement:write；body {itemId,type,quantity|targetQty,...}
 * 结存不足 -> 409 INSUFFICIENT_STOCK（除非 allowNegative 且有 stock:write）
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('movement:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = movementCreateSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const input = parsed.data;

  // 负库存需要额外的 stock:write 权限
  if (input.allowNegative && !(user.permissions.includes('*') || user.permissions.includes('stock:write'))) {
    return badRequest('允许负库存需要 stock:write 权限');
  }

  try {
    applySchema(getDb());
    const movement = tx(() => {
      const mv = insertMovement(
        {
          itemId: input.itemId,
          type: input.type,
          quantity: input.quantity,
          targetQty: input.targetQty,
          unitCost: input.unitCost ?? null,
          refNo: input.refNo ?? null,
          partner: input.partner ?? null,
          reason: input.reason ?? null,
          remark: input.remark ?? null,
          occurredAt: input.occurredAt,
          allowNegative: input.allowNegative,
        },
        { userId: user.userId, displayName: user.displayName },
      );
      writeAudit({
        actorId: user.userId,
        actorName: user.username,
        action: `movement.${input.type}`,
        entity: 'movement',
        entityId: mv.id,
        detail: {
          seq: mv.seq,
          itemId: mv.itemId,
          sku: mv.sku,
          quantity: mv.quantity,
          signedQuantity: mv.signedQuantity,
          beforeQty: mv.beforeQty,
          afterQty: mv.afterQty,
          refNo: mv.refNo,
        },
        ip: clientIp(req),
      });
      return mv;
    });
    return ok(movement, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}

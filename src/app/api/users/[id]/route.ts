import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { badRequest, invalidBody, notFound, ok, toErrorResponse } from '@/lib/http';
import { userPatchSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { bindParams, getDb, tx } from '@/lib/db';
import { hashPassword, revokeUserSessions } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { nowMs } from '@/lib/ids';
import { getUserById } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/users/[id] —— 权限：user:read */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('user:read');
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    getDb();
    const user = getUserById(id);
    if (!user) return notFound('用户不存在');
    return ok(user);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH /api/users/[id] —— 权限：user:write（改密/停用会撤销其全部会话） */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('user:write');
  if (!guard.ok) return guard.response;
  const actor = guard.value.user;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = userPatchSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);

  const current = getUserById(id);
  if (!current) return notFound('用户不存在');
  const patch = parsed.data;

  if (id === actor.userId && patch.status === 'disabled') {
    return badRequest('不能停用当前登录账号');
  }
  if (patch.roleId) {
    const role = getDb().prepare('SELECT id FROM roles WHERE id = ?').get(patch.roleId) as
      | { id: string }
      | undefined;
    if (!role) return badRequest('角色不存在');
  }

  try {
    const updated = tx(() => {
      const db = getDb();
      db.prepare(
        `UPDATE users SET display_name = ?, role_id = ?, status = ?, updated_at = ? WHERE id = ?`,
      ).run(
        ...bindParams([
          patch.displayName ?? current.displayName,
          patch.roleId ?? current.roleId,
          patch.status ?? current.status,
          nowMs(),
          id,
        ]),
      );
      if (patch.password) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
          ...bindParams([hashPassword(patch.password), id]),
        );
        revokeUserSessions(id);
      }
      if (patch.status === 'disabled') revokeUserSessions(id);

      writeAudit({
        actorId: actor.userId,
        actorName: actor.username,
        action: 'user.update',
        entity: 'user',
        entityId: id,
        detail: {
          username: current.username,
          changed: Object.keys(patch),
          passwordReset: Boolean(patch.password),
        },
        ip: clientIp(req),
      });
      return getUserById(id);
    });
    return ok(updated);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE /api/users/[id] —— 权限：user:write；软删（停用），不能删自己 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('user:write');
  if (!guard.ok) return guard.response;
  const actor = guard.value.user;
  const { id } = await params;

  const current = getUserById(id);
  if (!current) return notFound('用户不存在');
  if (id === actor.userId) return badRequest('不能停用当前登录账号');

  try {
    const updated = tx(() => {
      const db = getDb();
      db.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?").run(
        ...bindParams([nowMs(), id]),
      );
      revokeUserSessions(id);
      writeAudit({
        actorId: actor.userId,
        actorName: actor.username,
        action: 'user.disable',
        entity: 'user',
        entityId: id,
        detail: { username: current.username },
        ip: clientIp(req),
      });
      return getUserById(id);
    });
    return ok({ ...(updated as object), disabled: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

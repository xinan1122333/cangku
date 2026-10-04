import type { NextRequest } from 'next/server';
import { requirePermission, isValidPermission } from '@/lib/rbac';
import { badRequest, invalidBody, notFound, ok, toErrorResponse } from '@/lib/http';
import { rolePatchSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { bindParams, getDb, tx } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { getRole } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/roles/[id] —— 权限：role:read */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('role:read');
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    getDb();
    const role = getRole(id);
    if (!role) return notFound('角色不存在');
    return ok(role);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH /api/roles/[id] —— 改名/改权限；系统角色不允许改动权限，权限：role:write */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('role:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = rolePatchSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);

  const role = getRole(id);
  if (!role) return notFound('角色不存在');
  const patch = parsed.data;

  if (role.isSystem && patch.permissions) {
    return badRequest('系统内置角色的权限不可修改');
  }
  if (patch.permissions) {
    const invalid = patch.permissions.filter((p) => !isValidPermission(p));
    if (invalid.length) return badRequest(`存在无效权限码：${invalid.join(', ')}`);
  }

  try {
    const updated = tx(() => {
      const db = getDb();
      db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?').run(
        ...bindParams([
          patch.name ?? role.name,
          patch.description === undefined ? role.description : patch.description,
          id,
        ]),
      );
      if (patch.permissions) {
        db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
        const stmt = db.prepare(
          'INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)',
        );
        for (const code of patch.permissions) stmt.run(id, code);
      }
      writeAudit({
        actorId: user.userId,
        actorName: user.username,
        action: 'role.update',
        entity: 'role',
        entityId: id,
        detail: { code: role.code, changed: Object.keys(patch), permissions: patch.permissions },
        ip: clientIp(req),
      });
      return getRole(id);
    });
    return ok(updated);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** DELETE /api/roles/[id] —— 系统角色禁删；有用户的角色禁删，权限：role:write */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const guard = await requirePermission('role:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;
  const { id } = await params;

  const role = getRole(id);
  if (!role) return notFound('角色不存在');
  if (role.isSystem) return badRequest('系统内置角色不可删除');
  if ((role.userCount ?? 0) > 0) return badRequest('该角色下仍有用户，无法删除');

  try {
    tx(() => {
      const db = getDb();
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
      db.prepare('DELETE FROM roles WHERE id = ?').run(id);
      writeAudit({
        actorId: user.userId,
        actorName: user.username,
        action: 'role.delete',
        entity: 'role',
        entityId: id,
        detail: { code: role.code },
        ip: clientIp(req),
      });
    });
    return ok({ id, deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

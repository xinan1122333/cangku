import type { NextRequest } from 'next/server';
import { requirePermission, isValidPermission } from '@/lib/rbac';
import { badRequest, invalidBody, ok, toErrorResponse } from '@/lib/http';
import { roleCreateSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { bindParams, getDb, isUniqueViolation, tx } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { newId, nowMs } from '@/lib/ids';
import { listPermissionDict, listRoles } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/roles —— 角色列表 + 权限字典，权限：role:read */
export async function GET() {
  const guard = await requirePermission('role:read');
  if (!guard.ok) return guard.response;
  try {
    getDb();
    return ok({ rows: listRoles(), permissions: listPermissionDict() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/roles —— 新建角色，权限：role:write */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('role:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = roleCreateSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const input = parsed.data;

  const invalid = input.permissions.filter((p) => !isValidPermission(p));
  if (invalid.length) return badRequest(`存在无效权限码：${invalid.join(', ')}`);

  try {
    const db = getDb();
    const id = tx(() => {
      const roleId = newId();
      db.prepare(
        'INSERT INTO roles (id, code, name, description, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      ).run(...bindParams([roleId, input.code, input.name, input.description ?? null, nowMs()]));
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)',
      );
      for (const code of input.permissions) stmt.run(roleId, code);
      writeAudit({
        actorId: user.userId,
        actorName: user.username,
        action: 'role.create',
        entity: 'role',
        entityId: roleId,
        detail: { code: input.code, permissions: input.permissions },
        ip: clientIp(req),
      });
      return roleId;
    });

    const roles = listRoles().filter((r) => r.id === id);
    return ok(roles[0], 201);
  } catch (err) {
    if (isUniqueViolation(err)) return badRequest('角色代码已存在');
    return toErrorResponse(err);
  }
}

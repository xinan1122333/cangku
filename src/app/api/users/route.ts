import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { badRequest, invalidBody, ok, parsePaging, toErrorResponse } from '@/lib/http';
import { userCreateSchema } from '@/lib/validate';
import { clientIp } from '@/lib/http';
import { bindParams, getDb, tx } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { newId, nowMs } from '@/lib/ids';
import { AppError, getUserById, getUserByUsername, listUsers } from '@/lib/store';
import { isUniqueViolation } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/users —— 权限：user:read */
export async function GET(req: NextRequest) {
  const guard = await requirePermission('user:read');
  if (!guard.ok) return guard.response;
  const url = new URL(req.url);
  const { page, pageSize, offset } = parsePaging(url);
  try {
    getDb();
    const { rows, total } = listUsers({
      q: url.searchParams.get('q')?.trim() || undefined,
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

/** POST /api/users —— 权限：user:write */
export async function POST(req: NextRequest) {
  const guard = await requirePermission('user:write');
  if (!guard.ok) return guard.response;
  const { user } = guard.value;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = userCreateSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const input = parsed.data;

  try {
    const db = getDb();
    if (getUserByUsername(input.username)) return badRequest('用户名已存在');
    const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(input.roleId) as { id: string } | undefined;
    if (!role) return badRequest('角色不存在');

    const created = tx(() => {
      const id = newId();
      const now = nowMs();
      db.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ...bindParams([
          id,
          input.username,
          input.displayName,
          hashPassword(input.password),
          input.roleId,
          input.status ?? 'active',
          now,
          now,
        ]),
      );
      writeAudit({
        actorId: user.userId,
        actorName: user.username,
        action: 'user.create',
        entity: 'user',
        entityId: id,
        detail: { username: input.username, roleId: input.roleId },
        ip: clientIp(req),
      });
      return getUserById(id);
    });
    return ok(created, 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'CONFLICT', '用户名已存在');
    return toErrorResponse(err);
  }
}

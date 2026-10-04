import type { NextRequest } from 'next/server';
import { requireUser } from '@/lib/rbac';
import { badRequest, invalidBody, ok } from '@/lib/http';
import { changePasswordSchema } from '@/lib/validate';
import { bindParams, getDb, tx } from '@/lib/db';
import { hashPassword, revokeUserSessions, verifyPassword } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { clientIp } from '@/lib/http';
import { nowMs } from '@/lib/ids';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/me/password —— 修改自己的密码（改完撤销其他会话） */
export async function POST(req: NextRequest) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;
  const { user } = guard.value;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('请求体必须是合法 JSON');
  }
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);

  const db = getDb();
  const row = db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(user.userId) as
    | { hash: string }
    | undefined;
  if (!row) return badRequest('用户不存在');
  if (!verifyPassword(parsed.data.oldPassword, row.hash)) {
    return badRequest('原密码不正确');
  }

  tx(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      ...bindParams([hashPassword(parsed.data.newPassword), nowMs(), user.userId]),
    );
    revokeUserSessions(user.userId);
    writeAudit({
      actorId: user.userId,
      actorName: user.username,
      action: 'user.change_password',
      entity: 'user',
      entityId: user.userId,
      ip: clientIp(req),
    });
  });

  return ok({ changed: true, reLoginRequired: true });
}

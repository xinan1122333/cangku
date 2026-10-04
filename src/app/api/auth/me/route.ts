import { getSession } from '@/lib/auth';
import { ok, unauthorized } from '@/lib/http';
import type { SessionUserDto } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/auth/me —— 当前登录用户 */
export async function GET() {
  const user = await getSession();
  if (!user) return unauthorized();
  const dto: SessionUserDto = {
    id: user.userId,
    username: user.username,
    displayName: user.displayName,
    role: user.roleCode,
    roleName: user.roleName,
    permissions: user.permissions,
  };
  return ok(dto);
}

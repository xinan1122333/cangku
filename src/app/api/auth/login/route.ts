import type { NextRequest } from 'next/server';
import { authenticate, SESSION_COOKIE } from '@/lib/auth';
import { applySchema, getDb, txAsync } from '@/lib/db';
import { clientIp, fail, invalidBody, ok } from '@/lib/http';
import { loginSchema } from '@/lib/validate';
import { sessionDays } from '@/lib/db';
import type { SessionUserDto } from '@/types/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/auth/login —— 登录并下发 HttpOnly Cookie `wms_session` */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'BAD_REQUEST', '请求体必须是合法 JSON');
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);

  // 首次调用时确保表结构存在（生产由 scripts/db-init.mjs 负责）
  applySchema(getDb());

  const result = await authenticate(parsed.data.username, parsed.data.password, clientIp(req));
  if (!result.ok) return fail(401, 'UNAUTHORIZED', result.reason);

  const dto: SessionUserDto = {
    id: result.data.user.userId,
    username: result.data.user.username,
    displayName: result.data.user.displayName,
    role: result.data.user.roleCode,
    roleName: result.data.user.roleName,
    permissions: result.data.user.permissions,
  };

  const res = ok(dto);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: result.data.token,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionDays() * 24 * 60 * 60,
  });
  return res;
}

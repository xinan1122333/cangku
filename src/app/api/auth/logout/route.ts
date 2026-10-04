import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, getSession, sessionFromToken, revokeSession } from '@/lib/auth';
import { tx } from '@/lib/db';
import { clientIp, ok } from '@/lib/http';
import { writeAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/auth/logout —— 撤销当前会话并清 Cookie */
export async function POST(req: NextRequest) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const user = await getSession();

  if (token) {
    const found = await sessionFromToken(token);
    if (found) {
      tx(() => {
        revokeSession(found.sessionId);
        writeAudit({
          actorId: found.user.userId,
          actorName: found.user.username,
          action: 'logout',
          entity: 'session',
          entityId: found.sessionId,
          ip: clientIp(req),
        });
      });
    }
  }

  const res = ok({ loggedOut: true, username: user?.username ?? null });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}

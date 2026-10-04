import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { bindParams, getDb, jwtSecret, sessionDays, txAsync } from './db';
import { newId, nowMs } from './ids';
import { writeAudit } from './audit';

export const SESSION_COOKIE = 'wms_session';

/** 当前登录用户（对外暴露给路由与页面） */
export interface SessionUser {
  userId: string;
  username: string;
  displayName: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
}

export interface LoginSuccess {
  user: SessionUser;
  token: string;
  expiresAt: number;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 取角色的权限码列表（admin 的 `*` 存在库里，是否放行由 hasPermission 判定） */
export function rolePermissions(roleId: string): string[] {
  const rows = getDb()
    .prepare('SELECT permission_code AS code FROM role_permissions WHERE role_id = ? ORDER BY permission_code')
    .all(roleId) as { code: string }[];
  return rows.map((r) => r.code);
}

/** 权限校验：拥有 "*" 视为全部权限 */
export function hasPermission(permissions: string[], code: string): boolean {
  return permissions.includes('*') || permissions.includes(code);
}

export function hasAnyPermission(permissions: string[], codes: string[]): boolean {
  return codes.some((c) => hasPermission(permissions, c));
}

/**
 * 签发 JWT（HS256，默认 7 天）并写入 sessions 表记录 token_hash。
 * 必须在事务内调用，保证「会话记录 + 审计」原子。
 */
export async function issueSession(userId: string): Promise<{ token: string; expiresAt: number; sessionId: string }> {
  const db = getDb();
  const days = sessionDays();
  const expiresAt = nowMs() + days * 24 * 60 * 60 * 1000;
  const sessionId = newId();
  const token = await new SignJWT({ sid: sessionId, uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(jwtSecret());
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(...bindParams([sessionId, userId, sha256(token), expiresAt, nowMs()]));
  return { token, expiresAt, sessionId };
}

/** 用 token 反查会话（校验未撤销、未过期、摘要一致、账号启用） */
export async function sessionFromToken(token: string): Promise<{ user: SessionUser; sessionId: string } | null> {
  let payload: { sid?: unknown; uid?: unknown };
  try {
    const verified = await jwtVerify(token, jwtSecret());
    payload = verified.payload as { sid?: unknown; uid?: unknown };
  } catch {
    return null;
  }
  const sid = typeof payload.sid === 'string' ? payload.sid : '';
  const uid = typeof payload.uid === 'string' ? payload.uid : '';
  if (!sid || !uid) return null;

  const row = getDb()
    .prepare(
      `SELECT s.id AS sessionId, s.expires_at AS expiresAt, s.revoked_at AS revokedAt,
              s.token_hash AS tokenHash,
              u.id AS userId, u.username, u.display_name AS displayName, u.status,
              r.id AS roleId, r.code AS roleCode, r.name AS roleName
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE s.id = ? AND s.user_id = ?`,
    )
    .get(sid, uid) as
    | {
        sessionId: string;
        expiresAt: number;
        revokedAt: number | null;
        tokenHash: string;
        userId: string;
        username: string;
        displayName: string;
        status: string;
        roleId: string;
        roleCode: string;
        roleName: string;
      }
    | undefined;
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt <= nowMs()) return null;
  if (row.tokenHash !== sha256(token)) return null;
  if (row.status !== 'active') return null;
  return {
    sessionId: row.sessionId,
    user: {
      userId: row.userId,
      username: row.username,
      displayName: row.displayName,
      roleCode: row.roleCode,
      roleName: row.roleName,
      permissions: rolePermissions(row.roleId),
    },
  };
}

/** 读取当前会话（Cookie -> JWT -> 数据库） */
export async function getSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const found = await sessionFromToken(token);
  return found?.user ?? null;
}

/** 撤销单个会话 */
export function revokeSession(sessionId: string): void {
  getDb()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(...bindParams([nowMs(), sessionId]));
}

/** 撤销某用户全部会话（改密/停用时使用） */
export function revokeUserSessions(userId: string): number {
  return getDb()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(...bindParams([nowMs(), userId])).changes as number;
}

/**
 * 登录校验。成功返回 token（调用方写 Cookie），失败返回统一的中文原因。
 */
export async function authenticate(
  username: string,
  password: string,
  ip: string,
): Promise<{ ok: true; data: LoginSuccess } | { ok: false; reason: string }> {
  const row = getDb()
    .prepare(
      `SELECT u.id, u.username, u.display_name AS displayName, u.password_hash AS passwordHash,
              u.status, u.role_id AS roleId, r.code AS roleCode, r.name AS roleName
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.username = ?`,
    )
    .get(username) as
    | {
        id: string;
        username: string;
        displayName: string;
        passwordHash: string;
        status: string;
        roleId: string;
        roleCode: string;
        roleName: string;
      }
    | undefined;

  if (!row) return { ok: false, reason: '用户名或密码错误' };
  if (!verifyPassword(password, row.passwordHash)) return { ok: false, reason: '用户名或密码错误' };
  if (row.status !== 'active') return { ok: false, reason: '账号已停用，请联系管理员' };

  // 事务内完成：签发会话 + 审计
  const { token, expiresAt } = await txAsync(async () => {
    const issued = await issueSession(row.id);
    writeAudit({
      actorId: row.id,
      actorName: row.username,
      action: 'login',
      entity: 'session',
      entityId: issued.sessionId,
      ip,
    });
    return issued;
  });

  return {
    ok: true,
    data: {
      token,
      expiresAt,
      user: {
        userId: row.id,
        username: row.username,
        displayName: row.displayName,
        roleCode: row.roleCode,
        roleName: row.roleName,
        permissions: rolePermissions(row.roleId),
      },
    },
  };
}

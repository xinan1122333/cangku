import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { SESSION_COOKIE, getSession, hasAnyPermission, hasPermission, type SessionUser } from './auth';
import { forbidden, unauthorized } from './http';
import type { ApiErrorResponse } from '@/types/api';

/** 权限码字典（冻结，见 notes/ARCHITECTURE.md §3） */
export const PERMISSIONS = [
  { code: 'item:read', name: '物料查看', groupName: '物料' },
  { code: 'item:write', name: '物料维护', groupName: '物料' },
  { code: 'stock:read', name: '结存查看', groupName: '库存' },
  { code: 'stock:write', name: '结存调整', groupName: '库存' },
  { code: 'movement:read', name: '流水查看', groupName: '出入库' },
  { code: 'movement:write', name: '出入库登记', groupName: '出入库' },
  { code: 'movement:export', name: '流水导出', groupName: '出入库' },
  { code: 'stocktake:read', name: '盘点查看', groupName: '盘点' },
  { code: 'stocktake:write', name: '盘点录入', groupName: '盘点' },
  { code: 'stocktake:post', name: '盘点过账', groupName: '盘点' },
  { code: 'user:read', name: '用户查看', groupName: '系统' },
  { code: 'user:write', name: '用户维护', groupName: '系统' },
  { code: 'role:read', name: '角色查看', groupName: '系统' },
  { code: 'role:write', name: '角色维护', groupName: '系统' },
  { code: 'audit:read', name: '审计查看', groupName: '系统' },
] as const;

export const PERMISSION_CODES: string[] = PERMISSIONS.map((p) => p.code);

/** 权限码是否合法（`*` 仅管理员角色内部使用，不作为可勾选项） */
export function isValidPermission(code: string): boolean {
  return PERMISSION_CODES.includes(code);
}

/** 内置角色定义（seed 与 roles 接口共用） */
export const SYSTEM_ROLES = [
  {
    code: 'admin',
    name: '系统管理员',
    description: '拥有全部权限',
    permissions: ['*'],
  },
  {
    code: 'keeper',
    name: '仓管员',
    description: '物料、库存、出入库与盘点日常操作',
    permissions: [
      'item:read',
      'item:write',
      'stock:read',
      'stock:write',
      'movement:read',
      'movement:write',
      'stocktake:read',
      'stocktake:write',
    ],
  },
  {
    code: 'auditor',
    name: '审计查看',
    description: '只读 + 流水导出 + 审计日志',
    permissions: [
      'item:read',
      'stock:read',
      'movement:read',
      'movement:export',
      'stocktake:read',
      'audit:read',
    ],
  },
  {
    code: 'viewer',
    name: '只读',
    description: '仅可查看物料与结存',
    permissions: ['item:read', 'stock:read'],
  },
] as const;

export interface AuthContext {
  user: SessionUser;
}

export type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse<ApiErrorResponse> };

/** 需要登录：无会话 401 */
export async function requireUser(): Promise<GuardResult<AuthContext>> {
  const user = await getSession();
  if (!user) return { ok: false, response: unauthorized() };
  return { ok: true, value: { user } };
}

/** 需要权限：无会话 401，无权限 403 */
export async function requirePermission(code: string): Promise<GuardResult<AuthContext>> {
  const user = await getSession();
  if (!user) return { ok: false, response: unauthorized() };
  if (!hasPermission(user.permissions, code)) {
    return { ok: false, response: forbidden(`缺少权限：${code}`) };
  }
  return { ok: true, value: { user } };
}

/** 满足任一权限即可（如盘点详情读写二选一） */
export async function requireAnyPermission(codes: string[]): Promise<GuardResult<AuthContext>> {
  const user = await getSession();
  if (!user) return { ok: false, response: unauthorized() };
  if (!hasAnyPermission(user.permissions, codes)) {
    return { ok: false, response: forbidden(`缺少权限：${codes.join(' 或 ')}`) };
  }
  return { ok: true, value: { user } };
}

export { SESSION_COOKIE };
export type { SessionUser };
export type { NextRequest };

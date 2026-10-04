import { NextResponse } from 'next/server';
import type { ApiErrorCode, ApiErrorResponse, ApiOkResponse } from '@/types/api';

/** 成功响应：{ ok: true, data } */
export function ok<T>(data: T, status = 200): NextResponse<ApiOkResponse<T>> {
  return NextResponse.json({ ok: true as const, data }, { status });
}

/** 失败响应：{ ok: false, error: { code, message, details? } } */
export function fail(
  status: number,
  code: ApiErrorCode | string,
  message: string,
  details?: unknown,
): NextResponse<ApiErrorResponse> {
  const body: ApiErrorResponse = {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
  return NextResponse.json(body, { status });
}

export const badRequest = (message: string, details?: unknown) =>
  fail(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = '未登录或会话已过期') =>
  fail(401, 'UNAUTHORIZED', message);

export const forbidden = (message = '无权限执行该操作') => fail(403, 'FORBIDDEN', message);

export const notFound = (message = '资源不存在') => fail(404, 'NOT_FOUND', message);

export const conflict = (code: string, message: string, details?: unknown) =>
  fail(409, code, message, details);

export const serverError = (message = '服务器内部错误') => fail(500, 'INTERNAL_ERROR', message);

/** 出库防负：库存不足统一 409 INSUFFICIENT_STOCK */
export const insufficientStock = (onHand: number) =>
  fail(409, 'INSUFFICIENT_STOCK', `库存不足，当前结存 ${onHand}`);

interface ZodLikeIssue {
  path: (string | number | symbol)[];
  message: string;
}

/** 把 zod 报错转换成统一的 400 响应 */
export function invalidBody(error: { issues: ZodLikeIssue[] }): NextResponse<ApiErrorResponse> {
  const details = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const first = details[0];
  return badRequest(first ? `参数校验失败：${first.message}` : '参数校验失败', details);
}

/** 读取请求 IP（审计用） */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? '';
}

/** 解析分页参数，page 从 1 开始 */
export function parsePaging(url: URL, defaultPageSize = 20, maxPageSize = 200) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const rawSize = Number(url.searchParams.get('pageSize') ?? String(defaultPageSize)) || defaultPageSize;
  const pageSize = Math.min(maxPageSize, Math.max(1, Math.floor(rawSize)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 把领域异常（AppError）映射成统一响应；未识别异常回落 500。
 * 路由里 catch 后直接 `return toErrorResponse(err)`。
 */
export function toErrorResponse(err: unknown): NextResponse<ApiErrorResponse> {
  const e = err as { status?: number; code?: string; message?: string; details?: unknown } | null;
  if (e && typeof e.status === 'number' && typeof e.code === 'string') {
    return fail(e.status, e.code, e.message ?? '请求失败', e.details);
  }
  console.error('[wms] 未处理异常：', err);
  return serverError();
}

/** 查询参数 -> 布尔（'1'/'true'/'yes' 为真） */
export function parseBool(value: string | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

/**
 * 把 `?from=&to=` 解析成毫秒时间戳。
 * 纯数字按毫秒；否则按日期/日期时间解析（to 只给日期时补到当天 23:59:59.999）。
 */
export function parseTimeParam(value: string | null, endOfDay = false): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoDay) {
    const [, y, m, d] = isoDay;
    const local = new Date(Number(y), Number(m) - 1, Number(d));
    if (endOfDay) local.setHours(23, 59, 59, 999);
    return local.getTime();
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

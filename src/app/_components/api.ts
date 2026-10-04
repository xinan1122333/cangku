/**
 * 统一 API 客户端（ui-dev）。
 *
 * 契约见 notes/ARCHITECTURE.md §4：成功 { ok:true, data }；失败 { ok:false, error:{code,message,details?} }。
 * 业务类型一律复用 core-dev 的 `@/types/api`（唯一契约真源），本文件只做 HTTP 封装与 UI 辅助。
 */

import type {
  ItemDto,
  ItemWithStockDto,
  MovementDto,
  PageResult,
  PermissionDto,
  RoleDto,
  ScanResolveResult,
  SessionUserDto,
  StockRowDto,
  StocktakeDetailDto,
  StocktakeDto,
  StocktakeLineDto,
  UserDto,
} from '@/types/api';

export type {
  ItemDto,
  ItemWithStockDto,
  MovementDto,
  PageResult,
  PermissionDto,
  RoleDto,
  ScanResolveResult,
  SessionUserDto,
  StockRowDto,
  StocktakeDetailDto,
  StocktakeDto,
  StocktakeLineDto,
  UserDto,
};

/** 页面里常用的别名 */
export type Me = SessionUserDto;
export type Item = ItemWithStockDto;
export type Movement = MovementDto;
export type StockRow = StockRowDto;
export type Stocktake = StocktakeDetailDto;
export type StocktakeLine = StocktakeLineDto;
export type User = UserDto;
export type Role = RoleDto;
export type Permission = PermissionDto;
export type Page<T> = PageResult<T>;

/** 后端统一响应外壳 */
export type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
};

/** 带后端错误码的业务异常 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 提取任意异常的可读中文提示 */
export function readErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return '登录已过期，请重新登录';
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return '发生未知错误，请稍后重试';
}

/** 是否为未登录/登录过期 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function errorFromStatus(status: number, code?: string, message?: string): ApiError {
  const fallback: Record<number, string> = {
    400: '提交内容不合法，请检查后重试',
    401: '登录已过期，请重新登录',
    403: '你没有执行该操作的权限',
    404: '数据不存在或已被删除',
    409: '操作冲突，请检查后重试',
    500: '服务器内部错误',
  };
  return new ApiError(
    code || `HTTP_${status}`,
    message || fallback[status] || `请求失败（HTTP ${status}）`,
    status,
  );
}

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 查询参数，undefined / '' / null 会被忽略 */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON 请求体 */
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * 发起同源请求并解开 {ok,data,error} 外壳。
 * 失败时抛出 ApiError（含 code / message / status），由页面展示 message。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = withQuery(path, options.query);
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      // 同源请求默认携带 Cookie（wms_session）
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK_ERROR', '网络连接失败，请检查网络后重试', 0);
  }

  let envelope: ApiEnvelope<T> | null = null;
  const text = await res.text();
  if (text) {
    try {
      envelope = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      envelope = null;
    }
  }

  if (!envelope) {
    if (res.ok) throw new ApiError('BAD_RESPONSE', '服务器返回了无法解析的内容', res.status);
    throw errorFromStatus(res.status);
  }

  if (!envelope.ok) {
    const error = envelope.error;
    throw errorFromStatus(res.status, error?.code, error?.message);
  }

  if (!res.ok) throw errorFromStatus(res.status);

  return envelope.data as T;
}

/** 拼装带查询串的 URL，忽略空值 */
export function withQuery(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): string {
  if (!query) return path;
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/** 打开导出地址（浏览器直接下载，携带 Cookie） */
export function openExport(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): void {
  if (typeof window === 'undefined') return;
  window.location.href = withQuery(path, query);
}

/* ------------------------------------------------------------------ */
/* 容错适配：接口可能返回数组或分页对象，统一成 PageResult              */
/* ------------------------------------------------------------------ */

export function toPageResult<T>(value: unknown, pageSize = 20): PageResult<T> {
  if (Array.isArray(value)) {
    return { rows: value as T[], total: (value as T[]).length, page: 1, pageSize };
  }
  const obj = (value ?? {}) as Partial<PageResult<T>>;
  const rows = Array.isArray(obj.rows) ? obj.rows : [];
  return {
    rows,
    total: typeof obj.total === 'number' ? obj.total : rows.length,
    page: typeof obj.page === 'number' ? obj.page : 1,
    pageSize: typeof obj.pageSize === 'number' ? obj.pageSize : pageSize,
  };
}

/* ------------------------------------------------------------------ */
/* 权限判定（契约 §3 权限码字典）                                       */
/* ------------------------------------------------------------------ */

export function hasPermission(me: Me | null, code: string): boolean {
  if (!me) return false;
  const perms = me.permissions ?? [];
  return perms.includes('*') || perms.includes(code);
}

export function hasAnyPermission(me: Me | null, codes: string[]): boolean {
  return codes.some((code) => hasPermission(me, code));
}

/** 仪表盘聚合数据（若 public/data.json 由 core-dev 生成则可选读取） */
export type DashboardData = {
  itemTotal?: number;
  lowStockCount?: number;
  todayIn?: number;
  todayOut?: number;
  totalOnHand?: number;
  generatedAt?: number;
};

export type { ItemDto as CoreItem };

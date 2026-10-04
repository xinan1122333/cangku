/**
 * 对外类型契约（核心域）。UI / 扫码端一律 `import type { ... } from '@/types/api'`。
 * 与 notes/ARCHITECTURE.md §4 保持一致；变更需先通知 Lead。
 */

// ---------- 统一响应包 ----------
export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  ok: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiOk<T> | ApiErrorResponse;
export type ApiOkResponse<T> = ApiOk<T>;

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_SKU'
  | 'DUPLICATE_BARCODE'
  | 'INSUFFICIENT_STOCK'
  | 'INVALID_STATE'
  | 'INTERNAL_ERROR';

export interface PageResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------- 认证 / 用户 ----------
export type UserStatus = 'active' | 'disabled';

export interface SessionUserDto {
  id: string;
  username: string;
  displayName: string;
  role: string;
  roleName: string;
  permissions: string[];
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  status: UserStatus;
  createdAt: number;
  updatedAt: number;
}

export interface UserCreateRequest {
  username: string;
  displayName: string;
  password: string;
  roleId: string;
  status?: UserStatus;
}

export interface UserPatchRequest {
  displayName?: string;
  password?: string;
  roleId?: string;
  status?: UserStatus;
}

// ---------- 角色 / 权限 ----------
export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  createdAt: number;
  userCount?: number;
}

export interface RoleCreateRequest {
  code: string;
  name: string;
  description?: string | null;
  permissions?: string[];
}

export interface RolePatchRequest {
  name?: string;
  description?: string | null;
  permissions?: string[];
}

export interface PermissionDto {
  code: string;
  name: string;
  groupName: string;
}

// ---------- 物料 ----------
export type ItemStatus = 'active' | 'disabled';

export interface ItemDto {
  id: string;
  sku: string;
  name: string;
  spec: string | null;
  unit: string;
  category: string | null;
  barcode: string | null;
  location: string | null;
  safetyStock: number;
  remark: string | null;
  status: ItemStatus;
  createdAt: number;
  updatedAt: number;
}

/** 列表/详情附带结存 */
export interface ItemWithStockDto extends ItemDto {
  onHand: number;
}

export interface ItemCreateRequest {
  sku: string;
  name: string;
  spec?: string | null;
  unit?: string;
  category?: string | null;
  barcode?: string | null;
  location?: string | null;
  safetyStock?: number;
  remark?: string | null;
  status?: ItemStatus;
}

export type ItemPatchRequest = Partial<ItemCreateRequest>;

// ---------- 结存 ----------
export interface StockRowDto extends ItemDto {
  onHand: number;
  lowStock: boolean;
  lastMovementAt: number | null;
}

// ---------- 流水 ----------
export type MovementType = 'in' | 'out' | 'adjust' | 'stocktake';

export interface MovementDto {
  id: string;
  seq: number;
  itemId: string;
  sku: string;
  itemName: string;
  unit: string;
  type: MovementType;
  quantity: number;
  signedQuantity: number;
  beforeQty: number;
  afterQty: number;
  unitCost: number | null;
  refNo: string | null;
  partner: string | null;
  reason: string | null;
  remark: string | null;
  operatorId: string | null;
  operatorName: string | null;
  occurredAt: number;
  createdAt: number;
}

export interface MovementCreateRequest {
  itemId: string;
  type: Exclude<MovementType, 'stocktake'>;
  /** in / out 必填，恒为正数 */
  quantity?: number;
  /** adjust 必填：目标结存 */
  targetQty?: number;
  unitCost?: number;
  refNo?: string | null;
  partner?: string | null;
  reason?: string | null;
  remark?: string | null;
  occurredAt?: number;
  /** 允许负库存（需 stock:write），仅 out 使用 */
  allowNegative?: boolean;
}

// ---------- 盘点 ----------
export type StocktakeStatus = 'draft' | 'counting' | 'posted' | 'cancelled';

export interface StocktakeLineDto {
  id: string;
  stocktakeId: string;
  itemId: string;
  sku: string;
  itemName: string;
  unit: string;
  location: string | null;
  bookQty: number;
  countedQty: number | null;
  diffQty: number | null;
  remark: string | null;
}

export interface StocktakeDto {
  id: string;
  code: string;
  status: StocktakeStatus;
  location: string | null;
  remark: string | null;
  createdBy: string | null;
  creatorName: string | null;
  createdAt: number;
  postedAt: number | null;
  lineCount?: number;
  diffCount?: number;
}

export interface StocktakeDetailDto extends StocktakeDto {
  lines: StocktakeLineDto[];
}

export interface StocktakeCreateRequest {
  code?: string;
  location?: string | null;
  remark?: string | null;
  /** 不传则导出全部启用物料 */
  lines?: { itemId: string; countedQty?: number; remark?: string | null }[];
}

export interface StocktakePatchRequest {
  action?: 'post' | 'cancel';
  location?: string | null;
  remark?: string | null;
  lines?: { id?: string; itemId?: string; countedQty: number; remark?: string | null }[];
}

// ---------- 扫码 ----------
export interface ScanItemHit {
  kind: 'item';
  code: string;
  item: ItemDto;
  onHand: number;
}

export interface ScanUnknown {
  kind: 'unknown';
  code: string;
}

export type ScanResolveResult = ScanItemHit | ScanUnknown;

// ---------- 健康检查 ----------
export interface HealthDto {
  status: 'ok';
  version: string;
  time: number;
}

// ---------- 审计 ----------
export interface AuditLogDto {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: number;
}

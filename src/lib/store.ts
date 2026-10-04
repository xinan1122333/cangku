/**
 * 核心业务仓储层：物料 / 结存 / 流水 / 盘点 / 用户 / 角色 / 审计 的读写实现。
 *
 * 设计要点（对应 notes/ARCHITECTURE.md §3 §4）：
 * - **movements 是结存的唯一真源**：onHand = SUM(signed_quantity)，不单独维护 stock 表。
 * - 所有「流水插入 + 结存计算 + 审计」必须在同一事务内（调用方用 tx 包裹）。
 * - 入库/出库 quantity 恒为正；adjust 用 targetQty；出库防负返回 INSUFFICIENT_STOCK。
 */
import { bindParams, getDb, isUniqueViolation, uniqueViolationField, tx } from './db';
import { newCode, newId, nowMs } from './ids';
import { nextSeq } from './seq';
import { writeAudit } from './audit';
import { rolePermissions } from './auth';
import type {
  AuditLogDto,
  ItemDto,
  ItemStatus,
  ItemWithStockDto,
  MovementDto,
  MovementType,
  PermissionDto,
  RoleDto,
  StockRowDto,
  StocktakeDetailDto,
  StocktakeLineDto,
  StocktakeStatus,
  UserDto,
  UserStatus,
} from '@/types/api';

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFoundError = (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message);
export const badRequestError = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

/** 出库防负：统一 409 INSUFFICIENT_STOCK */
export const insufficientStockError = (onHand: number) =>
  new AppError(409, 'INSUFFICIENT_STOCK', `库存不足，当前结存 ${onHand}`, { onHand });

export interface Actor {
  userId: string | null;
  displayName: string;
  ip?: string;
}

/** 事务：写操作统一入口 */
export const runInTx = tx;

// ============================================================
// 物料
// ============================================================

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  spec: string | null;
  unit: string;
  category: string | null;
  barcode: string | null;
  location: string | null;
  safety_stock: number;
  remark: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

function toItemDto(row: ItemRow): ItemDto {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    spec: row.spec,
    unit: row.unit,
    category: row.category,
    barcode: row.barcode,
    location: row.location,
    safetyStock: row.safety_stock,
    remark: row.remark,
    status: row.status as ItemStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const ITEM_COLUMNS = `id, sku, name, spec, unit, category, barcode, location,
  safety_stock, remark, status, created_at, updated_at`;

export function getItem(id: string): ItemDto | null {
  const row = getDb().prepare(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
  return row ? toItemDto(row) : null;
}

export function requireItem(id: string): ItemDto {
  const item = getItem(id);
  if (!item) throw notFoundError('物料不存在');
  return item;
}

/** 草稿物料（id 已生成，未落库；所有写操作在同一事务内调用） */
export interface ItemInput {
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

/** 建物料（调用方负责事务）；可顺带写一条期初流水 */
export function createItem(
  input: ItemInput,
  actor: Actor,
  initQty?: { quantity: number; unitCost?: number | null; occurredAt?: number },
  ip?: string,
): ItemWithStockDto {
  const db = getDb();
  const now = nowMs();
  const id = newId();
  try {
    db.prepare(
      `INSERT INTO items (id, sku, name, spec, unit, category, barcode, location,
         safety_stock, remark, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ...bindParams([
        id,
        input.sku,
        input.name,
        input.spec ?? null,
        input.unit || '件',
        input.category ?? null,
        input.barcode ?? null,
        input.location ?? null,
        input.safetyStock ?? 0,
        input.remark ?? null,
        input.status ?? 'active',
        now,
        now,
      ]),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const field = uniqueViolationField(err);
      if (field === 'barcode') throw new AppError(409, 'DUPLICATE_BARCODE', '该条码已被其他物料占用');
      throw new AppError(409, 'DUPLICATE_SKU', 'SKU 已存在，请更换');
    }
    throw err;
  }

  const created = getItem(id);
  if (!created) throw new Error('物料写入后读取失败');

  let onHand = 0;
  if (initQty && initQty.quantity > 0) {
    const mv = insertMovement(
      {
        itemId: id,
        type: 'in',
        quantity: initQty.quantity,
        unitCost: initQty.unitCost ?? null,
        reason: '期初库存',
        occurredAt: initQty.occurredAt,
      },
      actor,
      { skipItemCheck: true },
    );
    onHand = mv.afterQty;
  }

  writeAudit({
    actorId: actor.userId,
    actorName: actor.displayName,
    action: 'item.create',
    entity: 'item',
    entityId: id,
    detail: { sku: input.sku, name: input.name, initQty: initQty?.quantity ?? 0 },
    ip: ip ?? actor.ip ?? null,
  });

  return { ...created, onHand };
}

export interface ItemListQuery {
  q?: string;
  category?: string;
  status?: string;
  page: number;
  pageSize: number;
  offset: number;
  withStock?: boolean;
}

export function listItems(query: ItemListQuery): { rows: ItemWithStockDto[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    where.push('(i.sku LIKE ? OR i.name LIKE ? OR i.barcode LIKE ? OR i.spec LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  if (query.category) {
    where.push('i.category = ?');
    params.push(query.category);
  }
  if (query.status) {
    where.push('i.status = ?');
    params.push(query.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM items i ${clause}`).get(...bindParams(params)) as {
    c: number;
  }).c;

  const rows = db
    .prepare(
      `SELECT ${ITEM_COLUMNS.split(',').map((c) => `i.${c.trim()}`).join(', ')},
              COALESCE((SELECT SUM(m.signed_quantity) FROM movements m WHERE m.item_id = i.id), 0) AS on_hand
         FROM items i ${clause}
        ORDER BY i.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...bindParams([...params, query.pageSize, query.offset])) as unknown as (ItemRow & {
    on_hand: number;
  })[];

  return {
    rows: rows.map((r) => ({ ...toItemDto(r), onHand: r.on_hand })),
    total,
  };
}

/** 修改物料（调用方负责事务） */
export function updateItem(
  id: string,
  patch: Partial<ItemInput>,
  actor: Actor,
  ip?: string,
): ItemWithStockDto {
  const db = getDb();
  const current = requireItem(id);
  const now = nowMs();
  // 部分更新语义：**只有 undefined 才表示「未提供、保持原值」**，
  // null / 0 / '' 都视为调用方显式要求写入的值（null 表示清空）。
  // 统一用 `=== undefined`，不要用 `??`，否则显式传 0 或 null 会被悄悄忽略。
  const next = {
    sku: patch.sku === undefined ? current.sku : patch.sku,
    name: patch.name === undefined ? current.name : patch.name,
    spec: patch.spec === undefined ? current.spec : patch.spec,
    unit: patch.unit === undefined ? current.unit : patch.unit,
    category: patch.category === undefined ? current.category : patch.category,
    barcode: patch.barcode === undefined ? current.barcode : patch.barcode,
    location: patch.location === undefined ? current.location : patch.location,
    safetyStock: patch.safetyStock === undefined ? current.safetyStock : patch.safetyStock,
    remark: patch.remark === undefined ? current.remark : patch.remark,
    status: patch.status === undefined ? current.status : patch.status,
  };
  try {
    db.prepare(
      `UPDATE items SET sku = ?, name = ?, spec = ?, unit = ?, category = ?, barcode = ?,
         location = ?, safety_stock = ?, remark = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      ...bindParams([
        next.sku,
        next.name,
        next.spec,
        next.unit,
        next.category,
        next.barcode,
        next.location,
        next.safetyStock,
        next.remark,
        next.status,
        now,
        id,
      ]),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const field = uniqueViolationField(err);
      if (field === 'barcode') throw new AppError(409, 'DUPLICATE_BARCODE', '该条码已被其他物料占用');
      throw new AppError(409, 'DUPLICATE_SKU', 'SKU 已存在，请更换');
    }
    throw err;
  }

  writeAudit({
    actorId: actor.userId,
    actorName: actor.displayName,
    action: 'item.update',
    entity: 'item',
    entityId: id,
    detail: { before: current, after: next },
    ip: ip ?? actor.ip ?? null,
  });
  return { ...(getItem(id) as ItemDto), onHand: onHandOf(id) };
}

/** 软删（停用）：不物理删除，保留流水 */
export function disableItem(id: string, actor: Actor, ip?: string): ItemDto {
  const db = getDb();
  const current = requireItem(id);
  db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(
    ...bindParams(['disabled', nowMs(), id]),
  );
  writeAudit({
    actorId: actor.userId,
    actorName: actor.displayName,
    action: 'item.disable',
    entity: 'item',
    entityId: id,
    detail: { sku: current.sku },
    ip: ip ?? actor.ip ?? null,
  });
  return getItem(id) as ItemDto;
}

// ============================================================
// 结存
// ============================================================

/** 当前结存 = 该物料所有流水 signed_quantity 之和（唯一真源） */
export function onHandOf(itemId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(signed_quantity), 0) AS on_hand FROM movements WHERE item_id = ?')
    .get(itemId) as { on_hand: number } | undefined;
  return row?.on_hand ?? 0;
}

export interface StockQuery {
  q?: string;
  lowOnly?: boolean;
  category?: string;
  page: number;
  pageSize: number;
  offset: number;
}

export function listStock(query: StockQuery): { rows: StockRowDto[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    where.push('(i.sku LIKE ? OR i.name LIKE ? OR i.barcode LIKE ? OR i.location LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  if (query.category) {
    where.push('i.category = ?');
    params.push(query.category);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const base = `
    SELECT ${ITEM_COLUMNS.split(',').map((c) => `i.${c.trim()}`).join(', ')},
           COALESCE((SELECT SUM(m.signed_quantity) FROM movements m WHERE m.item_id = i.id), 0) AS on_hand,
           (SELECT MAX(m.occurred_at) FROM movements m WHERE m.item_id = i.id) AS last_movement_at
      FROM items i ${clause}`;

  const having = query.lowOnly ? 'WHERE on_hand <= safety_stock' : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM (${base}) t ${having}`).get(...bindParams(params)) as { c: number }
  ).c;

  const rows = db
    .prepare(`${base} ${having} ORDER BY i.sku ASC LIMIT ? OFFSET ?`)
    .all(...bindParams([...params, query.pageSize, query.offset])) as unknown as (ItemRow & {
    on_hand: number;
    last_movement_at: number | null;
  })[];

  return {
    rows: rows.map((r) => ({
      ...toItemDto(r),
      onHand: r.on_hand,
      lowStock: r.on_hand <= r.safety_stock,
      lastMovementAt: r.last_movement_at,
    })),
    total,
  };
}

// ============================================================
// 流水
// ============================================================

const MOVEMENT_SELECT = `
  SELECT m.id, m.seq, m.item_id, i.sku, i.name AS item_name, i.unit,
         m.type, m.quantity, m.signed_quantity, m.before_qty, m.after_qty,
         m.unit_cost, m.ref_no, m.partner, m.reason, m.remark,
         m.operator_id, m.operator_name, m.occurred_at, m.created_at
    FROM movements m JOIN items i ON i.id = m.item_id`;

interface MovementRow {
  id: string;
  seq: number;
  item_id: string;
  sku: string;
  item_name: string;
  unit: string;
  type: string;
  quantity: number;
  signed_quantity: number;
  before_qty: number;
  after_qty: number;
  unit_cost: number | null;
  ref_no: string | null;
  partner: string | null;
  reason: string | null;
  remark: string | null;
  operator_id: string | null;
  operator_name: string | null;
  occurred_at: number;
  created_at: number;
}

function toMovementDto(row: MovementRow): MovementDto {
  return {
    id: row.id,
    seq: row.seq,
    itemId: row.item_id,
    sku: row.sku,
    itemName: row.item_name,
    unit: row.unit,
    type: row.type as MovementType,
    quantity: row.quantity,
    signedQuantity: row.signed_quantity,
    beforeQty: row.before_qty,
    afterQty: row.after_qty,
    unitCost: row.unit_cost,
    refNo: row.ref_no,
    partner: row.partner,
    reason: row.reason,
    remark: row.remark,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export interface MovementInput {
  itemId: string;
  type: Exclude<MovementType, 'stocktake'> | 'stocktake';
  /** in/out：正数 */
  quantity?: number;
  /** adjust：目标结存 */
  targetQty?: number;
  /** stocktake：直接给带符号增量 */
  delta?: number;
  unitCost?: number | null;
  refNo?: string | null;
  partner?: string | null;
  reason?: string | null;
  remark?: string | null;
  occurredAt?: number;
  allowNegative?: boolean;
}

/**
 * 记账核心：结存不足 -> 409；在同一事务内插入流水并返回 DTO。
 * 调用方必须用 tx() 包裹本函数（或其所在流程）。
 */
export function insertMovement(
  input: MovementInput,
  actor: Actor,
  opts: { skipItemCheck?: boolean } = {},
): MovementDto {
  const db = getDb();
  const item = opts.skipItemCheck ? null : requireItem(input.itemId);
  if (!opts.skipItemCheck && item && item.status === 'disabled') {
    throw new AppError(409, 'INVALID_STATE', '物料已停用，无法登记出入库');
  }

  const before = onHandOf(input.itemId);
  let quantity: number;
  let signed: number;

  if (input.type === 'in') {
    quantity = input.quantity ?? 0;
    if (!(quantity > 0)) throw badRequestError('入库数量必须大于 0');
    signed = quantity;
  } else if (input.type === 'out') {
    quantity = input.quantity ?? 0;
    if (!(quantity > 0)) throw badRequestError('出库数量必须大于 0');
    if (before - quantity < 0 && !input.allowNegative) {
      throw insufficientStockError(before);
    }
    signed = -quantity;
  } else if (input.type === 'adjust') {
    const target = input.targetQty;
    if (target === undefined || target === null) throw badRequestError('adjust 必须提供 targetQty');
    if (target < 0) throw badRequestError('adjust 目标数量不能为负');
    signed = target - before;
    quantity = Math.abs(signed);
    if (signed === 0) throw badRequestError('目标数量与当前结存一致，无需调整');
  } else {
    // stocktake：由盘点过账传入带符号增量
    const delta = input.delta ?? 0;
    if (delta === 0) throw badRequestError('盘点差异为 0，无需生成流水');
    signed = delta;
    quantity = Math.abs(delta);
  }

  const after = before + signed;
  const now = nowMs();
  const occurredAt = input.occurredAt ?? now;
  const id = newId();
  const seq = nextSeq(db, 'movement');

  db.prepare(
    `INSERT INTO movements (id, seq, item_id, type, quantity, signed_quantity, before_qty, after_qty,
       unit_cost, ref_no, partner, reason, remark, operator_id, operator_name, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...bindParams([
      id,
      seq,
      input.itemId,
      input.type,
      quantity,
      signed,
      before,
      after,
      input.unitCost ?? null,
      input.refNo ?? null,
      input.partner ?? null,
      input.reason ?? null,
      input.remark ?? null,
      actor.userId,
      actor.displayName,
      occurredAt,
      now,
    ]),
  );

  const row = db.prepare(`${MOVEMENT_SELECT} WHERE m.id = ?`).get(id) as MovementRow | undefined;
  if (!row) throw new Error('流水写入后读取失败');
  return toMovementDto(row);
}

export interface MovementQuery {
  itemId?: string;
  type?: string;
  from?: number;
  to?: number;
  refNo?: string;
  q?: string;
  page: number;
  pageSize: number;
  offset: number;
}

export function listMovements(query: MovementQuery): { rows: MovementDto[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.itemId) {
    where.push('m.item_id = ?');
    params.push(query.itemId);
  }
  if (query.type) {
    where.push('m.type = ?');
    params.push(query.type);
  }
  if (query.from !== undefined) {
    where.push('m.occurred_at >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push('m.occurred_at <= ?');
    params.push(query.to);
  }
  if (query.refNo) {
    where.push('m.ref_no LIKE ?');
    params.push(`%${query.refNo}%`);
  }
  if (query.q) {
    where.push('(i.sku LIKE ? OR i.name LIKE ? OR m.partner LIKE ? OR m.remark LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM movements m JOIN items i ON i.id = m.item_id ${clause}`)
      .get(...bindParams(params)) as { c: number }
  ).c;

  const rows = db
    .prepare(`${MOVEMENT_SELECT} ${clause} ORDER BY m.seq DESC LIMIT ? OFFSET ?`)
    .all(...bindParams([...params, query.pageSize, query.offset])) as unknown as MovementRow[];

  return { rows: rows.map(toMovementDto), total };
}

/** 导出用：不分页，按发生时间正序（上限保护） */
export function listMovementsForExport(query: Omit<MovementQuery, 'page' | 'pageSize' | 'offset'>, limit = 50000) {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.itemId) {
    where.push('m.item_id = ?');
    params.push(query.itemId);
  }
  if (query.type) {
    where.push('m.type = ?');
    params.push(query.type);
  }
  if (query.from !== undefined) {
    where.push('m.occurred_at >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push('m.occurred_at <= ?');
    params.push(query.to);
  }
  if (query.refNo) {
    where.push('m.ref_no LIKE ?');
    params.push(`%${query.refNo}%`);
  }
  if (query.q) {
    where.push('(i.sku LIKE ? OR i.name LIKE ? OR m.partner LIKE ? OR m.remark LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`${MOVEMENT_SELECT} ${clause} ORDER BY m.seq ASC LIMIT ?`)
    .all(...bindParams([...params, limit])) as unknown as MovementRow[];
  return rows.map(toMovementDto);
}

export function getMovement(id: string): MovementDto | null {
  const row = getDb().prepare(`${MOVEMENT_SELECT} WHERE m.id = ?`).get(id) as MovementRow | undefined;
  return row ? toMovementDto(row) : null;
}

// ============================================================
// 盘点
// ============================================================

interface StocktakeRow {
  id: string;
  code: string;
  status: string;
  location: string | null;
  remark: string | null;
  created_by: string | null;
  created_at: number;
  posted_at: number | null;
  creator_name?: string | null;
  line_count?: number;
  diff_count?: number;
}

function toStocktakeDto(row: StocktakeRow): StocktakeDetailDto {
  return {
    id: row.id,
    code: row.code,
    status: row.status as StocktakeStatus,
    location: row.location,
    remark: row.remark,
    createdBy: row.created_by,
    creatorName: row.creator_name ?? null,
    createdAt: row.created_at,
    postedAt: row.posted_at,
    lineCount: row.line_count,
    diffCount: row.diff_count,
    lines: [],
  };
}

const STOCKTAKE_SELECT = `
  SELECT s.*, u.display_name AS creator_name,
         (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id) AS line_count,
         (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id AND l.diff_qty <> 0) AS diff_count
    FROM stocktakes s LEFT JOIN users u ON u.id = s.created_by`;

export function listStocktakes(query: {
  status?: string;
  q?: string;
  page: number;
  pageSize: number;
  offset: number;
}): { rows: StocktakeDetailDto[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    where.push('s.status = ?');
    params.push(query.status);
  }
  if (query.q) {
    where.push('(s.code LIKE ? OR s.location LIKE ? OR s.remark LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM stocktakes s ${clause}`).get(...bindParams(params)) as { c: number }
  ).c;
  const rows = db
    .prepare(`${STOCKTAKE_SELECT} ${clause} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`)
    .all(...bindParams([...params, query.pageSize, query.offset])) as unknown as StocktakeRow[];
  return { rows: rows.map((r) => ({ ...toStocktakeDto(r), lines: [] })), total };
}

function loadLines(stocktakeId: string): StocktakeLineDto[] {
  const rows = getDb()
    .prepare(
      `SELECT l.id, l.stocktake_id, l.item_id, i.sku, i.name AS item_name, i.unit, i.location,
              l.book_qty, l.counted_qty, l.diff_qty, l.remark
         FROM stocktake_lines l JOIN items i ON i.id = l.item_id
        WHERE l.stocktake_id = ?
        ORDER BY i.sku ASC`,
    )
    .all(stocktakeId) as {
    id: string;
    stocktake_id: string;
    item_id: string;
    sku: string;
    item_name: string;
    unit: string;
    location: string | null;
    book_qty: number;
    counted_qty: number | null;
    diff_qty: number | null;
    remark: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    stocktakeId: r.stocktake_id,
    itemId: r.item_id,
    sku: r.sku,
    itemName: r.item_name,
    unit: r.unit,
    location: r.location,
    bookQty: r.book_qty,
    countedQty: r.counted_qty,
    diffQty: r.diff_qty,
    remark: r.remark,
  }));
}

export function getStocktake(id: string): StocktakeDetailDto | null {
  const row = getDb().prepare(`${STOCKTAKE_SELECT} WHERE s.id = ?`).get(id) as StocktakeRow | undefined;
  if (!row) return null;
  return { ...toStocktakeDto(row), lines: loadLines(id) };
}

/**
 * 创建盘点单。lines 为空时自动带出全部启用物料的账面结存（快照 bookQty）。
 * 调用方负责事务。
 */
export function createStocktake(
  input: {
    code?: string;
    location?: string | null;
    remark?: string | null;
    lines?: { itemId: string; countedQty?: number; remark?: string | null }[];
  },
  actor: Actor,
  ip?: string,
): StocktakeDetailDto {
  const db = getDb();
  const now = nowMs();
  const id = newId();
  const code = input.code?.trim() || newCode('PD');

  try {
    db.prepare(
      `INSERT INTO stocktakes (id, code, status, location, remark, created_by, created_at, posted_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, NULL)`,
    ).run(...bindParams([id, code, input.location ?? null, input.remark ?? null, actor.userId, now]));
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, 'CONFLICT', '盘点单号已存在，请更换');
    throw err;
  }

  const insertLine = db.prepare(
    `INSERT INTO stocktake_lines (id, stocktake_id, item_id, book_qty, counted_qty, diff_qty, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const requested = input.lines ?? [];
  if (requested.length === 0) {
    // 全量盘点：自动带出启用物料
    const items = db.prepare("SELECT id FROM items WHERE status = 'active' ORDER BY sku ASC").all() as {
      id: string;
    }[];
    for (const it of items) {
      const book = onHandOf(it.id);
      insertLine.run(...bindParams([newId(), id, it.id, book, null, null, null]));
    }
  } else {
    const seen = new Set<string>();
    for (const line of requested) {
      if (seen.has(line.itemId)) continue;
      seen.add(line.itemId);
      requireItem(line.itemId);
      const book = onHandOf(line.itemId);
      const counted = line.countedQty ?? null;
      insertLine.run(
        ...bindParams([
          newId(),
          id,
          line.itemId,
          book,
          counted,
          counted === null ? null : counted - book,
          line.remark ?? null,
        ]),
      );
    }
  }

  writeAudit({
    actorId: actor.userId,
    actorName: actor.displayName,
    action: 'stocktake.create',
    entity: 'stocktake',
    entityId: id,
    detail: { code, lines: requested.length || 'all' },
    ip: ip ?? actor.ip ?? null,
  });
  return getStocktake(id) as StocktakeDetailDto;
}

/** 录入实盘（调用方负责事务） */
export function updateStocktake(
  id: string,
  patch: {
    location?: string | null;
    remark?: string | null;
    lines?: { id?: string; itemId?: string; countedQty: number; remark?: string | null }[];
  },
  actor: Actor,
  ip?: string,
): StocktakeDetailDto {
  const db = getDb();
  const sheet = getStocktake(id);
  if (!sheet) throw notFoundError('盘点单不存在');
  if (sheet.status === 'posted') throw new AppError(409, 'INVALID_STATE', '盘点单已过账，不能再修改');
  if (sheet.status === 'cancelled') throw new AppError(409, 'INVALID_STATE', '盘点单已作废，不能再修改');

  if (patch.location !== undefined || patch.remark !== undefined) {
    db.prepare('UPDATE stocktakes SET location = ?, remark = ? WHERE id = ?').run(
      ...bindParams([
        patch.location === undefined ? sheet.location : patch.location,
        patch.remark === undefined ? sheet.remark : patch.remark,
        id,
      ]),
    );
  }

  let counted = 0;
  if (patch.lines?.length) {
    for (const line of patch.lines) {
      const target = line.id
        ? db
            .prepare('SELECT id, item_id, book_qty FROM stocktake_lines WHERE id = ? AND stocktake_id = ?')
            .get(line.id, id)
        : db
            .prepare('SELECT id, item_id, book_qty FROM stocktake_lines WHERE item_id = ? AND stocktake_id = ?')
            .get(line.itemId ?? '', id);
      const row = target as { id: string; item_id: string; book_qty: number } | undefined;
      if (!row) throw notFoundError('盘点明细不存在');
      db.prepare('UPDATE stocktake_lines SET counted_qty = ?, diff_qty = ?, remark = ? WHERE id = ?').run(
        ...bindParams([
          line.countedQty,
          line.countedQty - row.book_qty,
          line.remark ?? null,
          row.id,
        ]),
      );
      counted += 1;
    }
  }

  // 有实盘录入就进入 counting 状态
  if (sheet.status === 'draft' && counted > 0) {
    db.prepare("UPDATE stocktakes SET status = 'counting' WHERE id = ?").run(id);
  }

  writeAudit({
    actorId: actor.userId,
    actorName: actor.displayName,
    action: 'stocktake.update',
    entity: 'stocktake',
    entityId: id,
    detail: { code: sheet.code, countedLines: counted },
    ip: ip ?? actor.ip ?? null,
  });
  return getStocktake(id) as StocktakeDetailDto;
}

/**
 * 盘点过账：按实盘数量生成 stocktake 流水，把结存调整到实盘值。
 * 全部在**同一事务**内完成；已过账/已作废的单据拒绝重复过账。
 */
export function postStocktake(id: string, actor: Actor, ip?: string): StocktakeDetailDto {
  const db = getDb();
  const sheet = getStocktake(id);
  if (!sheet) throw notFoundError('盘点单不存在');
  if (sheet.status === 'posted') throw new AppError(409, 'INVALID_STATE', '盘点单已过账，不能重复过账');
  if (sheet.status === 'cancelled') throw new AppError(409, 'INVALID_STATE', '盘点单已作废，无法过账');

  const lines = sheet.lines.filter((l) => l.countedQty !== null);
  if (lines.length === 0) throw new AppError(409, 'INVALID_STATE', '没有录入任何实盘数量，无法过账');

  let posted = 0;
  for (const line of lines) {
    const current = onHandOf(line.itemId);
    const delta = (line.countedQty as number) - current;
    // 差异为 0 也要把 bookQty 校准为当前结存，但不写流水
    db.prepare('UPDATE stocktake_lines SET book_qty = ?, diff_qty = ? WHERE id = ?').run(
      ...bindParams([current, delta, line.id]),
    );
    if (delta === 0) continue;
    insertMovement(
      {
        itemId: line.itemId,
        type: 'stocktake',
        delta,
        refNo: sheet.code,
        reason: '盘点过账',
        remark: line.remark,
      },
      actor,
    );
    posted += 1;
  }

  const now = nowMs();
  db.prepare("UPDATE stocktakes SET status = 'posted', posted_at = ? WHERE id = ?").run(
    ...bindParams([now, id]),
  );
  writeAudit({
    actorId: actor.userId,
    actorName: actor.displayName,
    action: 'stocktake.post',
    entity: 'stocktake',
    entityId: id,
    detail: { code: sheet.code, postedLines: posted, totalLines: lines.length },
    ip: ip ?? actor.ip ?? null,
  });
  return getStocktake(id) as StocktakeDetailDto;
}

/** 作废盘点单（调用方负责事务） */
export function cancelStocktake(id: string, actor: Actor, ip?: string): StocktakeDetailDto {
  const sheet = getStocktake(id);
  if (!sheet) throw notFoundError('盘点单不存在');
  if (sheet.status === 'posted') throw new AppError(409, 'INVALID_STATE', '盘点单已过账，不能作废');
  if (sheet.status === 'cancelled') throw new AppError(409, 'INVALID_STATE', '盘点单已作废');
  getDb().prepare("UPDATE stocktakes SET status = 'cancelled' WHERE id = ?").run(id);
  writeAudit({
    actorId: actor.userId,
    actorName: actor.displayName,
    action: 'stocktake.cancel',
    entity: 'stocktake',
    entityId: id,
    detail: { code: sheet.code },
    ip: ip ?? actor.ip ?? null,
  });
  return getStocktake(id) as StocktakeDetailDto;
}

// ============================================================
// 用户
// ============================================================

const USER_SELECT = `
  SELECT u.id, u.username, u.display_name, u.role_id, u.status, u.created_at, u.updated_at,
         r.code AS role_code, r.name AS role_name
    FROM users u JOIN roles r ON r.id = u.role_id`;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  role_code: string;
  role_name: string;
}

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleId: row.role_id,
    roleCode: row.role_code,
    roleName: row.role_name,
    status: row.status as UserStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUsers(query: {
  q?: string;
  status?: string;
  page: number;
  pageSize: number;
  offset: number;
}): { rows: UserDto[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.q) {
    where.push('(u.username LIKE ? OR u.display_name LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  if (query.status) {
    where.push('u.status = ?');
    params.push(query.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM users u ${clause}`).get(...bindParams(params)) as { c: number }
  ).c;
  const rows = db
    .prepare(`${USER_SELECT} ${clause} ORDER BY u.created_at ASC LIMIT ? OFFSET ?`)
    .all(...bindParams([...params, query.pageSize, query.offset])) as unknown as UserRow[];
  return { rows: rows.map(toUserDto), total };
}

export function getUserById(id: string): UserDto | null {
  const row = getDb().prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow | undefined;
  return row ? toUserDto(row) : null;
}

export function getUserByUsername(username: string): UserDto | null {
  const row = getDb().prepare(`${USER_SELECT} WHERE u.username = ?`).get(username) as UserRow | undefined;
  return row ? toUserDto(row) : null;
}

export { hashPassword } from './auth';

// ============================================================
// 角色
// ============================================================

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_system: number;
  created_at: number;
  user_count?: number;
}

function toRoleDto(row: RoleRow): RoleDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.is_system === 1,
    permissions: rolePermissions(row.id),
    createdAt: row.created_at,
    userCount: row.user_count,
  };
}

export function listRoles(): RoleDto[] {
  const rows = getDb()
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
         FROM roles r ORDER BY r.is_system DESC, r.created_at ASC`,
    )
    .all() as unknown as RoleRow[];
  return rows.map(toRoleDto);
}

export function getRole(id: string): RoleDto | null {
  const row = getDb()
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
         FROM roles r WHERE r.id = ?`,
    )
    .get(id) as RoleRow | undefined;
  return row ? toRoleDto(row) : null;
}

export function listPermissionDict(): PermissionDto[] {
  const rows = getDb()
    .prepare('SELECT code, name, group_name FROM permissions ORDER BY group_name, code')
    .all() as { code: string; name: string; group_name: string }[];
  return rows.map((r) => ({ code: r.code, name: r.name, groupName: r.group_name }));
}

// ============================================================
// 审计
// ============================================================

export function listAuditLogs(query: {
  entity?: string;
  action?: string;
  actorId?: string;
  page: number;
  pageSize: number;
  offset: number;
}): { rows: AuditLogDto[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.entity) {
    where.push('entity = ?');
    params.push(query.entity);
  }
  if (query.action) {
    where.push('action LIKE ?');
    params.push(`%${query.action}%`);
  }
  if (query.actorId) {
    where.push('actor_id = ?');
    params.push(query.actorId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${clause}`).get(...bindParams(params)) as { c: number }
  ).c;
  const rows = db
    .prepare(`SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...bindParams([...params, query.pageSize, query.offset])) as {
    id: string;
    actor_id: string | null;
    actor_name: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    detail_json: string | null;
    ip: string | null;
    created_at: number;
  }[];
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      detail: r.detail_json ? safeJson(r.detail_json) : null,
      ip: r.ip,
      createdAt: r.created_at,
    })),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 按条码精确匹配，其次 SKU 精确匹配（扫码约定 §6） */
export function resolveScanCode(code: string): ItemWithStockDto | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE barcode = ?
       UNION ALL
       SELECT ${ITEM_COLUMNS} FROM items WHERE sku = ? LIMIT 1`,
    )
    .get(code, code) as ItemRow | undefined;
  if (!row) return null;
  return { ...toItemDto(row), onHand: onHandOf(row.id) };
}

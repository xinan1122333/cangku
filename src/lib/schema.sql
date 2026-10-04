-- WMS 数据库结构（严格对应 notes/ARCHITECTURE.md §3）
-- 约定：主键 TEXT（UUID v4）；时间 INTEGER（Unix 毫秒）；数量 INTEGER（最小单位整数）

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 用户与权限 ----------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id       TEXT NOT NULL REFERENCES roles(id),
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- 权限字典（由代码注册）
CREATE TABLE IF NOT EXISTS permissions (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  group_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);

-- 可选表：JWT 为主，这里保存 token_hash 便于撤销
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------- 物料 ----------
CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  spec          TEXT,
  unit          TEXT NOT NULL DEFAULT '件',
  category      TEXT,
  barcode       TEXT UNIQUE,
  location      TEXT,
  safety_stock  INTEGER NOT NULL DEFAULT 0,
  remark        TEXT,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);

-- ---------- 进出一流水（唯一真源） ----------
CREATE TABLE IF NOT EXISTS movements (
  id              TEXT PRIMARY KEY,
  seq             INTEGER NOT NULL,
  item_id         TEXT NOT NULL REFERENCES items(id),
  type            TEXT NOT NULL,                  -- in | out | adjust | stocktake
  quantity        INTEGER NOT NULL,               -- 恒为正数
  signed_quantity INTEGER NOT NULL,               -- in:+qty out:-qty adjust/stocktake:±delta
  before_qty      INTEGER NOT NULL,
  after_qty       INTEGER NOT NULL,
  unit_cost       INTEGER,                        -- 分
  ref_no          TEXT,
  partner         TEXT,
  reason          TEXT,
  remark          TEXT,
  operator_id     TEXT,
  operator_name   TEXT,
  occurred_at     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_item_time ON movements(item_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_movements_type_time ON movements(type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_movements_seq ON movements(seq);

-- 业务序号发号器（seq 单调递增，事务内取号）
CREATE TABLE IF NOT EXISTS seq_counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- ---------- 盘点 ----------
CREATE TABLE IF NOT EXISTS stocktakes (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'draft',       -- draft | counting | posted | cancelled
  location   TEXT,
  remark     TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  posted_at  INTEGER
);

CREATE TABLE IF NOT EXISTS stocktake_lines (
  id           TEXT PRIMARY KEY,
  stocktake_id TEXT NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES items(id),
  book_qty     INTEGER NOT NULL DEFAULT 0,
  counted_qty  INTEGER,
  diff_qty     INTEGER,
  remark       TEXT
);
CREATE INDEX IF NOT EXISTS idx_stocktake_lines_sheet ON stocktake_lines(stocktake_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktake_lines_item ON stocktake_lines(stocktake_id, item_id);

-- ---------- 审计日志 ----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  detail_json TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

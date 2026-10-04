# WMS 架构约定（冻结契约）

> 本文件是团队共享的**唯一契约真源**。所有 teammate 必须遵守；如需变更，先通知 Lead。

## 1. 技术栈（已定稿）

- Next.js 16.3.8（App Router）+ React 19 + TypeScript
- **`node:sqlite`（Node 24 内置，`DatabaseSync`）** —— ⚠️ 见下方「原生模块决策」
- jose 6（JWT 会话，HttpOnly Cookie）
- bcryptjs 3（密码哈希，纯 JS 无原生依赖）
- zod 4（入参校验）
- html5-qrcode 2.3.8（手机浏览器扫码，走 getUserMedia，**必须 HTTPS 或 localhost**）
- 样式：手写 CSS（`globals.css`），**不使用 Tailwind**（原因见下）

### ⚠️ 原生模块决策（2026-10-04 由 Lead 裁定，全员遵守）

本机 DSH 文件沙箱禁止进程通过管道 spawn 子进程（`EPERM: spawn`），因此 **npm 安装脚本无法运行**：
`better-sqlite3` 的 `prebuild-install`/`node-gyp` 和 `@tailwindcss/oxide` 的 postinstall 全部失败，
原生 `.node` 二进制无法落地。实测 `require('better-sqlite3')` → `Cannot find module 'bindings'`。

因此：

1. **数据库改用 Node 24 内置的 `node:sqlite`**：`import { DatabaseSync } from "node:sqlite"`。
   - 它内置 SQLite 引擎，与 better-sqlite3 **同为同步 API**，`prepare/run/get/all/exec` 语义几乎一致。
   - 已验证可用（本机 node 24.21.0 实测建表插入查询通过）。
   - `package.json` 里的 `better-sqlite3` 依赖已移除，`next.config.ts` 的 `serverExternalPackages` 相应清理。
   - 差异注意：`node:sqlite` 的 `run()` 返回 `{ changes, lastInsertRowid }`；**默认不支持命名参数以外的隐式类型**，
     布尔值需转 0/1；`INTEGER` 一律用 JS number。绑定参数只接受 null/number/string/bigint/Uint8Array。
2. **不使用 Tailwind**：`@tailwindcss/oxide` 是必需的原生依赖，装不上。改用 `globals.css` 手写样式 + CSS 变量，
   移动端优先（`@media (max-width: 640px)`）。已从 `package.json` 移除 `tailwindcss`/`@tailwindcss/postcss`。
3. 任何新增依赖**必须是纯 JS**，不能带 postinstall/原生编译。引入前先问 Lead。
4. 部署到 Linux 服务器时可自由换回 better-sqlite3 + Tailwind；但**当前交付以本条为准**，不要擅自改回。


## 2. 目录布局（冻结，禁止越界写他人目录）

```
wms/
  package.json  tsconfig.json  next.config.ts  postcss.config.mjs
  .env.example  README.md
  notes/ARCHITECTURE.md            # 本文件（Lead 独占）
  src/
    lib/                           # ★ core-dev 独占
      db.ts  schema.sql  auth.ts  rbac.ts  audit.ts  ids.ts  seq.ts  validate.ts  http.ts
    app/
      layout.tsx  globals.css  page.tsx        # ★ core-dev
      login/page.tsx                           # ★ core-dev
      scan/page.tsx                            # ★ scan-dev
      api/
        auth/login/route.ts  auth/logout/route.ts  auth/me/route.ts   # ★ core-dev
        items/route.ts  items/[id]/route.ts                           # ★ core-dev
        stock/route.ts                                                # ★ core-dev
        movements/route.ts  movements/[id]/route.ts                   # ★ core-dev
        stocktakes/route.ts  stocktakes/[id]/route.ts                 # ★ core-dev
        users/route.ts  users/[id]/route.ts                           # ★ core-dev
        roles/route.ts  roles/[id]/route.ts                           # ★ core-dev
        me/password/route.ts                                          # ★ core-dev
        scan/resolve/route.ts                                         # ★ scan-dev
        health/route.ts                                               # ★ core-dev
        export/movements/route.ts                                     # ★ ui-dev
      (app)/                                    # 登录后的界面外壳
        layout.tsx  page.tsx (仪表盘)            # ★ ui-dev
        items/page.tsx  movements/page.tsx  stocktakes/page.tsx
        users/page.tsx  roles/page.tsx          # ★ ui-dev
      _components/                              # ★ ui-dev
    types/api.ts                                # ★ core-dev（对外类型契约）
  scripts/db-init.mjs  scripts/seed.mjs
  tests/*.test.mjs
  data/                                         # SQLite 文件（gitignore）
```

**写作用域规则**：只写「★ 你的名字」标记的文件/目录。需要别人改动时，发消息给对应 owner。

## 3. 数据模型（SQLite，冻结）

所有主键为 TEXT（UUID v4）。时间为 INTEGER（Unix 毫秒）。数量为 INTEGER（最小单位整数，允许负库存只有 `adjust` 场景除外，见 §5）。

```sql
users(id, username UNIQUE, display_name, password_hash, role_id, status, created_at, updated_at)
roles(id, code UNIQUE, name, description, is_system, created_at)
permissions(code PRIMARY KEY, name, group_name)          -- 权限字典，代码注册
role_permissions(role_id, permission_code, PRIMARY KEY(role_id, permission_code))
sessions(id, user_id, token_hash, expires_at, created_at, revoked_at)   -- 可选，JWT 为主

items(
  id, sku UNIQUE, name, spec, unit, category, barcode UNIQUE NULL,
  location, safety_stock INTEGER DEFAULT 0, remark,
  status, created_at, updated_at
)

movements(                     -- 进出明细（唯一流水真源）
  id, seq INTEGER,             -- seq: 单调递增业务序号
  item_id, type,               -- in | out | adjust | stocktake
  quantity INTEGER,            -- 恒为正数
  signed_quantity INTEGER,     -- in:+qty  out:-qty  adjust/stocktake:±delta
  before_qty, after_qty,       -- 记账前后结存，便于审计
  unit_cost INTEGER NULL,      -- 分；可选成本
  ref_no,                      -- 关联单号/盘点单号
  partner,                     -- 供应商/领用人
  reason, remark,
  operator_id, operator_name,  -- 冗余留痕，用户改名不影响历史
  occurred_at INTEGER,
  created_at INTEGER
)
INDEX movements(item_id, occurred_at), movements(type, occurred_at), movements(seq)

stocktakes(id, code UNIQUE, status,      -- draft | counting | posted | cancelled
           location, remark, created_by, created_at, posted_at)
stocktake_lines(id, stocktake_id, item_id, book_qty, counted_qty, diff_qty, remark)

audit_logs(id, actor_id, actor_name, action, entity, entity_id, detail_json, ip, created_at)
```

### 权限码字典（冻结）

```
item:read   item:write
stock:read  stock:write
movement:read  movement:write  movement:export
stocktake:read  stocktake:write  stocktake:post
user:read   user:write
role:read   role:write
audit:read
```

### 内置角色（seed）

| code | 名称 | 权限 |
|---|---|---|
| `admin` | 系统管理员 | `*`（全部） |
| `keeper` | 仓管员 | item:read/write, stock:read/write, movement:read/write, stocktake:read/write |
| `auditor` | 审计查看 | item:read, stock:read, movement:read/export, stocktake:read, audit:read |
| `viewer` | 只读 | item:read, stock:read |

## 4. HTTP 契约（冻结）

统一响应：成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message, details? } }`。
状态码：400 校验失败 / 401 未登录 / 403 无权限 / 404 不存在 / 409 冲突（SKU 重复等）/ 500。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | — | body `{username,password}` → 设置 Cookie `wms_session` |
| POST | `/api/auth/logout` | 登录 | 撤销会话 |
| GET | `/api/auth/me` | 登录 | `{id,username,displayName,role,permissions[]}` |
| POST | `/api/me/password` | 登录 | `{oldPassword,newPassword}` |
| GET | `/api/items?q=&page=&pageSize=&category=&status=` | item:read | 分页列表 `{rows,total,page,pageSize}` |
| POST | `/api/items` | item:write | 建物料 |
| GET/PATCH/DELETE | `/api/items/[id]` | item:read / item:write | 详情/改/停用（软删） |
| GET | `/api/stock?q=&lowOnly=&page=` | stock:read | 结存列表（含 item 信息与 onHand） |
| GET | `/api/movements?itemId=&type=&from=&to=&page=&pageSize=` | movement:read | 流水 |
| POST | `/api/movements` | movement:write | `{itemId,type,quantity,refNo?,partner?,reason?,remark?,occurredAt?,unitCost?}` |
| GET | `/api/movements/[id]` | movement:read | 单条 |
| GET | `/api/export/movements?...` | movement:export | CSV（UTF-8 BOM） |
| GET/POST | `/api/stocktakes` | stocktake:read / stocktake:write | 列表/创建（可带 lines） |
| GET/PATCH/POST | `/api/stocktakes/[id]` | stocktake:read/write | 详情/录入实盘/`{action:"post"}` 过账 |
| GET/POST | `/api/users` | user:read / user:write | 用户管理 |
| GET/PATCH/DELETE | `/api/users/[id]` | user:read / user:write | |
| GET/POST | `/api/roles` | role:read / role:write | 角色与权限勾选 |
| GET/PATCH/DELETE | `/api/roles/[id]` | role:read / role:write | 系统角色禁删 |
| GET | `/api/scan/resolve?code=` | item:read | `{kind:"item",item,onHand}` 或 `{kind:"unknown",code}` |
| GET | `/api/health` | — | `{ok:true,data:{status,version,time}}` |

`movement:write` 语义：
- `in` / `out`：`quantity > 0`；`out` 若结存不足，返回 409 `INSUFFICIENT_STOCK`（除非调用方带 `allowNegative:true` 且有 `stock:write`）。
- `adjust`：body 用 `targetQty`，系统算 delta 并记 `adjust`。
- 所有写入必须与结存更新在**同一事务**内，并写 `audit_logs`。

## 5. 认证与权限

- 登录成功签发 JWT（HS256，`JWT_SECRET`，7 天），存 HttpOnly + SameSite=Lax Cookie `wms_session`；同响应写 `sessions` 表记录 `token_hash`（sha256）便于撤销。
- `getSession()`：读 Cookie → 验签 → 查库确认未撤销未过期 → 返回 `{userId, role, permissions[]}`。
- `requirePermission(code)`：无会话 401，无权限 403。
- 首个管理员：`scripts/seed.mjs` 创建 `admin` / 随机强密码并打印一次；也支持 `ADMIN_PASSWORD` 环境变量指定。
- 所有写操作写 `audit_logs`。

## 6. 扫码约定

- 页面 `/scan` 使用 html5-qrcode，优先 `facingMode: environment`。
- 扫到字符串后调 `/api/scan/resolve?code=`：先按 `barcode` 精确匹配，再按 `sku` 匹配。
- 命中后展示物料卡（名称/SKU/规格/库位/结存）+ 快捷「入库/出库」表单，提交走 `/api/movements`。
- 未命中提示「未登记条码」并提供「新建物料」入口（预填 barcode）。
- **浏览器扫码必须 HTTPS 或 localhost**；局域网 http://192.168.x.x 会被浏览器拒绝摄像头。部署方案必须包含 HTTPS。

## 7. 验收标准（Lead 会逐条跑）

1. `pnpm typecheck` 零错误。
2. `pnpm build` 成功。
3. `pnpm db:init && pnpm seed` 生成 `data/wms.db` 与管理员账号。
4. `pnpm test` 全部通过（含库存事务与权限测试）。
5. 端到端：登录取 Cookie → 建物料 → 入库 10 → 出库 3 → 结存 7 → 流水 3 条（含建料）→ 无权限用户调 `user:write` 得 403 → 出库超量得 409 → 盘点过账后结存一致。
6. `/api/health` 200；`/scan` 页面在 HTTPS 或 localhost 可开摄像头。

## 8. 团队协作规则

- 每人只写自己的作用域；跨域改动先发消息。
- 完成前自测：`pnpm typecheck` + 自己模块的相关命令。
- 交接给 Lead 时，用一句话给出：改了什么、怎么验证、有无阻塞。

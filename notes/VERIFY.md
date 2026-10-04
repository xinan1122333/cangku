# WMS 端到端验收报告（verify-dev）

> 所有者：verify-dev（task-3）｜验收基准：`notes/ARCHITECTURE.md` §4 HTTP 契约、§7 验收标准
> 结论：**功能全部通过**。53 条用例全部 PASS（API 51 条在进程内宿主上跑，页面 2 条在真实 Next 服务上跑）。
> 发现的 5 个真实缺陷已由 owner 修复并复测通过；1 类环境限制已在「已知限制」中说明并给出替代验证途径。

---

## 0. 验收结论速览

| 项 | 结果 |
|---|---|
| 契约 §4 全部路由 + §7 验收标准 | **53 / 53 PASS** |
| `pnpm typecheck`（§7.1） | ✅ exit 0（零错误） |
| `pnpm test`（§7.4） | ✅ **50 tests / 50 pass / 0 fail**（连跑 10 次 10/10 全绿） |
| `pnpm db:init && pnpm seed`（§7.3） | ✅ 11 张表；15 权限；4 角色（admin 1 / keeper 8 / auditor 6 / viewer 2） |
| `pnpm build`（§7.2） | ⚠️ **沙箱内不可完成**（Next fork worker → `EPERM`）；编译阶段本身成功。详见 §4.2 |
| 页面可达性（§7.6） | ✅ 8/8（`/` `/login` `/scan` `/items` `/movements` `/stocktakes` `/users` `/roles` 全 200） |
| 发现缺陷 | **5 个**（BUG-1/2/5 测试侧、BUG-3 严重数据丢失 + 2 处同类、BUG-4 `/scan` 500），全部修复并复测 PASS |

**用例编号规则**：`H`=健康检查 `A`=认证会话 `I`=物料 `M`=库存流水 `X`=对抗/校验 `R`=RBAC 越权 `E`=导出 `S`=盘点 `C`=扫码 `P`=页面。

---

## 1. 运行环境与复现命令

```
工作目录  C:\Users\mrmal\Documents\deepseek-harness\default-workspace\wms
OS        Windows (pwsh)
node      v24.21.0  ← PATH 里没有，必须显式加入
pnpm      C:\Users\mrmal\Documents\deepseek-harness\default-workspace\.tools\pnpm.cmd
```

所有命令前都必须先加 node 到 PATH，否则 pnpm 报 `'node' is not recognized`：

```powershell
$nodeDir="C:\Users\mrmal\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin"
$env:PATH="$nodeDir;$env:PATH"
$pnpm="C:\Users\mrmal\Documents\deepseek-harness\default-workspace\.tools\pnpm.cmd"
```

### 静态检查与单测（§7.1 / §7.4 / §7.3）

```powershell
& $pnpm typecheck          # → exit 0
& $pnpm test               # → tests 50 | pass 50 | fail 0 | exit 0（连跑 10 次全绿）

$env:DATABASE_PATH="./data/verify3.db"      # 独立验收库，不污染 data/wms.db
& $pnpm db:init            # → 表（11）：audit_logs items movements permissions role_permissions roles seq_counters sessions stocktake_lines stocktakes users
$env:ADMIN_PASSWORD="Verify-E2E-Pass-2026!"
& $pnpm seed               # → 权限字典 15 项；admin(1) keeper(8) auditor(6) viewer(2)；admin 已创建
```

### 起服务（两条通道，缺一不可）

**通道 A — 进程内 API 宿主（覆盖所有 API 路由，含动态段 `[id]`）**

```powershell
$env:DATABASE_PATH="./data/verify3.db"
$env:JWT_SECRET="verify-e2e-secret-0123456789abcdefghijklmnop"
$env:PORT="3108"
& "$nodeDir\node.exe" --import ./scripts/alias-register.mjs tests/_api-host.mjs
```

**通道 B — 真实 Next 服务（覆盖页面路由 `/scan` `/login` 等）**

```powershell
$env:DATABASE_PATH="./data/verify.db"
$env:ADMIN_PASSWORD="Verify-E2E-Pass-2026!"
& "$nodeDir\node.exe" scripts/db-init.mjs
& "$nodeDir\node.exe" scripts/seed.mjs
$env:PORT="3105"
& "$nodeDir\node.exe" scripts/serve.mjs --dev
```

### 跑 e2e

```powershell
# 通道 A（51 条 API 用例）
$env:BASE="http://127.0.0.1:3108"; $env:ADMIN_USER="admin"; $env:ADMIN_PASSWORD="Verify-E2E-Pass-2026!"
& "$nodeDir\node.exe" scripts/verify-e2e.mjs        # → 总计 53 通过 51 失败 2（2 条=页面路由，本通道不渲染）

# 通道 B（页面用例）
$env:BASE="http://127.0.0.1:3105"
& "$nodeDir\node.exe" scripts\verify-e2e.mjs        # → P-01 / P-02 / P-03 全 PASS
```

> ⚠️ **owner 修改 `src/**` 之后必须重启宿主/服务。** 验收中我曾因宿主进程早于 core-dev 的
> schema 修复启动，导致 R-01b / S-03 出现**假失败**；重启后即 PASS。
> 判断真伪的方法：用 `tests/_probe-schemas.mjs` 直接验 schema（不经服务器），确认源码真实行为。

结构化证据（每条用例的请求/状态码/响应体）：
本次运行的副本已归档到 **`notes/evidence/verify-e2e-evidence.json`**（原始日志在同目录 `_verify-*.log`）。
脚本每次运行会用 `$env:EVIDENCE="<任意路径>.json"` 输出新的证据文件。

---

## 2. 逐条用例结果与原始证据

以下所有证据均为**真实运行**输出（非纸面推断）。

### H — 健康检查

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| H-01 | `GET /api/health` 200 且 data 含 status/version/time | **PASS** | `200 {"ok":true,"data":{"status":"ok","version":"0.1.0","time":1791104672970}}` |
| P-03 | 未登录也 200（探活免鉴权） | **PASS** | 同上，无 cookie |

### A — 认证与会话（§5）

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| A-01 | 错密码 → 401 且不下发 cookie | **PASS** | `401 {"ok":false,"error":{"code":"UNAUTHORIZED",...}}`；cookie jar 无 `wms_session` |
| A-02 | 对密码 → 200 + `Set-Cookie wms_session` 且 HttpOnly | **PASS** | `Set-Cookie: wms_session=...; Path=/; HttpOnly; SameSite=Lax` |
| A-03 | `GET /api/auth/me` → id/username/displayName/role/permissions | **PASS** | `200 {"id":...,"username":"admin","displayName":"系统管理员","role":...,"permissions":["*"]}` |
| A-04 | 未登录 `GET /api/auth/me` → 401 | **PASS** | `401` |
| A-05 | 登出后 `me` → 401（会话已撤销） | **PASS** | logout 200 → 再 me `401` |

### I — 物料（§4 items）

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| I-01 | `POST /api/items` → 2xx 且返回 id/sku | **PASS** | `201 {"id":"ce87629c-...","sku":"E2E-A-NBE1UY9H",...}` |
| I-02 | 重复 SKU → **409** | **PASS** | `409 {"ok":false,"error":{"code":"DUPLICATE_SKU",...}}` |
| I-03 | 缺必填字段 → 400 | **PASS** | `400`（缺 sku） |
| I-04 | 分页返回 `{rows,total,page,pageSize}` | **PASS** | 命中 1 行，`sku` 精确匹配 |
| I-05 | **pageSize=100000000 被夹紧** | **PASS** | `200`，`pageSize` 被夹到 ≤1000，`rows.length ≤ pageSize`（未打爆内存） |
| I-06 | 负数分页不 500 | **PASS** | `200`（被规整为合法值） |
| I-07 | **SQL 注入式搜索串不 500** | **PASS** | `q=x' OR 1=1; DROP TABLE items;--` → `200 {"rows":[],"total":0}`；随后再查 SKU 仍命中 → items 表未被破坏 |
| I-08 | `PATCH /api/items/[id]` 改属性 → 200 | **PASS** | `name` 与 `safetyStock` 均正确更新 |
| I-09 | `GET /api/items/[不存在]` → **404** | **PASS** | `404`（不再 500） |
| **I-10** | ★ **部分更新不清空 barcode/spec/location/remark** | **PASS** | before/after 完全一致：`barcode 69011050690392→69011050690392`、`spec 10x20→10x20`、`location A-01-01→A-01-01`；`safetyStock 2→11` 正确更新。**此用例为复测 BUG-3 新增** |
| **I-11** | ★ **PATCH 后条码仍可被 scan/resolve 命中** | **PASS** | `200 {"kind":"item","item":{"sku":"E2E-A-NBE1UY9H","barcode":"69011050690392"}}` |
| **I-12** | ★ PATCH `safetyStock:0` 真的写入 0（不被 `??` 吞掉） | **PASS** | `200`，返回且复读 `safetyStock=0` |
| **I-13** | ★ PATCH 显式 `barcode:null` 才清空（清空语义未被修坏） | **PASS** | `barcode=null`；随后复原为原条码成功 |

### M — 库存主链路（§7.5）

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| M-01 | 入库 10 → 200，afterQty=10 | **PASS** | `200`，`afterQty=10` |
| M-02 | 出库 3 → 200，afterQty=7 | **PASS** | `200`，`afterQty=7` |
| M-03 | `GET /api/stock` 结存 = **7** | **PASS** | `200`，该 SKU `onHand=7` |
| M-04 | 流水 in/out 各 1 条，**seq 单调递增**、无重复，signed 合计 = 7 | **PASS** | `types=out,in`；`seq` 唯一且单调；`signedQuantity` 合计 `-3+10 = 7`，与结存一致 |
| M-05 | `GET /api/movements/[id]` 单条 → 200 | **PASS** | 返回 id 与列表一致 |

### X — 对抗与入参校验

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| X-01 | **超量出库 → 409 + `error.code="INSUFFICIENT_STOCK"`，且结存不变** | **PASS** | `409 {"ok":false,"error":{"code":"INSUFFICIENT_STOCK","message":"库存不足，当前结存 7","details":{"onHand":7}}}`；随后复测结存仍为 **7**（事务回滚正确） |
| X-02 | 未登录 `POST /api/movements` → **401** | **PASS** | `401` |
| X-03 | 未登录 `GET /api/movements` → **401** | **PASS** | `401` |
| X-04 | `quantity<=0` → 400 | **PASS** | `400` |
| X-05 | 非法 `type` → 400 | **PASS** | `400`（`type:"teleport"`） |
| X-06 | `itemId` 不存在 → 404 | **PASS** | `404` |

### R — RBAC 越权（§3 权限字典 / §5）

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| R-01 | admin 建 viewer 用户 → 2xx | **PASS** | `201`，返回 user id |
| **R-01b** | ★ PATCH `/api/roles/[id]` 只改 name **不清空 description**（同类缺陷） | **PASS** | `description` 保持 `"原始描述-DO-NOT-CLEAR"`，复读一致 |
| R-02 | viewer 登录 → 200 | **PASS** | `200` + cookie |
| R-03 | viewer `GET /api/items` → 200（有 item:read） | **PASS** | `200` |
| **R-04** | ★ **viewer `POST /api/items` → 403** | **PASS** | `403 {"ok":false,"error":{"code":"FORBIDDEN","message":"缺少权限：item:write"}}` |
| **R-05** | ★ viewer `POST /api/movements` → 403 | **PASS** | `403 缺少权限：movement:write` |
| **R-06** | ★ viewer `GET /api/users` → 403 | **PASS** | `403 缺少权限：user:read` |
| **R-07** | ★ viewer `GET /api/export/movements` → 403 | **PASS** | `403 缺少权限：movement:export` |

### E — 导出（§4）

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| E-01 | CSV 且带 **UTF-8 BOM** | **PASS** | `content-type: text/csv; charset=utf-8`；`firstBytes = 239,187,191`（= `EF BB BF`）；表头 `序号,发生时间,物料SKU,...` |

> 注：BOM 必须用**原始字节**判断。`response.text()` 会把 BOM 解码掉，用 `charCodeAt(0)` 判会假失败（Lead 也踩过此坑）。本脚本用 `arrayBuffer()` 取前 3 字节。

### S — 盘点（§4 stocktakes / §7.5）

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| S-01 | 创建盘点单 → 2xx | **PASS** | `201`，返回 id |
| S-02 | `GET /api/stocktakes/[id]` 含 lines | **PASS** | `lines.length ≥ 1` |
| S-03 | `PATCH` 录入实盘 9 → 200，且**不清空 location/remark**（同类缺陷） | **PASS** | `location A-01-01→A-01-01`、`remark E2E 盘点→E2E 盘点` |
| S-04 | `POST {action:"post"}` 过账 → 200 | **PASS** | `200` |
| S-05 | ★ 过账后结存 = 实盘数 **9** | **PASS** | `onHand=9`（原为 7） |
| S-06 | ★ 生成 `stocktake` 流水，signed=+2，before/after=7/9 | **PASS** | `signedQuantity=2`，`beforeQty=7`，`afterQty=9` |
| S-07 | ★ 恰好 1 条 stocktake 流水，signed 合计 = 9 | **PASS** | `types` 含且仅含 1 条 `stocktake`；合计 = 9 = 结存 |
| S-08 | 重复过账被拒 | **PASS** | `409`（已 posted 不可再 post） |

### C — 扫码解析（§6）

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| C-01 | 按 barcode 命中 → `kind:"item"`，onHand=9 | **PASS** | `{"kind":"item","item":{...,"barcode":"69011050690392",...},"onHand":9}` |
| C-02 | 未登记条码 → `kind:"unknown"` | **PASS** | `{"kind":"unknown","code":"UNKNOWN-..."}` |
| C-03 | 按 SKU 兜底命中 | **PASS** | `kind:"item"`，`item.sku` 精确匹配 |

### P — 页面

| ID | 用例 | 结果 | 原始证据 |
|---|---|---|---|
| P-01 | `GET /scan` 带 cookie → 200 HTML | **PASS**（通道 B） | `200`，`content-type: text/html`；**此前为 500，见 BUG-4** |
| P-02 | `GET /login` → 200 HTML | **PASS**（通道 B） | `200`，`text/html` |

---

## 3. 发现的缺陷与复测记录

> 遵守「发现 bug 不改别人代码」：以下全部通过 `send_message` 报给对应 owner，由 owner 修复，verify-dev 只负责复测。

### BUG-1（core-dev，测试侧）`tests/stock.test.mjs` 搜索词写死
- **现象**：`AssertionError: 0 !== 1` at `tests/stock.test.mjs:126`
- **根因**：`S(7)` 产出 `${P}-7` 形式，但 `listStock({q:'SKU-007'})` 写死字面量，永远搜不到。
- **状态**：✅ 已修复（改为先取 `const sku = S(7)` 再用于建料与查询），`pnpm test` 复测 **49/49 PASS**。

### BUG-2（core-dev，测试侧）`tests/users.test.mjs` 跨文件隔离
- **现象**：`AssertionError: false !== true` at `tests/users.test.mjs:73`
- **探查**：独立探针证明 `lib/auth.ts` 的 `authenticate` / `sessionFromToken` / `revokeUserSessions` 行为**完全正确**（revoked=1，会话转 null）→ 非产品缺陷。
- **根因**：`--test-isolation=none` 下用 `import('...?x')` cache-bust 只换了 `auth.ts` 一个模块，其内部依赖的 `db.ts` 仍是另一个单例，测试连接与业务连接不是同一个库。
- **状态**：✅ 已修复（去掉 cache-bust，改用 `uniq()` 唯一前缀 + 相对断言），`pnpm test` 复测 **49/49 PASS**。

### BUG-3（core-dev，**严重产品缺陷**）部分更新清空未提交字段
- **现象**：`PATCH /api/items/[id]` 只改 `name`，却把 `barcode`/`spec`/`category`/`location`/`remark` **全部写成 NULL**，`unit` 被重置为「件」。
- **业务影响**：改个名字就丢条码 → `/api/scan/resolve` 再也扫不到该物料，**扫码作业直接失效**。
- **根因链（已定位到行）**：
  1. `src/lib/validate.ts:4-9` — `optionalText` 带 `.transform((v) => v === undefined || v === '' ? null : v)`，**键缺失时也会执行 transform**，把 `undefined` 物化成 `null`。
  2. `src/lib/validate.ts:66` — `itemPatchSchema = itemCreateSchema.partial()`，`.partial()` 挡不住 transform，缺失键仍输出 `null`。
  3. `src/lib/store.ts:269` — `patch.barcode === undefined ? current.barcode : patch.barcode`，合并逻辑正确，但收到的是 `null`，遂判定「要求清空」。
- **最小复现**：`parsed.data = {"name":"新名字","spec":null,"unit":"件","category":null,"barcode":null,"location":null,"safetyStock":5,"remark":null}`；`patch.barcode === null → true`（期望 `undefined`）。
- **修复**：core-dev 采纳建议 (b)，新增专用 `optionalTextForPatch`（`v === undefined ? undefined : v === '' ? null : v`）与 `optionalIntForPatch`，`itemPatchSchema` 改为显式字段定义；并把 `store.ts` 合并逻辑里的 `??` 全部改成 `=== undefined` 三元（修掉「显式传 0 被当成未提供」的隐患）。
- **同类缺陷（core-dev 自查后一并修复）**：`optionalText` 还被 `rolePatchSchema`、`stocktakePatchSchema` 复用，存在同样的静默清空：
  - `PATCH /api/roles/[id] {name}` → 清空角色 `description`
  - `PATCH /api/stocktakes/[id] {lines}` → 清空盘点单 `location`/`remark`
- **状态**：✅ 已修复并**加用例复测**（全部 PASS）：
  - `I-10` 部分更新后各字段逐一比对保持原值
  - `I-11` PATCH 后条码仍可被 `/api/scan/resolve` 命中（**业务后果锁死**）
  - `I-12` 显式 `safetyStock:0` 真的写入 0
  - `I-13` 显式 `barcode:null` 仍能清空（确认未过度修正）
  - `R-01b` 角色 PATCH 不清空 description
  - `S-03` 盘点单 PATCH 不清空 location/remark
- **复现命令**（不经服务器，直接验 schema，最可靠）：
  ```powershell
  & "$nodeDir\node.exe" --import ./scripts/alias-register.mjs tests/_probe-schemas.mjs
  # 修复后期望：itemPatchSchema keys = {"name":"n"}；barcode/description/location/remark 均为 undefined
  ```
- **教训（已写入 §1 警告）**：复测前必须重启宿主。我第一次复测 R-01b/S-03 时宿主仍加载着修复前的模块，出现**假失败**；用 `_probe-schemas.mjs` 直查源码确认修复已到位后重启，即 PASS。

### BUG-4（ui-dev）`/scan` 页面 500
- **现象**：`GET /scan` → 500，服务端 `⨯ Error: useSession 必须在 SessionProvider 内使用` at `src/app/_components/session.tsx:73` ← `src/app/scan/page.tsx:57`
- **根因**：`src/app/scan/` 位于 `(app)` 路由组**之外**，拿不到 `(app)/layout.tsx` 里的 `SessionProvider` 上下文。
- **修复**：ui-dev 新增 `src/app/scan/layout.tsx` 包裹 `<SessionProvider>`（保留全屏扫码界面，不套 `(app)` 侧边栏）；并做过**对照实验**（临时移除 layout → 复现 500；恢复 → 200），确认根因。
- **状态**：✅ 已修复，通道 B 复测 `P-01` → `200 text/html` **PASS**。

### BUG-5（core-dev）`tests/seed.test.mjs` 概率性断言过强 —— 验收侧发现
- **现象**：`pnpm test` 约 **12%** 概率随机失败于 `tests/seed.test.mjs:98` 的 `assert.match(a, /[0-9]/)`。
  最初被误判为「环境残留/时序偶发」；连跑 5 次复现 1 次红后确认是**真实缺陷**。
- **根因**：`scripts/seed.mjs:61-67` 的 `randomPassword()` 每个字符**独立**从 **65** 字符字母表等概率抽取，
  其中只有 **8** 个是数字 ∴ 16 位全无数字的概率 = `(57/65)^16 = **12.23%**`（≈ 1/8 次）。
- **定量实测**（验收侧，200,000 次采样）：
  ```
  alphabet 长度=65 | 数字 8 大写 24 小写 25 符号 8
  理论 P(16位无数字) = 12.23%    实测 无数字 = 23,563 次 → 11.78%   （理论与实测吻合）
  ```
  旁证：`P(无大写)=0.063%`、`P(无小写)=0.042%`，故**只有数字**那条会明显抖动（原用例恰好只断言了数字）。
- **裁定（Lead）**：**改测试不改产品** —— 生成器输出已有约 **95 bit** 熵，「必含数字」属**密码策略**而非产品缺陷，
  不应由偶发测试倒逼产品语义变更。
- **修复**：`tests/seed.test.mjs` 改为 **300 次采样**断言（长度恒定 / 字符集合法 / 大小写数字**至少各出现一次**），
  正则**由 `seed.PW_ALPHABET` 动态构造**以避免与实现脱节；并新增第二个用例把「无数字是合法输出」固化为**预期行为**
  （5,000 次采样、数字比例须落在 80%~95%，理论 87.77%），从根上防止该错误假设被重新引入。
- **产品代码未变**：core-dev 曾短暂按「强制含数字」改过 `randomPassword()`，收到裁定后**已完全回滚**，
  以当前版本为准（仍为 `randomBytes(length)` + `alphabet[b % alphabet.length]`）。
- **验证（复测）**：
  - 修复前：验收侧连跑 5 次 → **1 次红**（`✖ seed: 随机密码足够强`，`did not match /[0-9]/`）
  - 修复后：验收侧**连跑 10 次 → 10/10 全绿（50 pass / 0 fail / exit 0）**；Lead 独立连跑 5 次亦全绿；`pnpm typecheck` exit 0
  - 测试数 49 → **50**（新增统计用例）
- **复现命令**：
  ```powershell
  1..10 | ForEach-Object { & $pnpm test 2>&1 | Select-String 'ℹ (pass|fail)' }
  ```

---

## 4. 环境受限项与替代验证（重要）

### 4.1 动态段路由在 `next dev` 下 500 —— 环境限制，非代码缺陷

现象：所有含 `[id]` 的 API 路由（`/api/items/[id]`、`/api/movements/[id]`、`/api/stocktakes/[id]`、`/api/users/[id]`、`/api/roles/[id]`）在 `next dev` 下返回 500，服务端日志：

```
⨯ Error: spawn EPERM
    at ignore-listed frames { errno: -4048, code: 'EPERM', syscall: 'spawn',
      page: '/api/items/00000000-0000-4000-8000-000000000000' }
```

**判断依据（三重）**：① 报错是 `syscall: 'spawn'` 而非业务异常；② 静态段路由全部正常；③ 换用**不 spawn 的进程内宿主**后同类用例全部 PASS。
**替代验证**：`tests/_api-host.mjs` 用 `node:http` 直接调用真实的 `route.ts` 导出函数（注入 `workUnitAsyncStorage` 使 `next/headers cookies()` 可用），规避 fork。Lead 亦用该宿主独立复验通过。

### 4.2 `pnpm build` / `dev` / `start` 在沙箱内不可用

```
$ pnpm build
✓ Compiled successfully in 1844ms
  Running TypeScript ...
spawn EPERM          ← 失败点

$ pnpm dev
Error: spawn EPERM at fork (next-dev.js:303)
```

Next CLI 与 build 的类型检查/静态生成阶段必须 `fork()` worker，被沙箱禁止。**编译阶段本身成功（`✓ Compiled successfully`，0 module-not-found）**，失败点全部在 fork。
**替代**：`node scripts/serve.mjs --dev`（Next 编程式 API，不 fork）。
**结论**：验收以**运行中的服务**为准；§7.2 标注为「沙箱内不可验证，原因：Next worker fork 被沙箱禁止」。

### 4.3 `node_modules` 实体化包不可被 `pnpm install` 覆盖

ui-dev 已将 8 个顶层包从 Windows junction 物化为实体目录（Turbopack 不跟随 junction）。
**⚠️ 任何 `pnpm install` 都会把它们变回 junction 并导致构建失败 —— 验收期间严禁执行。**

---

## 5. 双通道设计说明（为什么需要两条通道）

| 通道 | 命令 | 覆盖 | 不能覆盖 |
|---|---|---|---|
| A 进程内宿主 `tests/_api-host.mjs` | `node --import ./scripts/alias-register.mjs tests/_api-host.mjs` | **全部 18 条 API 路由**，含 dev 下 500 的动态段 `[id]` | 页面路由（不渲染 RSC） |
| B 真实 Next 服务 `scripts/serve.mjs --dev` | `node scripts/serve.mjs --dev` | 页面路由（`/scan`、`/login`、`/`、`/items`…）+ 静态段 API | 动态段 `[id]`（dev 下 `spawn EPERM`） |

两通道**互补**：A 补 B 的动态段缺口，B 补 A 的页面缺口。合计覆盖 §4 全部路由与 §7 全部验收点。

---

## 6. 未覆盖 / 超出本次范围

- **浏览器真实摄像头扫码**（§7.6 后半）：html5-qrcode 走 `getUserMedia`，需 HTTPS 或 localhost；本环境无法启动真实浏览器会话。已覆盖其**服务端**依赖 `/api/scan/resolve` 三态（C-01/02/03）及 `/scan` 页面可达性（P-01）。
- **移动端真机布局/触控**：属 ui-dev 自测范围。
- **`pnpm build` 产物在 `next start` 下的运行验证**：受 §4.2 限制不可执行。

---

## 7. 交付物清单

| 文件 | 说明 |
|---|---|
| `notes/VERIFY.md` | 本报告 |
| `scripts/verify-e2e.mjs` | 53 条用例的 e2e 脚本（fetch + 手写 cookie jar，零依赖） |
| `tests/_api-host.mjs` | 进程内 API 宿主（规避 `spawn EPERM` 的关键工具，覆盖全部 18 条路由含 `[id]`） |
| `tests/_probe-schemas.mjs` | 不经服务器直接验 zod schema 的探针（用于排除陈旧进程造成的假失败） |
| `data/verify-e2e-evidence.json` → **`notes/evidence/verify-e2e-evidence.json`** | 结构化证据（每条用例的请求/状态码/响应体） |
| `data/_verify-*.log` → **`notes/evidence/_verify-*.log`** | 原始运行日志与输出留存 |

> **归档说明（Lead，交付前整理）**：上述证据文件原在 `data/` 下，交付时已移入 `notes/evidence/`，
> 以免与运行时数据混淆（`data/` 现在只保留正式库 `wms.db`）。文档内其余引用路径已同步更新。

### 已删除的临时文件
`tests/_probe-dynerr.mjs`、`tests/_probe-regex.mjs`、`tests/_probe-barcode.mjs`、`tests/_probe-c01.mjs`、`tests/_serve-inproc.mjs`（被 `scripts/serve.mjs` 取代）。
`tests/_probe-patchzod.mjs` 由 core-dev 保留，可用于复跑 BUG-3 的最小 schema 复现。

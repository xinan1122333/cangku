# WMS 仓库管理系统

零部件进出明细 + 手机扫码 + 角色权限的中小型仓库管理系统。单机自托管，数据存本地 SQLite。

---

## 功能

| 模块 | 能力 |
|---|---|
| **物料档案** | SKU/名称/规格/单位/分类/**条码**/库位/安全库存；搜索、筛选、分页；软删停用；建料可带期初库存 |
| **出入库明细** | 入库 `in` / 出库 `out` / 调整 `adjust`；单号、往来单位、原因、备注、成本、发生时间；**每笔都记录记账前后结存**，可完整追溯 |
| **手机扫码** | `/scan` 调用后置摄像头扫条码/二维码 → 自动识别物料 → 显示结存 → 一键入库/出库；未登记条码可直接建档 |
| **盘点** | 建盘点单 → 录实盘数 → 实时差异 → 过账自动生成调整流水（**过账后不可重复过账**） |
| **账号与权限** | 用户管理、角色管理、15 个细粒度权限码、按组勾选；4 个内置角色 |
| **报表** | 流水 CSV 导出（UTF-8 BOM，Excel 直接打开不乱码） |
| **审计** | 所有写操作留痕（`audit_logs`：操作人、动作、实体、详情、IP） |

### 内置角色

| 角色 | 权限 |
|---|---|
| `admin` 系统管理员 | 全部（`*`） |
| `keeper` 仓管员 | 物料读写、结存读写、出入库读写、盘点读写 |
| `auditor` 审计查看 | 只读 + 审计日志 + 导出 |
| `viewer` 只读 | 物料查看、结存查看 |

### 15 个权限码

```
item:read  item:write
stock:read  stock:write
movement:read  movement:write  movement:export
stocktake:read  stocktake:write  stocktake:post
user:read  user:write
role:read  role:write
audit:read
```

---

## 快速开始

> ⚠️ 本项目在开发机上使用 Node 24 的**内置 `node:sqlite`**，无需任何原生编译依赖。

```powershell
# 1. 安装依赖
pnpm install

# 2. 配置
Copy-Item .env.example .env
#   编辑 .env：至少改 JWT_SECRET（生成：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"）

# 3. 建库 + 建管理员（首次会打印一次性随机密码，请立即记录）
pnpm db:init
pnpm seed

# 4. 启动
pnpm dev          # 开发：http://localhost:3100
pnpm build; pnpm start   # 生产
```

打开 <http://localhost:3100> → 用 `admin` 和 seed 打印的密码登录 → **立即到「用户管理 → 修改我的密码」改密**。

### 手机扫码的前置条件（重要）

浏览器**只允许在 HTTPS 或 localhost 下调用摄像头**。用局域网 IP（`http://192.168.x.x:3100`）访问时摄像头会被浏览器拒绝。
所以手机扫码需要先配好域名 + HTTPS —— 见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

在服务器上本地调试时可用 Chrome 的 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 临时放行，但**正式使用请务必上 HTTPS**。

---

## ⚠️ 在 DSH 沙箱环境内运行（当前开发机）

本项目的开发机跑在 DSH 文件沙箱里，该沙箱**禁止进程通过管道 spawn 子进程**。这带来两个已知限制：

| 命令 | 沙箱内表现 | 替代方案 |
|---|---|---|
| `pnpm dev` / `pnpm start` | ❌ `spawn EPERM`（Next CLI 内部 `fork()` server 子进程） | ✅ `node scripts/serve.mjs --dev`（用 Next 编程式 API，**单进程不 fork**） |
| `pnpm build` | ❌ 编译阶段能过（`✓ Compiled successfully`），但后续 TS 检查/静态生成要 fork worker → `EPERM` | ✅ 用 `node scripts/serve.mjs --dev` 直接跑，或**把项目复制到无此限制的机器/服务器上构建** |

**相关命令：**

```powershell
# 沙箱内启动（单进程，不 fork）
$env:PORT='3100'; $env:DATABASE_PATH='./data/wms.db'; node scripts/serve.mjs --dev

# 验收工具（同进程内挂载全部 API 路由，完全不 fork）
node --import ./scripts/alias-register.mjs scripts/lead-verify-all.mjs
node scripts/check-pages.mjs http://127.0.0.1:3100
```

> 另：`node_modules` 中部分包曾是 Windows **junction**，而 Turbopack/webpack 的解析器**不跟随 junction**。
> 若运行 `pnpm install` 后构建报 `Could not find the Next.js package`，说明 junction 回归了 —— 需将
> `node_modules/<包>` 由 junction 物化为实体目录（`rmdir` 后 `robocopy /E` 自 `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>`）。

**在普通服务器上部署时这些限制都不存在**，直接用 `pnpm build` + `pnpm start` 即可。


---

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发模式（端口 3100） |
| `pnpm build` / `pnpm start` | 生产构建 / 启动 |
| `pnpm typecheck` | TypeScript 全量类型检查 |
| `pnpm test` | 单元测试（39 个） |
| `pnpm db:init` | 建表（幂等，可重复跑） |
| `pnpm seed` | 注册权限与内置角色、创建管理员（幂等） |

### 重置管理员密码

```powershell
$env:ADMIN_PASSWORD='新密码'; pnpm seed
```

---

## 目录结构

```
wms/
├── src/
│   ├── lib/              # 领域层：db / schema / auth / rbac / audit / store / validate / http
│   ├── types/api.ts      # 前后端共享 DTO（类型单一真源）
│   └── app/
│       ├── api/          # 18 个 API 路由（REST）
│       ├── (app)/        # 登录后界面：仪表盘/物料/流水/盘点/用户/角色
│       ├── scan/         # 手机扫码页（独立 layout，无导航占屏）
│       └── login/        # 登录页
├── scripts/              # db-init / seed / 验收工具
├── tests/                # 单元测试 + 进程内 API 宿主
├── notes/                # ARCHITECTURE.md（契约）、VERIFY.md（验收证据）
├── docs/DEPLOY.md        # 域名 + HTTPS + 上线部署
└── data/                 # SQLite 数据文件（已在 .gitignore 中）
```

---

## 技术栈

- **Next.js 16.3.8**（App Router）+ React 19 + TypeScript
- **`node:sqlite`**（Node 24 内置，同步 API，WAL 模式）
- **jose**（JWT 会话，HttpOnly Cookie）/ **bcryptjs**（密码哈希）/ **zod**（入参校验）
- **html5-qrcode**（手机浏览器扫码）
- 手写 CSS（移动端优先，无 Tailwind）

> **为什么不使用 better-sqlite3 / Tailwind**：本机开发环境（DSH 沙箱）禁止安装脚本 spawn 子进程，原生模块无法编译。改用 Node 24 内置 `node:sqlite` 与手写 CSS 绕开。
> 部署到普通 Linux 服务器时，可自由换回 better-sqlite3 + Tailwind。

---

## 数据安全

- 密码用 **bcrypt** 哈希存储（cost 10），接口永不返回哈希。
- 会话为签名 JWT（HS256）+ 服务端 `sessions` 表，**支持撤销**；用户被停用时其所有会话立即失效。
- 所有写操作在**同一事务**内完成「流水写入 + 结存更新 + 审计留痕」，失败整体回滚。
- 出库防负库存：结存不足返回 `409 INSUFFICIENT_STOCK`。
- **备份**：只需定期复制 `data/wms.db`（建议用 `sqlite3 wms.db ".backup 备份文件"` 保证一致性）。

---

## 文档

- **[`docs/DEPLOY-FREE-ORACLE.md`](docs/DEPLOY-FREE-ORACLE.md) —— 免费上线（$0/月，推荐）**
  没有服务器也能上线：Oracle Cloud Always Free + Caddy 自动 HTTPS + 一键部署脚本。
  含域名解析、防火墙、自检、防实例回收。
- [`docs/DEPLOY.md`](docs/DEPLOY.md) —— 通用部署（自有服务器 / 云主机）：域名、DNS、HTTPS、Nginx/Caddy、systemd、备份
- [`notes/ARCHITECTURE.md`](notes/ARCHITECTURE.md) —— 数据模型、权限码、HTTP 契约（开发真源）
- [`notes/VERIFY.md`](notes/VERIFY.md) —— 验收用例与原始证据

## 部署脚本

| 脚本 | 作用 |
|---|---|
| `scripts/deploy-oracle.sh` | 一键部署到 Ubuntu 服务器（装环境 → 建库 → 构建 → systemd → Caddy HTTPS → 备份）。支持 `--dry-run` |
| `scripts/healthcheck.sh` | 部署后自检 26 项，含生产构建产物与 HTTPS 链路 |

```bash
# 服务器上
sudo bash deploy-oracle.sh --dry-run wms.你的域名        # 先看要做什么
sudo bash deploy-oracle.sh wms.你的域名                  # 正式部署
bash healthcheck.sh wms.你的域名                         # 部署后自检
```

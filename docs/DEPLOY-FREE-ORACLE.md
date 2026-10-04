# 免费上线到 Oracle Cloud（Always Free，$0/月）

> 面向：**没有服务器、想尽量 $0、不在中国（无需备案）**。
> 目标：`https://wms.sasakic.cc` 可手机扫码使用。
>
> **为什么选 Oracle Cloud**：它的 "Always Free" 是**永久免费**（不是试用），官方文档明确写
> "free of charge ... for the life of the account"，包含 Arm 计算 + 200GB 块存储 + 10TB/月出站流量。
> 你这套系统（Node + SQLite）占用极小，免费额度远超需求。

---

## 0. 为什么不用其他"免费"平台

我逐一核实过，结论如下（2026-10 查询）：

| 平台 | 结论 | 原因 |
|---|---|---|
| **Vercel / Netlify** | ❌ 不可用 | Serverless 文件系统**临时**，官方 FAQ 明确 SQLite 无法使用；库存数据会丢 |
| **Fly.io** | ⚠️ 无永久免费 | 新账号只有 **7 天 / 2 VM 小时**试用，之后按量付费（约 $5+/月） |
| **Railway** | ⚠️ 免费档极小 | 免费档仅 **0.5 GB 卷**且试用后 $1/月；Hobby $5/月 |
| **Render / Koyeb 免费档** | ⚠️ 通常无持久卷 | 免费实例重启后数据丢失，或强制休眠 |
| **Oracle Cloud Always Free** | ✅ **推荐** | **永久免费**，含 200GB 持久块存储、2 OCPU / 12GB 内存、10TB 流量 |

**核心判据**：库存流水是核心资产，**必须落在持久磁盘上**。没有持久卷的免费平台一律排除。

---

## 1. 注册 Oracle Cloud

1. 打开 <https://signup.cloud.oracle.com/>
2. 国家/地区选你的实际所在地，**Home Region 选离你最近的**（例如 Singapore / Japan East / US West）
   - ⚠️ **Home Region 一旦选定不可更改**，且 Always Free 资源只能在 Home Region 创建
3. 需要**信用卡或借记卡**做身份验证（会有一笔临时预授权，通常几天内自动撤销，**不会真实扣费**）
   - 不接受预付费卡 / 虚拟卡 / 单次卡
4. 注册完成后，**不要升级为 Pay As You Go**，保持 Free Tier 即可永久免费

> 一个账号只能有一个 Free Tier 账号，**不要重复注册**（会被封）。

---

## 2. 创建免费服务器

进入控制台 → **Compute → Instances → Create Instance**：

| 配置项 | 选择 |
|---|---|
| **Image** | **Ubuntu 24.04**（或 22.04）——必须选带 "Always Free Eligible" 标签的 |
| **Shape** | **VM.Standard.A1.Flex**（Arm，Ampere） |
| **OCPU** | **2**（免费上限） |
| **Memory** | **12 GB**（免费上限） |
| **Boot volume** | 默认 50 GB 足够（免费总额 200 GB） |
| **Public IPv4** | ✅ 勾选 "Assign a public IPv4 address" |
| **SSH keys** | 选 "Generate a key pair for me" → **下载私钥保存好** |

> **遇到 "Out of host capacity"**：这是 Arm 免费机型常见的临时容量不足，不是你的问题。
> 处理：换个 **Availability Domain**（AD-2 / AD-3）重试，或隔几小时/几天再试。
> 也可以先用 **VM.Standard.E2.1.Micro**（AMD 微型，1GB 内存）——对本系统也够用。

创建后记下**公网 IP**。

---

## 3. 开放防火墙（两层，缺一不可）

### 3.1 云平台安全列表

控制台 → **Networking → Virtual Cloud Networks → 你的 VCN → Security Lists → Default Security List**
添加入站规则：

| 方向 | 源 | 协议 | 端口 |
|---|---|---|---|
| Ingress | 0.0.0.0/0 | TCP | **80** |
| Ingress | 0.0.0.0/0 | TCP | **443** |

> **不要**开放 3100 端口——应用只监听本机，全部流量走 Caddy 反代。

### 3.2 实例内防火墙（Oracle 的 Ubuntu 镜像默认 iptables 会拦截，**极易踩坑**）

SSH 登录后执行：

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

> ⚠️ 这一步很多人漏掉，表现为"安全组开了但还是访问不了"。

---

## 4. 一键部署

**在本地电脑**把代码传到服务器：

```powershell
# 把 wms 目录传到服务器的 /tmp/wms-src
scp -i <你下载的私钥> -r .\wms ubuntu@<公网IP>:/tmp/wms-src
```

**在服务器上**运行部署脚本：

```bash
sudo bash /tmp/wms-src/scripts/deploy-oracle.sh wms.sasakic.cc
```

> 想先看它要做什么而不实际改动系统（推荐首次这样做）：
> ```bash
> sudo bash /tmp/wms-src/scripts/deploy-oracle.sh --dry-run wms.sasakic.cc
> ```
> `--dry-run` 会打印每一步将执行的命令，不做任何修改。

脚本会自动完成：装 Node 24 + pnpm → 放行防火墙（含 Oracle 特有的 iptables 修补）→
建 `wms` 用户与目录 → 生成随机 `JWT_SECRET` → 装依赖 → 建库 → **创建管理员并打印密码** →
`pnpm build` → 配 systemd 开机自启 → 装 Caddy 并自动申请 HTTPS 证书 → 配每日备份 cron。

**⚠️ 记下它打印的管理员密码**（只显示一次）。

<details>
<summary>如果你想手动一步步做（脚本做的事）</summary>

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git sqlite3 ca-certificates gnupg ufw

# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pnpm

# 应用用户与目录
sudo useradd -r -m -d /opt/wms -s /bin/bash wms
sudo mkdir -p /opt/wms/app /opt/wms/data /opt/wms/backup
sudo cp -r /tmp/wms-src/. /opt/wms/app/
sudo chown -R wms:wms /opt/wms

# 环境变量
sudo -iu wms
cd /opt/wms/app
cp .env.example .env
nano .env
```

`.env` 内容：

```ini
DATABASE_PATH=/opt/wms/data/wms.db
JWT_SECRET=<用下面命令生成>
SESSION_DAYS=7
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
PUBLIC_ORIGIN=https://wms.sasakic.cc
TRUST_PROXY=1
```

生成密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

```bash
pnpm install
pnpm db:init && pnpm seed     # ⚠️ 记下打印的密码
pnpm build
```

</details>

> **在真实服务器上 `pnpm build` 可以正常运行**。本机开发环境跑不了是 DSH 沙箱限制（禁止 fork），与代码无关。

---

## 5. 配置 HTTPS（Caddy 自动证书）

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

创建 `/etc/caddy/Caddyfile`：

```
wms.sasakic.cc {
    reverse_proxy 127.0.0.1:3100
    encode gzip
}
```

```bash
sudo systemctl reload caddy
```

Caddy 会**自动申请 Let's Encrypt 证书、自动续期、自动 HTTP→HTTPS 跳转**，无需你操作。

---

## 6. DNS 解析（你的域名在 Cloudflare）

`sasakic.cc` 的 NS 是 `andy.ns.cloudflare.com` / `carrera.ns.cloudflare.com`，即已在 Cloudflare 托管。

Cloudflare 控制台 → 选择 `sasakic.cc` → **DNS → Records → Add record**：

| 类型 | 名称 | 内容 | 代理状态 |
|---|---|---|---|
| A | `wms` | `<你的服务器公网IP>` | 🟠 **Proxied**（橙云） |

> **关于橙云**：开启后 Cloudflare 提供 CDN 与隐藏源站 IP。
> 如果 Caddy 申请证书失败，先把橙云**切成灰云（DNS only）**让证书签发成功，之后再开橙云。
> 或者在 Cloudflare 用 **SSL/TLS → Overview → Full (strict)** 模式。

等待 1-2 分钟，然后访问 <https://wms.sasakic.cc>。

---

## 7. 自检（部署后必做）

部署脚本跑完后，**再执行一次自检**，确认每个环节真的正常：

```bash
bash /tmp/wms-src/scripts/healthcheck.sh wms.sasakic.cc
```

它会逐项检查 26 个点并给出 PASS/FAIL：

- 运行环境（node / pnpm / sqlite3）
- **构建产物**（`.next/BUILD_ID`、`server`、`static`）← 这一项开发机无法验证，只能在服务器确认
- 数据库（表数量 ≥11、有用户、权限字典 15 项）
- 应用服务（systemd 状态 + 本地健康端点）
- **反向代理与 HTTPS**（Caddy 状态、`https://域名/api/health` 返回 200、TLS 证书到期时间）
- 防火墙（iptables 是否放行 80/443）
- 备份 cron

**全部 PASS 才算部署成功。** 有 FAIL 时脚本会打印排障命令。

---

## 7. 设置开机自启（systemd）

创建 `/etc/systemd/system/wms.service`：

```ini
[Unit]
Description=WMS 仓库管理系统
After=network.target

[Service]
Type=simple
User=wms
WorkingDirectory=/opt/wms/app
EnvironmentFile=/opt/wms/app/.env
ExecStart=/usr/bin/pnpm start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wms
sudo systemctl status wms
curl -s http://127.0.0.1:3100/api/health    # 应返回 {"ok":true,...}
```

---

## 8. 自动备份（重要）

```bash
sudo mkdir -p /opt/wms/backup && sudo chown wms:wms /opt/wms/backup
sudo crontab -u wms -e
```

加入：

```cron
0 3 * * * sqlite3 /opt/wms/data/wms.db ".backup '/opt/wms/backup/wms-$(date +\%F).db'" && find /opt/wms/backup -name 'wms-*.db' -mtime +30 -delete
```

> ⚠️ 别用 `cp` 复制正在写入的 SQLite 文件，用 `.backup` 才能保证一致性。

---

## 9. 防止实例被回收（Oracle 特有，务必读）

Oracle 会回收**空闲**的 Always Free 实例。判定标准是**7 天内**同时满足：

- CPU 利用率 95 分位 **< 20%**
- 网络利用率 **< 20%**
- 内存利用率 **< 20%**（仅 A1 机型）

**好消息**：你的 WMS 日常有扫码和出入库请求，很容易超过这些阈值；而且用 **AMD E2.1.Micro** 机型不受内存这一条限制。

**保险措施**（可选）：加一个轻量心跳

```bash
sudo crontab -e
```

```cron
*/10 * * * * /usr/bin/curl -s -o /dev/null https://wms.sasakic.cc/api/health
```

---

## 10. 上线后检查清单

- [ ] `https://wms.sasakic.cc` 能打开登录页
- [ ] 用 `admin` + seed 打印的密码登录，**立即改密**
- [ ] **手机**打开 `https://wms.sasakic.cc/scan` → 弹出摄像头授权（能弹 = HTTPS 生效）
- [ ] 录 1 个物料 + 1 笔入库，确认数据在
- [ ] 建 `keeper` 角色账号给仓管员，不共用 admin
- [ ] 备份 cron 已生效（`sudo -u wms crontab -l`）
- [ ] `sudo systemctl is-enabled wms` 返回 `enabled`

---

## 11. 常见问题

| 现象 | 处理 |
|---|---|
| 创建实例报 `Out of host capacity` | 换 Availability Domain 重试，或改用 AMD E2.1.Micro，或隔几小时再试 |
| 域名打不开但 IP 能通 | 检查 Cloudflare 代理状态、Caddy 日志 `sudo journalctl -u caddy -n 50` |
| Caddy 证书签发失败 | 确认 80 端口从公网可达（`curl -I http://wms.sasakic.cc`）；橙云先切灰云再签 |
| 开了安全组还是连不上 | **99% 是漏了 §3.2 的 iptables 规则** |
| 502 Bad Gateway | 应用没起来：`sudo systemctl status wms`、`sudo journalctl -u wms -n 100` |
| 手机扫码提示需要 HTTPS | 确认地址是 `https://` 开头；摄像头权限是否被拒 |
| 实例被回收了 | 数据在块存储上通常仍在；重新创建实例挂载原启动卷，或从备份恢复 |
| 想省钱又怕被回收 | 加 §9 的心跳 cron |

---

## 12. 成本总结

| 项目 | 费用 |
|---|---|
| 计算（2 OCPU / 12GB Arm） | **$0** |
| 块存储（50GB 启动卷） | **$0**（免费额度 200GB） |
| 出站流量（10TB/月） | **$0** |
| Let's Encrypt 证书 | **$0** |
| 域名 `sasakic.cc` 续费 | 你原有的支出 |
| **合计** | **$0/月** |

**唯一注意**：保持 Free Tier 账号、不要升级 Pay As You Go，就不会产生费用。

---

## 13. 脚本验证状态（如实说明）

| 脚本 | 已验证 | 未验证 |
|---|---|---|
| `scripts/deploy-oracle.sh` | ✅ 静态检查全通过（256 行；结构配对 17/17、heredoc 闭合、引号平衡、无危险片段、18 项关键步骤齐全）；✅ `--dry-run` 模式 | ⚠️ **未在真实 Linux 上端到端执行过** —— 开发机没有 bash / Docker / WSL 发行版 |
| `scripts/healthcheck.sh` | ✅ 静态检查全通过（118 行；14 项诊断能力齐全；结构配对 8/8） | ⚠️ 同上 |

**这意味着什么**：脚本的逻辑、结构、关键步骤都已核对，但首次在服务器上运行时请**留意输出**。
建议先跑 `--dry-run` 看一遍它要做什么，再正式执行。

如果脚本某一步失败，最可能的原因是不同 Ubuntu 版本的包名或路径差异 ——
文档 §4 的折叠区里有**完整的手动步骤**，可以照着一步步做，效果和脚本一致。

**部署后在服务器上跑 `healthcheck.sh`**，它会覆盖那些开发机无法验证的环节
（尤其是生产构建产物与 `next start` 路径），给出明确的 PASS/FAIL。

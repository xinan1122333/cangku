# 部署上线：域名 + HTTPS

> 本文假设你**已经有域名**，需要把它指到服务器并配上 HTTPS。
> 目标：`https://wms.你的域名.com` 可以手机扫码使用。

---

## 0. 先确认三件事

| 项目 | 说明 |
|---|---|
| **服务器** | 一台有公网 IP 的 Linux（阿里云/腾讯云/华为云轻量服务器即可，2 核 2G 起步够用） |
| **域名** | 已注册；下文用 `example.com` 举例，请替换成你的真实域名 |
| **备案** | ⚠️ **中国大陆服务器必须完成 ICP 备案**，否则 80/443 端口会被阻断。香港/海外服务器无需备案 |

推荐的子域名规划：

| 用途 | 记录 |
|---|---|
| 系统入口 | `wms.example.com` |
| （可选）裸域跳转 | `example.com` → 跳转到 `wms.example.com` |

---

## 1. DNS 解析

到你的域名服务商控制台 → 域名解析，添加 **A 记录**：

| 记录类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| A | `wms` | `你的服务器公网IP` | 600 |

验证（在本地电脑执行）：

```powershell
Resolve-DnsName wms.example.com
# 应返回你的服务器 IP
```

> 解析生效通常几分钟，最长 24 小时。

---

## 2. 服务器准备

以 Ubuntu 22.04/24.04 为例（其他发行版命令类似）：

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js 22 LTS（本系统需要 Node ≥ 22；推荐 24）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v   # 确认版本
npm i -g pnpm

# 只放行 SSH / HTTP / HTTPS
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

> **不要**把应用的 3100 端口直接暴露到公网，全部流量走 Nginx/Caddy 反代。

---

## 3. 部署应用

```bash
# 创建专用用户（安全：不用 root 跑应用）
sudo useradd -r -m -d /opt/wms -s /bin/bash wms
sudo mkdir -p /opt/wms/app && sudo chown -R wms:wms /opt/wms

# 上传代码（在你本地电脑执行；或用 git clone）
scp -r ./wms/* user@你的服务器IP:/opt/wms/app/

# 切到应用用户
sudo -iu wms
cd /opt/wms/app

# 安装依赖
pnpm install

# 生成配置
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 复制输出的密钥
nano .env
```

`.env` 生产配置示例：

```ini
DATABASE_PATH=/opt/wms/data/wms.db
JWT_SECRET=把上面生成的64位随机串粘这里
SESSION_DAYS=7
ADMIN_USERNAME=admin
ADMIN_PASSWORD=          # 留空则随机生成并打印一次
PUBLIC_ORIGIN=https://wms.example.com
TRUST_PROXY=1            # 在反代后面运行，务必设为 1
```

```bash
mkdir -p /opt/wms/data
pnpm db:init
pnpm seed                # ⚠️ 记下打印的一次性管理员密码
pnpm build
```

---

## 4. 用 systemd 常驻运行

`sudo nano /etc/systemd/system/wms.service`：

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
# 安全加固
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wms
sudo systemctl status wms
curl -s http://127.0.0.1:3100/api/health   # 应返回 {"ok":true,...}
```

---

## 5. 配置 HTTPS

### 方案 A：Caddy（推荐，自动申请并续期证书，最简单）

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`sudo nano /etc/caddy/Caddyfile`：

```
wms.example.com {
    reverse_proxy 127.0.0.1:3100
    encode gzip
}
```

```bash
sudo systemctl reload caddy
```

**完成。** Caddy 会自动向 Let's Encrypt 申请证书、自动续期、自动把 HTTP 跳转到 HTTPS。打开 `https://wms.example.com` 即可。

### 方案 B：Nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

`sudo nano /etc/nginx/sites-available/wms`：

```nginx
server {
    listen 80;
    server_name wms.example.com;

    # 扫码上传的请求体不需要很大，但留出余量
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 自动申请证书 + 自动配置 443 + 自动续期
sudo certbot --nginx -d wms.example.com
```

certbot 会自动续期（systemd timer）；手动测试续期：`sudo certbot renew --dry-run`。

---

## 6. 上线后必做

1. **登录并立即修改管理员密码**：`https://wms.example.com` → 用户管理 → 修改我的密码。
2. **手机测试扫码**：手机浏览器打开 `https://wms.example.com/scan`，应弹出摄像头授权；若提示「需要 HTTPS」，说明证书没生效。
3. **关闭不需要的账号**，给仓管员建 `keeper` 角色账号，不要共用 admin。
4. **配好备份**（见下节）。

---

## 7. 数据备份（务必做）

SQLite 一致性备份（**不要在应用写入时直接复制文件**）：

```bash
# 手动备份
sqlite3 /opt/wms/data/wms.db ".backup '/opt/wms/backup/wms-$(date +%F).db'"

# 每天凌晨 3 点自动备份，保留 30 天
sudo crontab -u wms -e
```

加入：

```cron
0 3 * * * mkdir -p /opt/wms/backup && sqlite3 /opt/wms/data/wms.db ".backup '/opt/wms/backup/wms-$(date +\%F).db'" && find /opt/wms/backup -name 'wms-*.db' -mtime +30 -delete
```

**恢复**：

```bash
sudo systemctl stop wms
cp /opt/wms/backup/wms-2026-10-04.db /opt/wms/data/wms.db
sudo chown wms:wms /opt/wms/data/wms.db
sudo systemctl start wms
```

---

## 8. 升级版本

```bash
sudo systemctl stop wms
sudo -iu wms
cd /opt/wms/app
# 上传新代码后：
pnpm install
pnpm db:init        # 幂等，安全
pnpm build
exit
sudo systemctl start wms
```

---

## 9. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 域名打不开 | 检查 DNS 解析是否生效（`Resolve-DnsName`）、安全组/防火墙是否放行 80/443、`sudo systemctl status caddy nginx` |
| 证书申请失败 | 80 端口必须能从公网访问；中国大陆服务器需先完成备案；确认域名解析已生效 |
| 手机扫码提示「需要 HTTPS」 | 确认访问的是 `https://` 开头；检查证书是否生效；`/scan` 页面的摄像头权限被拒绝时也会提示 |
| 登录后立刻掉线 | `.env` 的 `TRUST_PROXY=1` 是否设置；`JWT_SECRET` 是否在重启后变化 |
| 提示 502 | 应用没起来：`sudo systemctl status wms`、`sudo journalctl -u wms -n 100` |
| 出入库报 409 | 结存不足，属正常业务拦截，不是故障 |
| 数据文件在哪 | `.env` 的 `DATABASE_PATH`，默认 `./data/wms.db` |

---

## 10. 安全清单

- [x] `JWT_SECRET` 为 32 字节以上随机值，且**未提交到版本库**
- [x] 应用只用 `wms` 普通用户运行，非 root
- [x] 数据库文件权限 `600`，仅 `wms` 可读
- [x] 全站 HTTPS，HTTP 自动跳转
- [x] 应用端口 3100 不对公网开放，仅本机反代访问
- [x] `TRUST_PROXY=1`，Cookie 走 `Secure`
- [x] 已配置每日自动备份并验证过恢复流程
- [x] 每个使用者独立账号，按最小权限分配角色（不共用 admin）

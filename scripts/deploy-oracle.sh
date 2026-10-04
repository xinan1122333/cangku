#!/usr/bin/env bash
#
# WMS 一键部署脚本（Ubuntu 22.04 / 24.04，适用于 Oracle Cloud Always Free 等）
#
# 用法（在服务器上，把项目代码放到 /tmp/wms-src 后）：
#   sudo bash deploy-oracle.sh wms.sasakic.cc
#
# 做四件事：装 Node/pnpm → 建用户与目录 → 装依赖+建库+构建 → 配 Caddy HTTPS + systemd
#
# 验证状态（如实说明）：
#   本脚本已通过静态检查（scripts/check-deploy-script.mjs：结构配对、引号平衡、
#   heredoc 闭合、危险片段扫描、关键步骤齐全），但**未在真实 Linux 上端到端执行过**
#   —— 开发机没有 bash/Docker/WSL 发行版。首次在服务器上运行时请留意输出。
#
# 安全开关：想先看它要做什么而不实际执行，用 --dry-run
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

DOMAIN="${1:-}"
APP_USER="wms"
APP_HOME="/opt/wms"
APP_DIR="${APP_HOME}/app"
DATA_DIR="${APP_HOME}/data"
SRC_DIR="${SRC_DIR:-/tmp/wms-src}"
PORT="${PORT:-3100}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash $0 <域名>"
[[ -n "$DOMAIN" ]] || die "缺少域名参数。用法：sudo bash $0 wms.sasakic.cc"
[[ $DRY_RUN -eq 1 ]] && warn "DRY-RUN 模式：只打印将要执行的命令，不真正改动系统"

# ---------------------------------------------------------------- 1. 基础软件
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
run apt-get install -y -qq curl git sqlite3 ca-certificates gnupg ufw

log "安装 Node.js 24 与 pnpm"
if ! command -v node >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] curl -fsSL https://deb.nodesource.com/setup_24.x | bash -\n'
    printf '  [dry-run] apt-get install -y -qq nodejs\n'
  else
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y -qq nodejs
  fi
fi
command -v node >/dev/null 2>&1 && node -v
if ! command -v pnpm >/dev/null 2>&1; then
  run npm i -g pnpm
fi
command -v pnpm >/dev/null 2>&1 && pnpm -v

# ---------------------------------------------------------------- 2. 防火墙
log "放行 80 / 443"
if command -v ufw >/dev/null 2>&1; then
  run ufw allow 22/tcp
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  run ufw --force enable
fi

# Oracle 的 Ubuntu 镜像默认 iptables 会拦截 80/443，这一步最容易被漏掉
if command -v iptables >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 0 ]]; then
    iptables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
    iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
    command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || true
  else
    printf '  [dry-run] iptables -I INPUT 6 ... --dport 80/443 -j ACCEPT && netfilter-persistent save\n'
  fi
fi

# ---------------------------------------------------------------- 3. 应用目录
log "创建应用用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || run useradd -r -m -d "$APP_HOME" -s /bin/bash "$APP_USER"
run mkdir -p "$APP_DIR" "$DATA_DIR" "${APP_HOME}/backup"

[[ -d "$SRC_DIR" ]] || die "源码目录不存在：$SRC_DIR
请先在本地执行： scp -i <私钥> -r ./wms/* ubuntu@<公网IP>:/tmp/wms-src/"
[[ -f "${SRC_DIR}/package.json" ]] || die "$SRC_DIR 里没有 package.json，确认你复制的是 wms 项目根目录"

log "复制代码到 $APP_DIR"
run cp -r "${SRC_DIR}/." "$APP_DIR/"
run chown -R "${APP_USER}:${APP_USER}" "$APP_HOME"

# ---------------------------------------------------------------- 4. 环境变量
log "生成 .env"
ENV_FILE="${APP_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  cat > "$ENV_FILE" <<EOF
DATABASE_PATH=${DATA_DIR}/wms.db
JWT_SECRET=${SECRET}
SESSION_DAYS=7
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
PUBLIC_ORIGIN=https://${DOMAIN}
TRUST_PROXY=1
EOF
  chown "${APP_USER}:${APP_USER}" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  warn ".env 已存在，保留原文件（不覆盖）"
fi

# ---------------------------------------------------------------- 5. 安装构建
log "安装依赖（Arm 架构下仍是纯 JS 依赖，无需编译）"
run sudo -iu "$APP_USER" bash -lc "cd '$APP_DIR' && pnpm install"

log "初始化数据库"
run sudo -iu "$APP_USER" bash -lc "cd '$APP_DIR' && pnpm db:init"

log "创建管理员（密码只显示这一次，请立即记录）"
run sudo -iu "$APP_USER" bash -lc "cd '$APP_DIR' && pnpm seed" || warn "seed 失败或无输出，请手动执行 pnpm seed"

log "生产构建"
run sudo -iu "$APP_USER" bash -lc "cd '$APP_DIR' && pnpm build"

# ---------------------------------------------------------------- 6. systemd
log "配置 systemd 服务"
# 不硬编码 pnpm 路径：不同安装方式可能落在 /usr/bin 或 /usr/local/bin，
# 用 `command -v` 探测真实路径，避免 systemd 启动即失败。
# 另外直接用 node 执行 next 的入口，绕开 pnpm 这一层，启动更快、依赖更少。
if [[ $DRY_RUN -eq 1 ]]; then
  PNPM_BIN="$(command -v pnpm || echo /usr/bin/pnpm)"
  NODE_BIN="$(command -v node || echo /usr/bin/node)"
else
  PNPM_BIN="$(sudo -iu "$APP_USER" bash -lc 'command -v pnpm' || echo /usr/bin/pnpm)"
  NODE_BIN="$(sudo -iu "$APP_USER" bash -lc 'command -v node' || echo /usr/bin/node)"
fi
[[ -n "$PNPM_BIN" ]] || die "找不到 pnpm 可执行文件"
[[ -n "$NODE_BIN" ]] || die "找不到 node 可执行文件"
log "node 路径：${NODE_BIN}"
log "pnpm 路径：${PNPM_BIN}"

# 优先用 node 直接起 next（不依赖 pnpm 的 shell 包装），失败时回退到 pnpm start
if [[ -f "${APP_DIR}/node_modules/next/dist/bin/next" ]]; then
  EXEC_START="${NODE_BIN} ${APP_DIR}/node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT}"
  log "启动方式：node 直启 next"
else
  EXEC_START="${PNPM_BIN} start"
  warn "未找到 next 入口，回退为 pnpm start"
fi

if [[ $DRY_RUN -eq 0 ]]; then
  cat > /etc/systemd/system/wms.service <<EOF
[Unit]
Description=WMS 仓库管理系统
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${EXEC_START}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
else
  printf '  [dry-run] 写入 /etc/systemd/system/wms.service\n    ExecStart=%s\n' "$EXEC_START"
fi

run systemctl daemon-reload
run systemctl enable wms
run systemctl restart wms
[[ $DRY_RUN -eq 0 ]] && sleep 4

if [[ $DRY_RUN -eq 0 ]] && curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  log "应用已启动 ✔  $(curl -s "http://127.0.0.1:${PORT}/api/health")"
elif [[ $DRY_RUN -eq 0 ]]; then
  warn "应用健康检查失败，查看日志：sudo journalctl -u wms -n 100"
fi

# ---------------------------------------------------------------- 7. Caddy
log "安装并配置 Caddy（自动 HTTPS）"
if ! command -v caddy >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] 添加 Caddy 官方 apt 源并安装 caddy\n'
  else
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
  fi
fi

if [[ $DRY_RUN -eq 0 ]]; then
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:${PORT}
	encode gzip
}
EOF
else
  printf '  [dry-run] 写入 /etc/caddy/Caddyfile：%s → 127.0.0.1:%s\n' "$DOMAIN" "$PORT"
fi

run systemctl reload caddy
[[ $DRY_RUN -eq 0 ]] && sleep 3

# ---------------------------------------------------------------- 8. 备份 cron
log "配置每日自动备份（保留 30 天）"
CRON_LINE="0 3 * * * sqlite3 ${DATA_DIR}/wms.db \".backup '${APP_HOME}/backup/wms-\$(date +\\%F).db'\" && find ${APP_HOME}/backup -name 'wms-*.db' -mtime +30 -delete"
if [[ $DRY_RUN -eq 1 ]]; then
  printf '  [dry-run] 为用户 %s 安装 cron：\n    %s\n' "$APP_USER" "$CRON_LINE"
else
  ( crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'wms.db' || true ; echo "$CRON_LINE" ) | crontab -u "$APP_USER" -
fi

# ---------------------------------------------------------------- 汇总
cat <<EOF

============================================================
  部署完成
============================================================
  访问地址   https://${DOMAIN}
  应用目录   ${APP_DIR}
  数据库     ${DATA_DIR}/wms.db
  备份目录   ${APP_HOME}/backup

  下一步：
    1) 确认 Cloudflare 里 ${DOMAIN} 的 A 记录指向本机公网 IP
    2) 打开 https://${DOMAIN}，用 admin + 上面打印的密码登录并立即改密
    3) 手机访问 https://${DOMAIN}/scan 测试摄像头

  排障：
    sudo systemctl status wms
    sudo journalctl -u wms -n 100
    sudo journalctl -u caddy -n 50
============================================================
EOF

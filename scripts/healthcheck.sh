#!/usr/bin/env bash
#
# 服务器端自检脚本（部署后运行，一键确认系统是否真的正常）
#
# 用法：
#   bash healthcheck.sh wms.sasakic.cc
#
# 为什么需要：本项目的开发机是受限沙箱（禁止 fork 子进程），
# `pnpm build` 与 `next start` 无法在开发机验证。因此把「生产模式」的验证
# 交给服务器执行——这是唯一能真实验证该路径的地方。
set -uo pipefail

DOMAIN="${1:-}"
PORT="${PORT:-3100}"
APP_DIR="${APP_DIR:-/opt/wms/app}"
DATA_DIR="${DATA_DIR:-/opt/wms/data}"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s  %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
info() { printf '  ----  %s\n' "$1"; }

echo
echo "=== WMS 服务器自检 ==="
echo

# ---- 1. 运行环境 ----
echo "[运行环境]"
command -v node >/dev/null 2>&1 && ok "node 已安装（$(node -v)）" || bad "node 未安装"
command -v pnpm >/dev/null 2>&1 && ok "pnpm 已安装（$(pnpm -v)）" || bad "pnpm 未安装"
command -v sqlite3 >/dev/null 2>&1 && ok "sqlite3 已安装" || bad "sqlite3 未安装（备份 cron 会失败）"

# ---- 2. 构建产物（开发机无法验证，这里是关键）----
echo
echo "[构建产物]"
[[ -f "${APP_DIR}/.next/BUILD_ID" ]] && ok "构建产物存在（.next/BUILD_ID）" || bad "构建产物缺失" "请运行：cd ${APP_DIR} && pnpm build"
[[ -d "${APP_DIR}/.next/server" ]] && ok ".next/server 存在" || bad ".next/server 缺失"
[[ -d "${APP_DIR}/.next/static" ]] && ok ".next/static 存在" || bad ".next/static 缺失"

# ---- 3. 数据库 ----
echo
echo "[数据库]"
if [[ -f "${DATA_DIR}/wms.db" ]]; then
  ok "数据库文件存在"
  TABLES=$(sqlite3 "${DATA_DIR}/wms.db" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo 0)
  [[ "$TABLES" -ge 11 ]] && ok "表数量正确（${TABLES}）" || bad "表数量异常" "期望 >=11，实际 ${TABLES}"
  USERS=$(sqlite3 "${DATA_DIR}/wms.db" "SELECT count(*) FROM users;" 2>/dev/null || echo 0)
  [[ "$USERS" -ge 1 ]] && ok "已存在用户（${USERS} 个）" || bad "没有用户" "请运行 pnpm seed"
  PERMS=$(sqlite3 "${DATA_DIR}/wms.db" "SELECT count(*) FROM permissions;" 2>/dev/null || echo 0)
  [[ "$PERMS" -ge 15 ]] && ok "权限字典完整（${PERMS} 项）" || bad "权限字典不完整" "实际 ${PERMS}"
else
  bad "数据库文件不存在" "${DATA_DIR}/wms.db"
fi

# ---- 4. 应用服务 ----
echo
echo "[应用服务]"
systemctl is-active --quiet wms 2>/dev/null && ok "wms 服务运行中" || bad "wms 服务未运行" "sudo journalctl -u wms -n 50"
HEALTH=$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q '"ok":true'; then
  ok "本机健康检查通过"
  info "$HEALTH"
else
  bad "本机健康检查失败" "curl http://127.0.0.1:${PORT}/api/health"
fi

# ---- 5. 反向代理与 HTTPS ----
echo
echo "[反向代理 / HTTPS]"
systemctl is-active --quiet caddy 2>/dev/null && ok "caddy 运行中" || bad "caddy 未运行"
[[ -f /etc/caddy/Caddyfile ]] && ok "Caddyfile 存在" || bad "Caddyfile 缺失"

if [[ -n "$DOMAIN" ]]; then
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/health" 2>/dev/null || echo 000)
  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "https://${DOMAIN} 可访问（HTTPS 生效）"
  else
    bad "https://${DOMAIN} 返回 ${HTTP_CODE}" "检查 DNS 解析与 Caddy 证书日志"
  fi
  # 证书有效性
  if command -v openssl >/dev/null 2>&1; then
    EXPIRY=$(echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [[ -n "$EXPIRY" ]] && ok "TLS 证书有效（到期：${EXPIRY}）" || bad "无法读取 TLS 证书"
  fi
fi

# ---- 6. 防火墙 ----
echo
echo "[防火墙]"
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null && ok "iptables 放行 80" || bad "iptables 未放行 80" "见文档 §3.2"
  iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null && ok "iptables 放行 443" || bad "iptables 未放行 443" "见文档 §3.2"
fi
command -v ufw >/dev/null 2>&1 && { ufw status 2>/dev/null | grep -q '80' && ok "ufw 放行 80" || info "ufw 状态：$(ufw status 2>/dev/null | head -1)"; }

# ---- 7. 备份 ----
echo
echo "[备份]"
if crontab -u wms -l 2>/dev/null | grep -q 'wms.db'; then
  ok "备份 cron 已配置"
else
  bad "备份 cron 未配置" "见文档 §8"
fi
[[ -d /opt/wms/backup ]] && ok "备份目录存在" || bad "备份目录不存在"

# ---- 汇总 ----
echo
echo "======================================"
printf '  通过 %d 项，失败 %d 项\n' "$pass" "$fail"
echo "======================================"
if [[ $fail -gt 0 ]]; then
  echo
  echo "排障命令："
  echo "  sudo journalctl -u wms -n 100"
  echo "  sudo journalctl -u caddy -n 50"
  exit 1
fi
exit 0

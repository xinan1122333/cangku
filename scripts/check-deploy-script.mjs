/**
 * deploy-oracle.sh 静态检查（本机无 bash 时的替代验证）。
 *
 * 为什么需要：部署脚本要在 Linux 上以 root 运行，写错了代价很高（可能弄坏服务器）。
 * 本机既无 bash 也无 WSL 发行版，因此用严格的结构化检查代替：
 *   1) CRLF 检测（Linux 上 CRLF 会导致 `bash: $'\r': command not found`）
 *   2) heredoc 配对与缩进合法性
 *   3) if/fi、case/esac、do/done 配对
 *   4) 引号平衡（区分 ' " ` 与注释/heredoc 内内容）
 *   5) 危险片段扫描（rm -rf / 等）
 *   6) 关键步骤存在性（Node/pnpm/防火墙/systemd/Caddy/备份）
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'scripts/deploy-oracle.sh';
// 模式：deploy（部署脚本，需全套步骤）| healthcheck（自检脚本，只需诊断能力）
const mode = process.argv[3] || (file.includes('healthcheck') ? 'healthcheck' : 'deploy');
const raw = readFileSync(file);
const text = raw.toString('utf8');
const lines = text.split('\n');

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    fail += 1;
    console.log(`  FAIL  ${name}  ${extra}`);
  }
};

console.log(`\n=== ${file} 静态检查 ===\n`);

// 1) 行尾
const crlf = (text.match(/\r\n/g) || []).length;
ok('无 CRLF（Linux 脚本必须 LF）', crlf === 0, `发现 ${crlf} 处 CRLF`);
ok('以 shebang 开头', lines[0].startsWith('#!'));

// 2) 结构配对（跳过 heredoc 内部内容与注释）
const HHD_RE = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;
let inHhd = null;
let hhdIndentTabs = false;
const code = [];
for (const line of lines) {
  if (inHhd) {
    const probe = hhdIndentTabs ? line.replace(/^\t+/, '') : line;
    if (probe.trim() === inHhd) inHhd = null;
    else code.push('#HHD');
    continue;
  }
  const m = HHD_RE.exec(line);
  if (m) {
    inHhd = m[1] || m[2] || m[3];
    hhdIndentTabs = /<<-/.test(m[0]);
    code.push(line.replace(HHD_RE, ''));
    continue;
  }
  code.push(line);
}
ok('heredoc 全部正确闭合', inHhd === null, `未闭合的定界符: ${inHhd}`);

const codeText = code.join('\n');
const count = (re) => (codeText.match(re) || []).length;

ok('if/fi 配对', count(/^\s*if\b/gm) === count(/^\s*fi\b/gm), `if=${count(/^\s*if\b/gm)} fi=${count(/^\s*fi\b/gm)}`);
ok('do/done 配对', count(/;\s*do\b|^\s*do\b/gm) === count(/^\s*done\b/gm), `do=${count(/;\s*do\b|^\s*do\b/gm)} done=${count(/^\s*done\b/gm)}`);
ok('case/esac 配对', count(/^\s*case\b/gm) === count(/^\s*esac\b/gm));

// 3) 引号平衡（按整份代码，排除注释）
let sq = 0, dq = 0;
for (const line of code) {
  const stripped = line.replace(/(^|\s)#.*$/, '');
  let i = 0;
  while (i < stripped.length) {
    const c = stripped[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'" && dq % 2 === 0) sq += 1;
    else if (c === '"' && sq % 2 === 0) dq += 1;
    i += 1;
  }
}
ok('单引号平衡', sq % 2 === 0, `计数=${sq}`);
ok('双引号平衡', dq % 2 === 0, `计数=${dq}`);

// 4) 危险片段
const dangers = [
  [/rm\s+-rf\s+\/(\s|$)/, 'rm -rf /'],
  [/rm\s+-rf\s+\$\{?[A-Za-z_]*\}?\/?\s*$/, '未加保护的 rm -rf 变量'],
  [/>\s*\/dev\/sd[a-z]/, '直接写裸磁盘设备'],
  [/chmod\s+-R\s+777/, 'chmod -R 777'],
];
for (const [re, label] of dangers) ok(`无危险片段：${label}`, !re.test(codeText));

// 5) 关键步骤存在性（按模式区分：部署脚本与自检脚本职责不同）
const deployChecks = [
  ['set -euo pipefail', /set -euo pipefail|set -uo pipefail/],
  ['root 权限校验', /EUID\s*-eq\s*0/],
  ['域名参数校验', /缺少域名/],
  ['源码目录校验', /SRC_DIR/],
  ['安装 Node.js', /setup_24\.x/],
  ['安装 pnpm', /npm i -g pnpm|npm install -g pnpm/],
  ['防火墙放行 80/443', /dport 80/],
  ['Oracle iptables 修补', /iptables -I INPUT/],
  ['生成 JWT_SECRET', /randomBytes\(32\)/],
  ['db:init 与 seed', /pnpm db:init[\s\S]*pnpm seed/],
  ['生产构建 pnpm build', /pnpm build/],
  ['systemd 服务', /wms\.service/],
  ['Caddy 自动 HTTPS', /caddy/i],
  ['反向代理到本机端口', /reverse_proxy 127\.0\.0\.1/],
  ['每日备份 cron', /\.backup/],
  ['健康检查', /api\/health/],
  ['.env 权限收紧（600）', /chmod 600/],
  ['.env 已存在时不覆盖', /保留原文件|不覆盖/],
];

const healthChecks = [
  ['set 严格模式', /set -[a-z]*u[a-z]*o?|set -uo pipefail|set -euo pipefail/],
  ['检查 node/pnpm', /command -v node/],
  ['检查构建产物（关键，开发机无法验证）', /BUILD_ID/],
  ['检查 .next/server 与 static', /\.next\/server[\s\S]*\.next\/static/],
  ['检查数据库表数量', /sqlite_master/],
  ['检查用户与权限字典', /FROM users[\s\S]*FROM permissions/],
  ['检查 systemd 服务状态', /systemctl is-active[^\n]*wms/],
  ['检查健康端点', /api\/health/],
  ['检查 Caddy', /systemctl is-active[^\n]*caddy/],
  ['检查 HTTPS 可达', /https:\/\/\$\{DOMAIN\}/],
  ['检查 TLS 证书有效期', /openssl s_client/],
  ['检查 iptables 80/443', /iptables -C INPUT/],
  ['检查备份 cron', /crontab -u wms -l/],
  ['输出通过/失败汇总', /通过 %d 项/],
];
const mustHave = mode === 'healthcheck' ? healthChecks : deployChecks;
console.log(`  （检查模式：${mode}）`);
for (const [label, re] of mustHave) ok(`包含关键步骤：${label}`, re.test(text));

// 6) 易错点（仅部署脚本适用）
if (mode === 'deploy') {
  ok('.env 权限收紧（600）', /chmod 600/.test(codeText), '密钥文件应为 600');
  ok('变量引用基本加引号', !/cp -r \$SRC_DIR\//.test(codeText));
}

console.log(`\n${'='.repeat(52)}`);
console.log(fail === 0 ? '全部通过' : `失败 ${fail} 项`);
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);

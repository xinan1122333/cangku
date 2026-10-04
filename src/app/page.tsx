import Link from 'next/link';

export const dynamic = 'force-dynamic';

/** 根路径：给出登录入口与系统概览（未登录也可访问） */
export default function HomePage() {
  return (
    <main className="login-wrap">
      <div className="card" style={{ maxWidth: 520 }}>
        <h1 className="login-title">WMS 仓储管理系统</h1>
        <p className="muted small">物料 · 出入库 · 结存 · 盘点</p>

        <div className="stack" style={{ marginTop: 16 }}>
          <Link className="btn block" href="/login">
            登录系统
          </Link>
          <Link className="btn secondary block" href="/scan">
            手机扫码
          </Link>
        </div>

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '20px 0' }} />

        <p className="small muted" style={{ margin: 0 }}>
          接口健康检查：<a href="/api/health">/api/health</a>
        </p>
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          提示：浏览器调用摄像头扫码需要 HTTPS 或 localhost。
        </p>
      </div>
    </main>
  );
}

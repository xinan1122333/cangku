'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** 登录页：提交后跳转仪表盘（跳转目标若不存在则退回本页的错误提示） */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json?.error?.message ?? '登录失败，请重试');
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError('网络异常，请检查连接后重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <h1 className="login-title">登录 WMS</h1>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 20 }}>
          仓储管理系统
        </p>

        {error ? <div className="alert error">{error}</div> : null}

        <label className="field">
          <span>用户名</span>
          <input
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="field">
          <span>密码</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button className="btn block" type="submit" disabled={loading}>
          {loading ? '登录中…' : '登录'}
        </button>

        <p className="small muted" style={{ marginBottom: 0, marginTop: 16 }}>
          初始账号由 <span className="mono">pnpm seed</span> 创建并打印一次。
        </p>
      </form>
    </main>
  );
}

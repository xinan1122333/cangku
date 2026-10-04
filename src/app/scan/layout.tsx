"use client";

/**
 * /scan 自己的布局。
 *
 * 为什么需要：`/scan` 位于 `src/app/scan/`，在 `(app)` 路由组**之外**，
 * 因此拿不到 `(app)/layout.tsx` 里的 SessionProvider，直接调用 useSession() 会抛错。
 *
 * 采用「独立 SessionProvider + 极简外壳」而不是挪进 (app) 组：
 * 扫码页是手机全屏作业界面，不需要侧边栏/底部导航抢占摄像头视野，
 * 但仍必须能读到当前用户与权限（决定「快捷出入库」「新建物料」是否可用）。
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { request } from "../_components/api";
import { SessionProvider, useSession } from "../_components/session";
import { Button, styles } from "../_components/ui";

export default function ScanLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <div className={styles.shell}>
        <ScanTopBar />
        <main className={styles.main}>{children}</main>
      </div>
    </SessionProvider>
  );
}

function ScanTopBar() {
  const { me, loading, unauthenticated, refresh } = useSession();

  async function handleLogout() {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch {
      // 退出失败也继续跳转
    }
    await refresh();
    if (typeof window !== "undefined") window.location.href = "/login";
  }

  return (
    <header className={styles.topbar}>
      <div style={{ minWidth: 0 }}>
        <div className={styles.topbarTitle}>扫码作业</div>
        <div className={styles.topbarSub}>
          {loading ? "加载中…" : me ? `${me.displayName}（${me.role}）` : "未登录"}
        </div>
      </div>
      <div className={styles.actions}>
        {unauthenticated ? (
          <Link href="/login" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`}>
            去登录
          </Link>
        ) : (
          <>
            <Link href="/" className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSm}`}>
              返回首页
            </Link>
            <Button size="sm" variant="ghost" onClick={handleLogout}>
              退出
            </Button>
          </>
        )}
      </div>
    </header>
  );
}

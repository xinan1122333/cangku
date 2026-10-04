"use client";

/**
 * 应用外壳（手写 CSS，移动端优先）。
 * 导航按 /api/auth/me 的 permissions 过滤：无 user:read 不显示用户管理，依此类推。
 * 窄屏：顶部条 + 底部 Tab；宽屏（>640px）：左侧边栏。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button, styles } from "./ui";
import { useSession } from "./session";
import { request } from "./api";

type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** 任一权限命中即显示；空数组表示始终显示 */
  permissions: string[];
  mobile: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "仪表盘", icon: "🏠", permissions: [], mobile: true },
  { href: "/scan", label: "扫码", icon: "📷", permissions: [], mobile: true },
  { href: "/items", label: "物料", icon: "📦", permissions: ["item:read", "stock:read"], mobile: true },
  { href: "/movements", label: "流水", icon: "📋", permissions: ["movement:read"], mobile: true },
  { href: "/stocktakes", label: "盘点", icon: "✅", permissions: ["stocktake:read"], mobile: false },
  { href: "/users", label: "用户", icon: "👤", permissions: ["user:read"], mobile: false },
  { href: "/roles", label: "角色", icon: "🛡️", permissions: ["role:read"], mobile: false },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, loading, unauthenticated } = useSession();
  const pathname = usePathname() ?? "/";

  const visible = NAV_ITEMS.filter((item) => {
    if (item.permissions.length === 0) return true;
    if (!me) return false;
    const perms = me.permissions ?? [];
    return item.permissions.some((code) => perms.includes("*") || perms.includes(code));
  });

  return (
    <div className={styles.shell}>
      {/* 桌面端侧边栏 */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarBrand}>
          <div className={styles.sidebarBrandTitle}>WMS 仓储管理</div>
          <div className={styles.sidebarBrandSub}>移动端优先 · 库存流水真源</div>
        </div>
        <nav className={styles.sidebarNav}>
          {visible.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.sidebarLink} ${
                isActive(pathname, item.href) ? styles.sidebarLinkActive : ""
              }`}
            >
              <span aria-hidden>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <UserBox />
        </div>
      </aside>

      <div className={styles.content}>
        {/* 移动端顶部条 */}
        <header className={styles.topbar}>
          <div style={{ minWidth: 0 }}>
            <div className={styles.topbarTitle}>WMS 仓储管理</div>
            <div className={styles.topbarSub}>
              {loading ? "加载中…" : me ? `${me.displayName}（${me.role}）` : "未登录"}
            </div>
          </div>
          {unauthenticated ? (
            <Link href="/login" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`}>
              去登录
            </Link>
          ) : (
            <LogoutButton />
          )}
        </header>

        <main className={styles.main}>{children}</main>

        {/* 移动端底部导航 */}
        <nav className={styles.bottomNav}>
          {visible.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.bottomNavLink} ${
                isActive(pathname, item.href) ? styles.bottomNavLinkActive : ""
              }`}
            >
              <span className={styles.bottomNavIcon} aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

function LogoutButton({ block = false }: { block?: boolean }) {
  const { refresh } = useSession();

  async function handleLogout() {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch {
      // 退出失败也继续跳转登录页
    }
    await refresh();
    if (typeof window !== "undefined") window.location.href = "/login";
  }

  return (
    <Button size="sm" variant={block ? "secondary" : "ghost"} block={block} onClick={handleLogout}>
      退出
    </Button>
  );
}

function UserBox() {
  const { me, loading, unauthenticated } = useSession();

  if (loading) return <div className={styles.muted}>加载中…</div>;

  if (unauthenticated || !me) {
    return (
      <div>
        <div className={styles.muted}>未登录</div>
        <Link
          href="/login"
          className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm} ${styles.btnBlock}`}
          style={{ marginTop: 8 }}
        >
          去登录
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className={styles.userName}>{me.displayName}</div>
      <div className={styles.userMeta}>
        {me.username} · {me.role}
      </div>
      <div style={{ marginTop: 8 }}>
        <LogoutButton block />
      </div>
    </div>
  );
}

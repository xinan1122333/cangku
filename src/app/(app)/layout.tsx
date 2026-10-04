"use client";

import type { ReactNode } from "react";
import { AppShell } from "../_components/app-shell";
import { SessionProvider } from "../_components/session";

/** 登录后区域外壳：SessionProvider + 导航（导航按权限过滤） */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}

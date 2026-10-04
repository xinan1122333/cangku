"use client";

/**
 * 会话上下文：通过 /api/auth/me 拉取当前用户与权限，供导航与按钮做权限判定。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, request } from "./api";
import type { Me } from "./api";

type SessionState = {
  me: Me | null;
  loading: boolean;
  error: string | null;
  /** 是否已登录（未登录时布局显示登录入口，不强行跳转） */
  unauthenticated: boolean;
  refresh: () => Promise<void>;
  can: (code: string) => boolean;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<Me>("/api/auth/me");
      setMe(data);
      setUnauthenticated(false);
      setError(null);
    } catch (err) {
      setMe(null);
      if (err instanceof ApiError && err.status === 401) {
        setUnauthenticated(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "无法获取当前用户信息");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const can = useCallback(
    (code: string) => {
      if (!me) return false;
      const perms = me.permissions ?? [];
      return perms.includes("*") || perms.includes(code);
    },
    [me],
  );

  const value = useMemo<SessionState>(
    () => ({ me, loading, error, unauthenticated, refresh, can }),
    [me, loading, error, unauthenticated, refresh, can],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession 必须在 SessionProvider 内使用");
  return ctx;
}

/** 只要权限判定结果，避免页面重复写 me?.permissions 逻辑 */
export function useCan(): (code: string) => boolean {
  return useSession().can;
}

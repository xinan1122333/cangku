"use client";

/**
 * 仪表盘：总品类数、低库存数、今日出入库。
 * 优先读 /api/export/data（core-dev 的静态聚合 JSON），缺失则降级为多接口组合。
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { readErrorMessage, request } from "../_components/api";
import type { DashboardData, Movement, Page, StockRow } from "../_components/api";
import { useSession } from "../_components/session";
import {
  Alert,
  ButtonLink,
  Loading,
  PageHeader,
  Section,
  formatDateTime,
  styles,
  todayRange,
} from "../_components/ui";

type Stats = {
  itemTotal: number | null;
  lowStockCount: number | null;
  todayIn: number | null;
  todayOut: number | null;
  generatedAt: number | null;
};

const EMPTY: Stats = {
  itemTotal: null,
  lowStockCount: null,
  todayIn: null,
  todayOut: null,
  generatedAt: null,
};

export default function DashboardPage() {
  const { me, loading: sessionLoading, unauthenticated, can } = useSession();
  const [stats, setStats] = useState<Stats>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Movement[]>([]);

  const load = useCallback(async () => {
    if (!me) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const next: Stats = { ...EMPTY };
    const problems: string[] = [];

    // 1) 聚合数据（可选）
    try {
      const res = await fetch("/api/export/data", { credentials: "same-origin", cache: "no-store" });
      if (res.ok) {
        const payload = (await res.json()) as DashboardData;
        next.itemTotal = payload.itemTotal ?? null;
        next.lowStockCount = payload.lowStockCount ?? null;
        next.todayIn = payload.todayIn ?? null;
        next.todayOut = payload.todayOut ?? null;
        next.generatedAt = payload.generatedAt ?? null;
      }
    } catch {
      // 静默降级
    }

    // 2) 缺失项用正式接口补齐
    if (next.itemTotal === null && can("item:read")) {
      try {
        const page = await request<Page<{ id: string }>>("/api/items", { query: { page: 1, pageSize: 1 } });
        next.itemTotal = page.total;
      } catch (err) {
        problems.push(readErrorMessage(err));
      }
    }

    if (next.lowStockCount === null && can("stock:read")) {
      try {
        const rows = await request<StockRow[] | Page<StockRow>>("/api/stock", {
          query: { lowOnly: true, page: 1, pageSize: 1 },
        });
        next.lowStockCount = Array.isArray(rows) ? rows.length : rows.total;
      } catch (err) {
        problems.push(readErrorMessage(err));
      }
    }

    if ((next.todayIn === null || next.todayOut === null) && can("movement:read")) {
      try {
        const range = todayRange();
        const inPage = await request<Page<Movement>>("/api/movements", {
          query: { type: "in", from: range.from, to: range.to, page: 1, pageSize: 1 },
        });
        const outPage = await request<Page<Movement>>("/api/movements", {
          query: { type: "out", from: range.from, to: range.to, page: 1, pageSize: 1 },
        });
        next.todayIn = inPage.total;
        next.todayOut = outPage.total;
      } catch (err) {
        problems.push(readErrorMessage(err));
      }
    }

    // 3) 最近流水
    if (can("movement:read")) {
      try {
        const page = await request<Page<Movement>>("/api/movements", { query: { page: 1, pageSize: 5 } });
        setRecent(page.rows ?? []);
      } catch {
        // 忽略
      }
    }

    setStats(next);
    setError(problems.length > 0 ? problems[0] : null);
    setLoading(false);
  }, [me, can]);

  useEffect(() => {
    void load();
  }, [load]);

  if (sessionLoading) return <Loading label="正在读取会话…" />;

  if (unauthenticated || !me) {
    return (
      <div className={styles.centerCard}>
        <h1 className={styles.sectionTitle}>需要登录</h1>
        <p className={styles.pageDesc}>请先登录后再使用仓储管理功能。</p>
        <div style={{ marginTop: 16 }}>
          <ButtonLink href="/login" variant="primary">
            前往登录
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={`你好，${me.displayName}`}
        description={`角色：${me.role} · 权限 ${me.permissions.length} 项`}
        actions={
          <>
            <ButtonLink href="/scan" variant="primary">
              📷 扫码作业
            </ButtonLink>
            {can("movement:read") ? <ButtonLink href="/movements">查看流水</ButtonLink> : null}
          </>
        }
      />

      {error ? (
        <Alert kind="warning" onClose={() => setError(null)}>
          部分数据加载失败：{error}
        </Alert>
      ) : null}

      <div className={styles.statGrid}>
        <StatCard label="物料品类" value={stats.itemTotal} unit="种" loading={loading} />
        <StatCard
          label="低库存"
          value={stats.lowStockCount}
          unit="种"
          loading={loading}
          tone={stats.lowStockCount && stats.lowStockCount > 0 ? "danger" : "normal"}
        />
        <StatCard label="今日入库" value={stats.todayIn} unit="笔" loading={loading} tone="success" />
        <StatCard label="今日出库" value={stats.todayOut} unit="笔" loading={loading} tone="warn" />
      </div>

      <div className={styles.grid2}>
        <Section
          title="最近流水"
          description="最新 5 条进出记录"
          actions={
            can("movement:read") ? (
              <Link href="/movements" className={styles.muted}>
                全部流水 →
              </Link>
            ) : null
          }
        >
          {!can("movement:read") ? (
            <p className={styles.empty}>当前角色无流水查看权限</p>
          ) : loading ? (
            <Loading />
          ) : recent.length === 0 ? (
            <p className={styles.empty}>暂无流水记录</p>
          ) : (
            <ul className={styles.list}>
              {recent.map((row) => (
                <li key={row.id} className={styles.listRow}>
                  <div className={styles.listRowMain}>
                    <div className={styles.listRowTitle}>
                      {row.itemName || row.sku || row.itemId}
                    </div>
                    <div className={styles.listRowSub}>
                      {formatDateTime(row.occurredAt)} · {row.operatorName ?? "—"}
                    </div>
                  </div>
                  <span className={row.signedQuantity >= 0 ? styles.deltaPos : styles.deltaNeg}>
                    {row.signedQuantity >= 0 ? "+" : ""}
                    {row.signedQuantity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="快捷入口" description="常用作业">
          <div className={styles.quickGrid}>
            <QuickLink href="/scan" label="扫码入库/出库" icon="📷" />
            <QuickLink href="/items" label="物料档案" icon="📦" disabled={!can("item:read")} />
            <QuickLink href="/movements" label="进出流水" icon="📋" disabled={!can("movement:read")} />
            <QuickLink href="/stocktakes" label="盘点单" icon="✅" disabled={!can("stocktake:read")} />
            <QuickLink href="/users" label="用户管理" icon="👤" disabled={!can("user:read")} />
            <QuickLink href="/roles" label="角色权限" icon="🛡️" disabled={!can("role:read")} />
          </div>
          {stats.generatedAt ? (
            <p className={styles.hint}>聚合数据生成时间：{formatDateTime(stats.generatedAt)}</p>
          ) : null}
        </Section>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  unit,
  loading,
  tone = "normal",
}: {
  label: string;
  value: number | null;
  unit: string;
  loading: boolean;
  tone?: "normal" | "danger" | "success" | "warn";
}) {
  const tones: Record<string, string> = {
    normal: "",
    danger: styles.toneDanger,
    success: styles.toneSuccess,
    warn: styles.toneWarn,
  };
  return (
    <div className={styles.statCard}>
      <div className={styles.statLabel}>{label}</div>
      <div className={`${styles.statValue} ${tones[tone]}`}>
        {loading ? <span className={styles.muted}>…</span> : (value ?? "—")}
        <span className={styles.statUnit}>{unit}</span>
      </div>
    </div>
  );
}

function QuickLink({
  href,
  label,
  icon,
  disabled,
}: {
  href: string;
  label: string;
  icon: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <div className={styles.quickLinkDisabled}>
        <span aria-hidden>{icon}</span>
        {label}
      </div>
    );
  }
  return (
    <Link href={href} className={styles.quickLink}>
      <span aria-hidden>{icon}</span>
      {label}
    </Link>
  );
}

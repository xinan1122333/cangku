"use client";

/**
 * 通用 UI 原子组件（移动端优先，手写 CSS Module，不依赖 Tailwind）。
 * 窄屏用 MobileCards 卡片布局，宽屏用 TableWrap 表格。
 */

import { useEffect, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import styles from "./ui.module.css";

/* ------------------------------- 布局 ------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {description ? <p className={styles.pageDesc}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${styles.section} ${className}`}>
      {title || actions || description ? (
        <div className={styles.sectionHead}>
          <div>
            {title ? <h2 className={styles.sectionTitle}>{title}</h2> : null}
            {description ? <p className={styles.sectionDesc}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

/** 宽屏显示的表格容器 */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}

export function TableDesktop({ children }: { children: ReactNode }) {
  return <div className={styles.tableDesktop}>{children}</div>;
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={className}>{children}</th>;
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={className}>{children}</td>;
}

/** 窄屏卡片列表容器（宽屏自动隐藏） */
export function MobileCards({ children }: { children: ReactNode }) {
  return <div className={styles.mobileCards}>{children}</div>;
}

export function MobileCard({
  title,
  subtitle,
  badge,
  rows,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  rows?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.mobileCard}>
      <div className={styles.mobileCardHead}>
        <div style={{ minWidth: 0 }}>
          <div className={styles.mobileCardTitle}>{title}</div>
          {subtitle ? <div className={styles.mobileCardSub}>{subtitle}</div> : null}
        </div>
        {badge ? <div style={{ flex: "none" }}>{badge}</div> : null}
      </div>
      {rows && rows.length > 0 ? (
        <dl className={styles.mobileCardRows}>
          {rows.map((row) => (
            <div key={row.label} className={styles.mobileCardRow}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actions ? <div className={styles.mobileCardActions}>{actions}</div> : null}
    </div>
  );
}

/* ------------------------------- 按钮 ------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: styles.btnPrimary,
  secondary: styles.btnSecondary,
  ghost: styles.btnGhost,
  danger: styles.btnDanger,
};

export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  block?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={`${styles.btn} ${BUTTON_VARIANT[variant]} ${size === "sm" ? styles.btnSm : ""} ${
        block ? styles.btnBlock : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** 链接样式按钮（用于导出/跳转） */
export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  className = "",
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={`${styles.btn} ${BUTTON_VARIANT[variant]} ${size === "sm" ? styles.btnSm : ""} ${className}`}
    >
      {children}
    </a>
  );
}

/* ------------------------------- 表单 ------------------------------- */

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`${styles.field} ${className}`}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint && !error ? <span className={styles.fieldHint}>{hint}</span> : null}
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </label>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${styles.control} ${className}`} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`${styles.control} ${className}`}>
      {children}
    </select>
  );
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`${styles.control} ${className}`} />;
}

export function Checkbox({
  label,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={`${styles.checkbox} ${className}`}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------- 反馈 ------------------------------- */

export function Alert({
  kind = "error",
  children,
  onClose,
}: {
  kind?: "error" | "success" | "info" | "warning";
  children: ReactNode;
  onClose?: () => void;
}) {
  const tone: Record<string, string> = {
    error: styles.alertError,
    success: styles.alertSuccess,
    info: styles.alertInfo,
    warning: styles.alertWarning,
  };
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`${styles.alert} ${tone[kind]}`}>
      <div className={styles.alertBody}>{children}</div>
      {onClose ? (
        <button type="button" className={styles.alertClose} onClick={onClose}>
          关闭
        </button>
      ) : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "green" | "red" | "amber" | "blue";
}) {
  const tones: Record<string, string> = {
    slate: styles.badgeSlate,
    green: styles.badgeGreen,
    red: styles.badgeRed,
    amber: styles.badgeAmber,
    blue: styles.badgeBlue,
  };
  return <span className={`${styles.badge} ${tones[tone]}`}>{children}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function Loading({ label = "加载中…" }: { label?: string }) {
  return <div className={styles.loading}>{label}</div>;
}

/* ------------------------------- 抽屉 ------------------------------- */

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={styles.drawerOverlay}>
      <button type="button" aria-label="关闭" className={styles.drawerBackdrop} onClick={onClose} />
      <div className={styles.drawerPanel} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.drawerHead}>
          <h2 className={styles.drawerTitle}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className={styles.drawerBody}>{children}</div>
        {footer ? <div className={styles.drawerFoot}>{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------- 分页 ------------------------------- */

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return (
    <div className={styles.pagination}>
      <span>
        共 {total} 条 · 第 {page}/{pageCount} 页
      </span>
      <div className={styles.actions}>
        <Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          上一页
        </Button>
        <Button size="sm" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
          下一页
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------- 工具 ------------------------------- */

export function formatDateTime(value?: number | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateInput(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function todayRange(): { from: string; to: string } {
  const today = formatDateInput(new Date());
  return { from: today, to: today };
}

export const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  in: "入库",
  out: "出库",
  adjust: "调整",
  stocktake: "盘点",
};

export const STOCKTAKE_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  counting: "盘点中",
  posted: "已过账",
  cancelled: "已取消",
};

/** 防抖值（搜索框用） */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export { styles };

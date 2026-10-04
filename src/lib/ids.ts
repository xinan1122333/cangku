import { randomUUID } from 'node:crypto';

/** 生成 UUID v4 主键 */
export function newId(): string {
  return randomUUID();
}

/** 生成带前缀的业务单号，例如 `PD20261004163012-A1B2` */
export function newCode(prefix: string, date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const tail = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
  return `${prefix}${stamp}-${tail}`;
}

export function nowMs(): number {
  return Date.now();
}

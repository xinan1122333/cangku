import { getDb, bindParams } from './db';
import { newId, nowMs } from './ids';

export interface AuditInput {
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: unknown;
  ip?: string | null;
}

/**
 * 写审计日志。必须在事务内调用（与业务写入同生共死）。
 * 审计失败直接抛出，让外层事务回滚——不允许「有业务无审计」。
 */
export function writeAudit(input: AuditInput): string {
  const db = getDb();
  const id = newId();
  db.prepare(
    `INSERT INTO audit_logs
       (id, actor_id, actor_name, action, entity, entity_id, detail_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...bindParams([
      id,
      input.actorId ?? null,
      input.actorName ?? null,
      input.action,
      input.entity,
      input.entityId ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      input.ip ?? null,
      nowMs(),
    ]),
  );
  return id;
}

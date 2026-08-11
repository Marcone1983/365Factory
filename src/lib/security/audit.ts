import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('security.audit');

export interface AuditEntry {
  readonly actorType: 'user' | 'agent' | 'system' | 'anonymous';
  readonly actorId?: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly outcome?: 'success' | 'failure' | 'denied';
  readonly metadata?: Record<string, unknown>;
  readonly ip?: string;
}

export function audit(entry: AuditEntry): void {
  try {
    db()
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, outcome, metadata, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('aud'),
        entry.actorType,
        entry.actorId ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.outcome ?? 'success',
        toJson(entry.metadata ?? {}),
        entry.ip ?? null,
        nowIso(),
      );
  } catch (error) {
    log.error('failed to write audit entry', { error, action: entry.action });
  }
}

export interface AuditRow {
  readonly id: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly outcome: string;
  readonly metadata: string;
  readonly ip: string | null;
  readonly created_at: string;
}

export function recentAudit(limit = 100): AuditRow[] {
  return db()
    .prepare<[number], AuditRow>('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(limit, 1000));
}

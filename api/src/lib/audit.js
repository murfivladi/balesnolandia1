import { q } from '../db.js';

export async function audit(conn, actor, action, entity = null, entityId = null, data = null) {
  await q(
    'INSERT INTO audit_log (actor_kind, actor_id, action, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)',
    [actor?.kind || null, actor?.id || null, action, entity, entityId, data ? JSON.stringify(data) : null],
    conn,
  );
}

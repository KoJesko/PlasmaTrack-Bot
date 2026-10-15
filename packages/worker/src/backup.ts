// Weekly backup of the bot's D1 database to the private R2 bucket `plasmatrack-backups`
// (docs/OPERATIONS.md, "Restore a backup"). Each backup is one SQL file that restores
// the tables exactly: `npx wrangler d1 execute plasmatrack-bot --remote --file <file>`.
// Only the newest BACKUPS_KEPT are kept, and older ones are deleted only after a new
// one has been written, so a failed run never leaves fewer good copies.

/**
 * Tables worth restoring. rate_limits (20 s windows) and manual_drafts (1 hour) are
 * left out: a restored copy would already be stale.
 */
export const BACKUP_TABLES = ['notices', 'token_grants', 'review_posts', 'job_versions', 'dedupe'] as const;
export const BACKUPS_KEPT = 2;
export const BACKUP_PREFIX = 'd1/plasmatrack-bot/';
const PAGE = 500;

type Value = string | number | null | ArrayBuffer;

export interface BackupResult {
  key: string;
  bytes: number;
  rows: Record<string, number>;
  /** Older backups removed after this one was written. */
  deleted: string[];
}

/** `d1/plasmatrack-bot/2026-10-18T03-47-00Z.sql`: sorts by time as text. */
export function backupKey(now: number): string {
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${BACKUP_PREFIX}${stamp}.sql`;
}

/**
 * One SQL literal. Text is quoted, numbers written as is, blobs as X'..'. Line breaks
 * in text become char(10)/char(13), so every statement stays on one line.
 */
export function sqlLiteral(value: Value): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`can't back up the number ${value}`);
    return String(value);
  }
  if (value instanceof ArrayBuffer) {
    return `X'${[...new Uint8Array(value)].map((b) => b.toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${value
    .replace(/'/g, "''")
    .replace(/\n/g, "' || char(10) || '")
    .replace(/\r/g, "' || char(13) || '")}'`;
}

/** The whole backup as SQL: per table, empty it, then insert every row. */
export async function dumpTables(db: D1Database, tables: readonly string[] = BACKUP_TABLES): Promise<{ sql: string; rows: Record<string, number> }> {
  const lines = ['-- PlasmaTrack bot D1 backup. Restores these tables exactly (existing rows are replaced).'];
  const rows: Record<string, number> = {};
  for (const table of tables) {
    lines.push('', `DELETE FROM ${table};`);
    rows[table] = 0;
    // rowid paging keeps each read small and the order stable.
    let after = -1;
    for (;;) {
      const { results } = await db
        .prepare(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`)
        .bind(after)
        .all<Record<string, Value>>();
      for (const row of results) {
        after = row['_rowid'] as number;
        const columns = Object.keys(row).filter((c) => c !== '_rowid');
        lines.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => sqlLiteral(row[c] ?? null)).join(', ')});`);
      }
      rows[table] += results.length;
      if (results.length < PAGE) break;
    }
  }
  return { sql: `${lines.join('\n')}\n`, rows };
}

/** Writes a new backup, then deletes all but the newest `keep`. */
export async function backupDatabase(db: D1Database, bucket: R2Bucket, now: number, keep = BACKUPS_KEPT): Promise<BackupResult> {
  const { sql, rows } = await dumpTables(db);
  const key = backupKey(now);
  const bytes = new TextEncoder().encode(sql);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: 'application/sql' },
    customMetadata: { rows: JSON.stringify(rows) },
  });

  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Never the one just written, even if a misnamed object sorts after it.
  const deleted = keys.sort().reverse().slice(keep).filter((k) => k !== key);
  if (deleted.length > 0) await bucket.delete(deleted);
  return { key, bytes: bytes.length, rows, deleted };
}

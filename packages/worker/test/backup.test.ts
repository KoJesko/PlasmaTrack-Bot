import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_PREFIX, backupDatabase, backupKey, dumpTables, sqlLiteral } from '../src/backup.ts';
import worker, { BACKUP_CRON } from '../src/index.ts';

const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 9, 18, 3, 47);

async function clearBackups() {
  const listed = await env.BACKUPS!.list({ prefix: BACKUP_PREFIX });
  if (listed.objects.length > 0) await env.BACKUPS!.delete(listed.objects.map((o) => o.key));
}

async function backupKeys() {
  return (await env.BACKUPS!.list({ prefix: BACKUP_PREFIX })).objects.map((o) => o.key).sort();
}

/** Runs a backup file the way `wrangler d1 execute --file` would (one statement per line). */
async function restore(sql: string) {
  const statements = sql.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

beforeEach(async () => {
  await clearBackups();
  for (const t of ['notices', 'token_grants', 'review_posts', 'job_versions', 'dedupe']) await env.DB.exec(`DELETE FROM ${t}`);
});

describe('sqlLiteral', () => {
  it('quotes text, writes numbers and NULL, and hex-encodes blobs', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral('a\nb')).toBe("replace('a~n0~b', '~n0~', char(10))");
    expect(sqlLiteral('a\r\nb')).toBe("replace(replace('a~r0~~n0~b', '~r0~', char(13)), '~n0~', char(10))");
    // A marker already in the text, or one a line break would complete, is skipped.
    expect(sqlLiteral('~n0~\n')).toBe("replace('~n0~~n1~', '~n1~', char(10))");
    expect(sqlLiteral('~n0\n')).toBe("replace('~n0~n1~', '~n1~', char(10))");
    expect(sqlLiteral(42)).toBe('42');
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(new Uint8Array([0, 255]).buffer)).toBe("X'00ff'");
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });
});

describe('backupKey', () => {
  it('is a time-sortable name under the prefix', () => {
    expect(backupKey(T0)).toBe('d1/plasmatrack-bot/2026-10-18T03-47-00Z.sql');
  });
});

describe('dumpTables', () => {
  it('restores every row exactly, including quotes, newlines and NULLs', async () => {
    await env.DB.prepare(
      'INSERT INTO notices (discord_user_id, id, kind, text, created_at, expires_at, read_at, backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('111', 'n1', 'invalid', "Job 7K2M-9QXA: it's \"invalid\"\nsecond line", 1, 2, null, 'test')
      .run();
    // Far more line breaks than D1's expression depth limit (100), plus tricky markers.
    const long = Array.from({ length: 1500 }, (_, i) => `line ${i} ~n0~ ~r0`).join('\r\n');
    await env.DB.prepare(
      'INSERT INTO notices (discord_user_id, id, kind, text, created_at, expires_at, read_at, backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind('111', 'n2', 'info', long, 1, 2, null, 'test')
      .run();
    await env.DB.prepare('INSERT INTO review_posts (backend, job_id, channel_id, message_id) VALUES (?, ?, ?, ?)')
      .bind('test', '7K2M9QXA', '222', '333')
      .run();
    // More than one page of rows.
    await env.DB.batch(
      Array.from({ length: 1201 }, (_, i) => env.DB.prepare('INSERT INTO dedupe (key, expires_at) VALUES (?, ?)').bind(`evt_${i}`, i)),
    );

    const before = await snapshot();
    const { sql, rows } = await dumpTables(env.DB);
    expect(rows).toEqual({ notices: 2, token_grants: 0, review_posts: 1, job_versions: 0, dedupe: 1201 });
    // One statement per line, so a newline inside text must not break a line.
    expect(sql.split('\n').filter((l) => l.startsWith('INSERT INTO dedupe'))).toHaveLength(1201);

    // Damage the tables, then restore.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM notices'),
      env.DB.prepare('UPDATE dedupe SET expires_at = 0'),
      env.DB.prepare("INSERT INTO job_versions (job_id, version, updated_at) VALUES ('X', 1, 1)"),
    ]);
    await restore(sql);
    expect(await snapshot()).toEqual(before);
  });

  it('round-trips texts that look like its own line-break markers', async () => {
    // Includes the server's test cases (its 575bcf4).
    const texts = ['~n0~r0\r~n1\n', '~n\n0~', '~n0\n', '~r0\r', '~n0~\n~r0~\r', '\r\n\r\n~n0~~r0~'];
    await env.DB.batch(
      texts.map((t, i) => env.DB.prepare('INSERT INTO dedupe (key, expires_at) VALUES (?, ?)').bind(t, i)),
    );
    const { sql } = await dumpTables(env.DB);
    await env.DB.exec('DELETE FROM dedupe');
    await restore(sql);
    const { results } = await env.DB.prepare('SELECT key FROM dedupe ORDER BY expires_at').all<{ key: string }>();
    expect(results.map((r) => r.key)).toEqual(texts);
  });

  it('leaves out short-lived tables', async () => {
    const { sql } = await dumpTables(env.DB);
    expect(sql).not.toContain('rate_limits');
    expect(sql).not.toContain('manual_drafts');
  });
});

async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const t of ['notices', 'token_grants', 'review_posts', 'job_versions', 'dedupe']) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()).results;
  }
  return out;
}

describe('backupDatabase', () => {
  it('keeps only the newest two backups', async () => {
    for (let week = 0; week < 4; week++) await backupDatabase(env.DB, env.BACKUPS!, T0 + week * 7 * DAY);
    expect(await backupKeys()).toEqual([backupKey(T0 + 14 * DAY), backupKey(T0 + 21 * DAY)]);
  });

  it('reports what it wrote and deleted', async () => {
    await backupDatabase(env.DB, env.BACKUPS!, T0);
    await backupDatabase(env.DB, env.BACKUPS!, T0 + 7 * DAY);
    const third = await backupDatabase(env.DB, env.BACKUPS!, T0 + 14 * DAY);
    expect(third.key).toBe(backupKey(T0 + 14 * DAY));
    expect(third.deleted).toEqual([backupKey(T0)]);
    expect(third.bytes).toBeGreaterThan(0);
    const stored = await env.BACKUPS!.get(third.key);
    expect(stored?.httpMetadata?.contentType).toBe('application/sql');
  });

  it('deletes nothing when the new backup can’t be written', async () => {
    await backupDatabase(env.DB, env.BACKUPS!, T0);
    await backupDatabase(env.DB, env.BACKUPS!, T0 + 7 * DAY);
    const failing = new Proxy(env.BACKUPS!, {
      get(target, prop) {
        if (prop === 'put') return () => Promise.reject(new Error('R2 is down'));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(backupDatabase(env.DB, failing, T0 + 14 * DAY)).rejects.toThrow('R2 is down');
    expect(await backupKeys()).toEqual([backupKey(T0), backupKey(T0 + 7 * DAY)]);
  });

  it('never deletes the backup it just wrote', async () => {
    // A misnamed object that sorts after every real backup.
    await env.BACKUPS!.put(`${BACKUP_PREFIX}9999.sql`, 'x');
    await env.BACKUPS!.put(`${BACKUP_PREFIX}9998.sql`, 'x');
    const result = await backupDatabase(env.DB, env.BACKUPS!, T0);
    expect(await backupKeys()).toContain(result.key);
  });
});

describe('scheduled', () => {
  it('backs up on the weekly cron only', async () => {
    let ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '17 3 * * *', scheduledTime: T0 }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await backupKeys()).toEqual([]);

    ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: BACKUP_CRON, scheduledTime: T0 }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await backupKeys()).toHaveLength(1);
  });
});

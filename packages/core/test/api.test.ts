import { describe, expect, it } from 'vitest';
import { ApiError, idempotencyKey, PlasmaTrackApi, ReasonError, routeTemplate } from '../src/api/client.ts';
import { apiFailure, NOT_CONNECTED, requireApi } from '../src/api/errors.ts';
import { formatJobId, parseJobId } from '../src/api/ids.ts';
import { toRouteRenderRequest } from '../src/api/route.ts';
import { RetryableError, UserFacingError } from '../src/interactions/types.ts';
import { routeRenderRequestSchema } from '../src/render/protocol.ts';
import { ADMIN_ID, BASE_URL, BOT_TOKEN, MockPlasmaTrackServer, OTHER_ID, PLAYER_ID, READ_TOKEN } from './mock-api.ts';

function setup(token = BOT_TOKEN) {
  const server = new MockPlasmaTrackServer();
  const api = new PlasmaTrackApi({ baseUrl: BASE_URL + '/', token, fetch: server.fetch, timeoutMs: 200 });
  return { server, api, admin: api.admin(ADMIN_ID) };
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

describe('job IDs', () => {
  it('reads what players type', () => {
    expect(parseJobId('7K2M-9QXA')).toBe('7K2M9QXA');
    expect(parseJobId(' 7k2m9qxa ')).toBe('7K2M9QXA');
    expect(parseJobId('7K2M 9QXA')).toBe('7K2M9QXA');
    // I, L → 1 and O → 0 (Crockford)
    expect(parseJobId('IL0O-ABCD')).toBe('1100ABCD');
  });

  it('rejects anything else', () => {
    for (const bad of ['', '7K2M9QX', '7K2M9QXAB', '7K2M-9QXU', 'job 7K2M9QXA', '7K2M_9QXA']) {
      expect(parseJobId(bad)).toBeNull();
    }
  });

  it('formats for display', () => {
    expect(formatJobId('7K2M9QXA')).toBe('7K2M-9QXA');
    expect(formatJobId('not-a-job-id')).toBe('not-a-job-id');
  });
});

describe('API client: requests', () => {
  it('sends the bot token, and the actor only on admin calls', async () => {
    const { server, api, admin } = setup();
    await api.getPlayer(PLAYER_ID);
    await admin.reviewQueueCount();
    const [pub, adm] = server.calls;
    expect(pub!.headers['authorization']).toBe(`Bearer ${BOT_TOKEN}`);
    expect(pub!.headers['x-plasmatrack-actor']).toBeUndefined();
    expect(pub!.path).toBe(`/api/v1/public/players/${PLAYER_ID}`);
    expect(adm!.headers['x-plasmatrack-actor']).toBe(ADMIN_ID);
  });

  it('sends Idempotency-Key and the trimmed reason on admin writes', async () => {
    const { server, admin } = setup();
    await admin.decide('R3VW5T6Y', 'approve', { reason: '  Checked the route.  ', idempotencyKey: 'i-1:approve' });
    const call = server.calls.at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/api/v1/admin/jobs/R3VW5T6Y/approve');
    expect(call.headers['idempotency-key']).toBe('i-1:approve');
    expect(call.body).toEqual({ reason: 'Checked the route.' });
  });

  it('refuses a missing or overlong reason before sending anything', async () => {
    const { server, admin } = setup();
    expect(() => admin.decide('R3VW5T6Y', 'approve', { reason: ' a ', idempotencyKey: 'k' })).toThrow(ReasonError);
    expect(() => admin.decide('R3VW5T6Y', 'approve', { reason: 'x'.repeat(1001), idempotencyKey: 'k' })).toThrow(ReasonError);
    expect(server.calls).toHaveLength(0);
  });

  it('derives idempotency keys from the interaction', () => {
    expect(idempotencyKey('1234567890', 'approve')).toBe('1234567890:approve');
    expect(idempotencyKey('1', 'a b')).toBe('1:a_b');
    expect(idempotencyKey('1', 'x'.repeat(300))).toHaveLength(128);
  });

  it('labels routes without IDs, for logs', () => {
    expect(routeTemplate(`/players/${PLAYER_ID}/token`)).toBe('/players/:discord_id/token');
    expect(routeTemplate('/admin/jobs/7K2M9QXA/approve')).toBe('/admin/jobs/:job_id/approve');
    expect(routeTemplate('/admin/bonuses/bon_2kd8')).toBe('/admin/bonuses/:bon_id');
  });
});

describe('API client: responses', () => {
  it('parses a profile, ignoring unknown fields', async () => {
    const { api } = setup();
    const p = await api.getPlayer(PLAYER_ID);
    expect(p.linked).toBe(true);
    if (p.linked) expect(p.stats.ets2.points).toBe(7);
    expect(await api.getPlayer(OTHER_ID)).toMatchObject({ linked: false, discord_user_id: OTHER_ID });
  });

  it('maps unknown enum values to "other"', async () => {
    const { server, api } = setup();
    server.addJob({ job_id: 'ZZZZ0000', game: 'ets2', owner: PLAYER_ID, outcome: 'parked' as never });
    expect((await api.getJob('ZZZZ0000')).outcome).toBe('other');
    const route = await api.getRoute('7K2M9QXA');
    expect(route.features[3]!.properties.scale_class).toBe('other');
  });

  it('walks pages with the cursor', async () => {
    const { api } = setup();
    const first = await api.listPlayerJobs('ets2', PLAYER_ID, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.next_cursor).not.toBeNull();
    expect(first.next_cursor!.length).toBeLessThanOrEqual(64);
    const second = await api.listPlayerJobs('ets2', PLAYER_ID, { limit: 1, cursor: first.next_cursor });
    expect(second.items[0]!.job_id).not.toBe(first.items[0]!.job_id);
    expect(second.next_cursor).toBeNull();
  });

  it('returns null for a missing token instead of throwing', async () => {
    const { api } = setup();
    expect(await api.getOwnToken(OTHER_ID)).toBeNull();
    expect(await api.getOwnToken(PLAYER_ID)).toMatchObject({ token_id: 'tok_4hq9x2' });
  });

  it('a replayed token issue never returns the plaintext again', async () => {
    const { api } = setup();
    const first = await api.issueOwnToken(OTHER_ID, 'Newcomer', 'int-1:link');
    expect(first.token.token).toMatch(/^pt_live_/);
    expect(first.user.created).toBe(true);
    const replay = await api.issueOwnToken(OTHER_ID, 'Newcomer', 'int-1:link');
    expect(replay.token.token).toBeNull();
    expect(replay.token.token_id).toBe(first.token.token_id);
  });

  it('reports a contract mismatch by field path, never by value', async () => {
    const server = new MockPlasmaTrackServer();
    const api = new PlasmaTrackApi({
      baseUrl: BASE_URL,
      token: BOT_TOKEN,
      fetch: async () => Response.json({ user: {}, token: { token: 'pt_live_SECRET' } }, { status: 201 }),
    });
    void server;
    const err = await failure(api.issueOwnToken(OTHER_ID, 'x', 'k'));
    expect(err.code).toBe('bad_response');
    expect(err.message).not.toContain('pt_live_SECRET');
    expect(err.message).toContain('user.user_id');
  });
});

describe('API client: errors', () => {
  it('surfaces the server error code and details', async () => {
    const { admin } = setup();
    const err = await failure(admin.decide('4QH82KDM', 'approve', { reason: 'Looks fine', idempotencyKey: 'k1' }));
    expect(err).toMatchObject({ status: 409, code: 'invalid_transition', details: { from: 'discarded', action: 'approve' } });
    expect(err.retryable).toBe(false);
  });

  it('only admins may act', async () => {
    const { api } = setup();
    const err = await failure(api.admin(PLAYER_ID).reviewQueueCount());
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('the read token cannot write', async () => {
    const { api } = setup(READ_TOKEN);
    await api.getPlayer(PLAYER_ID);
    const err = await failure(api.revokeOwnToken(PLAYER_ID, 'k'));
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('marks 429 and 5xx retryable, with Retry-After', async () => {
    const { server, api } = setup();
    server.failNext(429, 'rate_limited', { 'Retry-After': '12' });
    const err = await failure(api.getPlayer(PLAYER_ID));
    expect(err).toMatchObject({ status: 429, retryable: true, retryAfterSeconds: 12 });
    server.failNext(503, 'unavailable');
    expect((await failure(api.getPlayer(PLAYER_ID))).retryable).toBe(true);
  });

  it('times out slow calls as retryable', async () => {
    const { server, api } = setup();
    server.delayMs = 1000;
    const err = await failure(api.getPlayer(PLAYER_ID));
    expect(err).toMatchObject({ status: 0, code: 'timeout', retryable: true });
  });

  it('reusing a key with a different body is refused', async () => {
    const { admin } = setup();
    await admin.decide('R3VW5T6Y', 'approve', { reason: 'Checked it', idempotencyKey: 'same' });
    const err = await failure(admin.decide('H8JK2MNP', 'approve', { reason: 'Checked it', idempotencyKey: 'same' }));
    expect(err.code).toBe('idempotency_mismatch');
  });
});

describe('moderation flow against the mock', () => {
  it('approve, void and restore follow the contract transitions and etag', async () => {
    const { server, admin } = setup();
    const job = await admin.job('R3VW5T6Y');
    const approved = await admin.decide('R3VW5T6Y', 'approve', { reason: 'Route checked', idempotencyKey: 'a', expectedEtag: job.etag });
    expect(approved).toMatchObject({ outcome: 'approved', points: 90.3, held_points: null });

    // A stale etag (another moderator acted first) is a conflict.
    const stale = await failure(admin.decide('R3VW5T6Y', 'reject', { reason: 'Changed my mind', idempotencyKey: 'b', expectedEtag: job.etag }));
    expect(stale.code).toBe('conflict');

    await admin.decide('R3VW5T6Y', 'void', { reason: 'Duplicate', idempotencyKey: 'c' });
    const restored = await admin.decide('R3VW5T6Y', 'restore', { reason: 'Not a duplicate', idempotencyKey: 'd' });
    expect(restored.outcome).toBe('approved');
    expect(server.audit.map((a) => a['action'])).toEqual(['job.approve', 'job.void', 'job.restore']);
  });

  it('a moderator-issued token is created at the call, audited to the moderator', async () => {
    const { server, admin } = setup();
    const res = await admin.issueToken(OTHER_ID, 'Newcomer', { reason: 'Asked in #support', idempotencyKey: 'btn-1:token' });
    expect(res.token.token).toMatch(/^pt_live_/);
    expect(server.audit.at(-1)).toMatchObject({ action: 'token.issue', actor: { discord_user_id: ADMIN_ID }, reason: 'Asked in #support' });
  });

  it('recalculation: dry run, then one run at a time', async () => {
    const { admin } = setup();
    expect(await admin.recalculationDryRun('ets2', { reason: 'Bonus added', idempotencyKey: 'r0' })).toMatchObject({ affected_jobs: 2 });
    const started = await admin.startRecalculation(undefined, { reason: 'Bonus added', idempotencyKey: 'r1' });
    expect(started.operation_id).toMatch(/^op_/);
    expect((await admin.operation(started.operation_id)).status).toBe('running');
    const busy = await failure(admin.startRecalculation(undefined, { reason: 'Again', idempotencyKey: 'r2' }));
    expect(busy.code).toBe('conflict');
  });

  it('bonus CRUD and revocations', async () => {
    const { admin } = setup();
    const bonus = await admin.createBonus(
      { game: 'ets2', label: 'Medical week', match: 'med_*', match_kind: 'glob', kind: 'multiplier', amount: 1.5, active_from: '2026-10-19T00:00:00.000Z', active_to: '2026-10-26T00:00:00.000Z' },
      { reason: 'October event', idempotencyKey: 'b1' },
    );
    expect(bonus.status).toBe('scheduled');
    expect((await admin.updateBonus(bonus.bonus_id, { amount: 2 }, { reason: 'Bigger', idempotencyKey: 'b2' })).amount).toBe(2);
    expect((await admin.archiveBonus(bonus.bonus_id, { reason: 'Cancelled', idempotencyKey: 'b3' })).status).toBe('archived');

    const rev = await admin.scheduleRevocation({ kind: 'release', id: 'rel_0_1_0' }, { reason: 'Plugin bug', idempotencyKey: 'v1' });
    expect(Date.parse(rev.effective_at) - Date.parse(rev.announced_at)).toBe(21 * 24 * 3600_000);
    await admin.cancelRevocation(rev.revocation_id, { reason: 'Fixed otherwise', idempotencyKey: 'v2' });
    expect((await failure(admin.cancelRevocation(rev.revocation_id, { reason: 'Again', idempotencyKey: 'v3' }))).code).toBe('invalid_transition');
  });

  it('config versions report validator errors', async () => {
    const { admin } = setup();
    const err = await failure(admin.publishConfigVersion('garbage', true, { reason: 'Test', idempotencyKey: 'c1' }));
    expect(err).toMatchObject({ status: 422, code: 'validation_failed' });
    expect((await admin.publishConfigVersion('a = 1', true, { reason: 'Test', idempotencyKey: 'c2' })).current).toBe(true);
  });
});

describe('task error mapping', () => {
  it('turns API failures into retries or user messages', () => {
    expect(apiFailure(new ApiError(503, 'unavailable', 'x', {}, 9))).toBeInstanceOf(RetryableError);
    expect((apiFailure(new ApiError(503, 'unavailable', 'x', {}, 9)) as RetryableError).delaySeconds).toBe(9);
    expect(apiFailure(new ApiError(404, 'not_found', 'x'), { notFound: 'No job with that ID.' }).message).toBe('No job with that ID.');
    expect(apiFailure(new ApiError(409, 'invalid_transition', 'x', { from: 'discarded', action: 'approve' })).message).toBe(
      'A job that is discarded can’t be given “approve”.',
    );
    expect(apiFailure(new ReasonError('A reason of 3–1000 characters is required.'))).toBeInstanceOf(UserFacingError);
    // Our own mistakes stay as errors, to be logged.
    expect(apiFailure(new ApiError(401, 'unauthorized', 'x'))).toBeInstanceOf(ApiError);
  });

  it('says plainly when the server is not configured', () => {
    expect(() => requireApi({ api: null })).toThrow(NOT_CONNECTED);
  });
});

describe('route images from server routes', () => {
  it('keeps only what the image depends on and passes the renderer schema', async () => {
    const { admin } = setup();
    const req = toRouteRenderRequest(await admin.route('7K2M9QXA'), { title: 'Job 7K2M-9QXA' });
    const parsed = routeRenderRequestSchema.parse(req);
    expect(parsed.game).toBe('ets2');
    expect(parsed.route.features.map((f) => [f.properties.segment, f.properties.scale_class, f.properties.counted, f.properties.status])).toEqual([
      ['driving', 'city', false, 'kept'],
      ['driving', 'road', true, 'kept'],
      ['train', 'unknown', false, 'kept'],
      // An unknown scale kind is drawn as "scale not reported".
      ['driving', 'unknown', true, 'kept'],
      ['driving', 'road', true, 'reverted'],
    ]);
    expect(JSON.stringify(req)).not.toContain('start_at');
  });
});

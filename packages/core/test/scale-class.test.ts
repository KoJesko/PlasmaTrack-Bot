import { describe, expect, it } from 'vitest';
import { normalizeScaleClass, SCALE_CLASS_LABELS, SCALE_CLASSES } from '../src/render/protocol.ts';

// Server 2026-11-25: a multiplayer session's own scale (Convoy holds one scale
// for the whole session; TrucklineMP holds ATS at 19) is its own class.
describe('scale classes', () => {
  it('knows the multiplayer scale and labels it', () => {
    expect(SCALE_CLASSES).toContain('multiplayer');
    expect(normalizeScaleClass('multiplayer')).toBe('multiplayer');
    expect(SCALE_CLASS_LABELS.multiplayer).toBe('Multiplayer scale');
  });

  it('still draws anything unrecognised as unknown', () => {
    expect(normalizeScaleClass('something_new')).toBe('unknown');
  });
});

describe('distance_by_scale_class from the server', () => {
  it('accepts a class this bot does not know yet', async () => {
    const { jobDetailSchema } = await import('../src/api/schemas.ts');
    const example = (await import('./fixtures/server-examples/public_job.json', { with: { type: 'json' } })).default as Record<string, unknown>;
    const zero = { world_km: 0, world_mi: 0, game_km: 0, game_mi: 0 };
    const job = { ...example, distance_by_scale_class: { ...(example.distance_by_scale_class as object), some_future_class: zero } };
    expect(jobDetailSchema.safeParse(job).success).toBe(true);
  });
});

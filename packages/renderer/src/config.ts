import { z } from 'zod';

// Renderer configuration comes from environment variables only, so it runs the
// same on any host (systemd unit, container, Windows service). See
// renderer.env.example. RENDERER_KEY is the only secret.

const flagList = z
  .string()
  .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean));

export const rendererConfigSchema = z.object({
  RENDERER_KEY: z.string().min(32, 'use at least 32 random characters'),
  RENDERER_HOST: z.string().default('127.0.0.1'),
  RENDERER_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  /** Basemap archives generated with truckermudgeon/maps (ets2.pmtiles / ats.pmtiles). */
  TILES_ETS2: z.string().optional(),
  TILES_ATS: z.string().optional(),
  /** Feature properties that hide a basemap feature when true. */
  STRIP_FLAGS: flagList.default(['hidden', 'secret']),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** Requests waiting beyond this many get 503 + Retry-After. */
  RENDER_QUEUE_LIMIT: z.coerce.number().int().min(0).max(1000).default(16),
});

export type RendererConfig = z.infer<typeof rendererConfigSchema>;

export function parseRendererConfig(env: Record<string, string | undefined>): RendererConfig {
  const result = rendererConfigSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.code === 'invalid_type' ? 'missing or wrong type' : i.message}`,
    );
    throw new Error(`Invalid renderer configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

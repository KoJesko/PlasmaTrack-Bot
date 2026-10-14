import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as WorkerEnv } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_SIGNING_PKCS8: string;
      PLASMATRACK_WEBHOOK_SECRET: string;
    }
  }
}

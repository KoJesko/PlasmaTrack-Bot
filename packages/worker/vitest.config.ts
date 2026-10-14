import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      // A fresh signing key per run: tests sign interactions like Discord does,
      // and no key material is ever committed.
      const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
      const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
      const privatePkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
      return {
        wrangler: { configPath: './wrangler.test.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SIGNING_PKCS8: privatePkcs8,
            DISCORD_PUBLIC_KEY: publicKey,
            DISCORD_BOT_TOKEN: 'test-bot-token-not-a-real-secret-0001',
            RENDERER_KEY: 'test-renderer-key-not-a-real-secret-000000',
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});

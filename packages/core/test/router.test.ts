import { InteractionResponseType, MessageFlags } from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlers } from '../src/commands/index.ts';
import { handleInteraction, NOT_ALLOWED, START_FAILED } from '../src/interactions/router.ts';
import type { InteractionHandlers, QueueMessage } from '../src/interactions/types.ts';
import type { WorkQueue } from '../src/ports.ts';
import {
  buttonInteraction,
  commandInteraction,
  GUILD_ID,
  INTERACTION_TOKEN,
  modalInteraction,
  MOD_ROLE,
  routerDeps,
  USER_A,
} from './helpers.ts';

// Test-only handlers covering every result kind and the moderator gate.
const testHandlers: InteractionHandlers = {
  commands: [
    ...handlers.commands,
    {
      access: 'moderator',
      json: { name: 'modtool', description: 'test' },
      handle: () => ({ kind: 'reply', ephemeral: true, message: { content: 'mod ok' } }),
    },
    {
      access: 'everyone',
      json: { name: 'boom', description: 'test' },
      handle: () => {
        throw new Error('handler bug');
      },
    },
    {
      access: 'moderator',
      json: { name: 'reason', description: 'test' },
      handle: () => ({
        kind: 'modal',
        modal: { custom_id: 'approve:job1', title: 'Reason', components: [] },
      }),
    },
  ],
  components: [
    {
      prefix: 'approve',
      access: 'moderator',
      handle: (_ctx, arg) => ({ kind: 'defer-update', task: { name: 'approve', input: { job: arg } } }),
    },
  ],
  modals: [
    {
      prefix: 'approve',
      access: 'moderator',
      handle: (_ctx, arg) => ({ kind: 'defer', ephemeral: true, task: { name: 'approve', input: { job: arg } } }),
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('handleInteraction', () => {
  it('answers PING with PONG', async () => {
    const { deps } = routerDeps();
    const r = await handleInteraction({ type: 1 } as never, deps);
    expect(r.response).toEqual({ type: InteractionResponseType.Pong });
  });

  it('/about replies immediately and ephemerally, and schedules the notice hint', async () => {
    const { deps, queue } = routerDeps();
    const r = await handleInteraction(commandInteraction('about'), deps);
    expect(r.response.type).toBe(InteractionResponseType.ChannelMessageWithSource);
    const data = (r.response as { data: { flags: number; allowed_mentions: unknown } }).data;
    expect(data.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(data.allowed_mentions).toEqual({ parse: [] });
    expect(r.background).toEqual([{ type: 'notice-hint', interaction: expect.objectContaining({ userId: USER_A }) }]);
    expect(queue.items).toHaveLength(0);
  });

  it('/notices defers ephemerally and enqueues its task with the interaction reference', async () => {
    const { deps, queue } = routerDeps();
    const r = await handleInteraction(commandInteraction('notices', { guild: false }), deps);
    expect(r.response).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    const [msg] = queue.take();
    expect(msg).toMatchObject({
      type: 'interaction-task',
      task: { name: 'notices.list' },
      interaction: { userId: USER_A, token: INTERACTION_TOKEN },
      noticeHint: true,
    });
  });

  describe("Discord's 3-second window", () => {
    it('every registered command produces its first response without waiting on I/O', async () => {
      // Handlers are synchronous; the only await is the enqueue. With an instant
      // queue, every command must answer in well under Discord's 3 s.
      for (const command of handlers.commands) {
        const { deps } = routerDeps();
        const started = performance.now();
        const r = await handleInteraction(commandInteraction(command.json.name, { roles: [MOD_ROLE] }), deps);
        expect(performance.now() - started).toBeLessThan(250);
        expect([
          InteractionResponseType.ChannelMessageWithSource,
          InteractionResponseType.DeferredChannelMessageWithSource,
          InteractionResponseType.Modal,
        ]).toContain(r.response.type);
      }
    });

    it('a stalled queue still gets an answer before the deadline', async () => {
      vi.useFakeTimers();
      const stalled: WorkQueue<QueueMessage> = { send: () => new Promise(() => {}), sendBatch: () => new Promise(() => {}) };
      const { deps } = routerDeps({ queue: stalled, enqueueTimeoutMs: 2000 });
      const pending = handleInteraction(commandInteraction('notices'), deps);
      await vi.advanceTimersByTimeAsync(2000);
      const r = await pending;
      expect(r.response.type).toBe(InteractionResponseType.ChannelMessageWithSource);
      expect((r.response as { data: { content: string } }).data.content).toBe(START_FAILED);
    });

    it('a failing queue is reported to the user ephemerally', async () => {
      const failing: WorkQueue<QueueMessage> = {
        send: () => Promise.reject(new Error('queue down')),
        sendBatch: () => Promise.reject(new Error('queue down')),
      };
      const { deps } = routerDeps({ queue: failing });
      const r = await handleInteraction(commandInteraction('notices'), deps);
      const data = (r.response as { data: { content: string; flags: number } }).data;
      expect(data.content).toBe(START_FAILED);
      expect(data.flags & MessageFlags.Ephemeral).toBeTruthy();
    });
  });

  describe('moderator access', () => {
    const cases: [string, Parameters<typeof commandInteraction>[1], boolean][] = [
      ['in the guild with a moderator role', { roles: [MOD_ROLE] }, true],
      ['in the guild without the role', { roles: ['999999999999999999'] }, false],
      ['in a DM (no member.roles)', { guild: false }, false],
    ];
    for (const [label, opts, allowed] of cases) {
      it(`${allowed ? 'allows' : 'refuses'} a moderator command ${label}`, async () => {
        const { deps } = routerDeps({ handlers: testHandlers });
        const r = await handleInteraction(commandInteraction('modtool', opts), deps);
        const content = (r.response as { data: { content: string } }).data.content;
        expect(content).toBe(allowed ? 'mod ok' : NOT_ALLOWED);
      });
    }

    it('refuses a moderator command from another guild even with a same-ID role', async () => {
      const { deps } = routerDeps({ handlers: testHandlers, guildIds: ['888888888888888888'] });
      const r = await handleInteraction(commandInteraction('modtool', { roles: [MOD_ROLE] }), deps);
      expect((r.response as { data: { content: string } }).data.content).toBe(NOT_ALLOWED);
    });

    it('allows moderator commands in any configured guild', async () => {
      const { deps } = routerDeps({ handlers: testHandlers, guildIds: ['888888888888888888', GUILD_ID] });
      const r = await handleInteraction(commandInteraction('modtool', { roles: [MOD_ROLE] }), deps);
      expect((r.response as { data: { content: string } }).data.content).toBe('mod ok');
    });

    it('also gates buttons and modal submissions', async () => {
      const { deps, queue } = routerDeps({ handlers: testHandlers });
      const denied = await handleInteraction(buttonInteraction('approve:job1'), deps);
      expect((denied.response as { data: { content: string } }).data.content).toBe(NOT_ALLOWED);
      const deniedModal = await handleInteraction(modalInteraction('approve:job1'), deps);
      expect((deniedModal.response as { data: { content: string } }).data.content).toBe(NOT_ALLOWED);
      expect(queue.items).toHaveLength(0);
    });
  });

  it('routes buttons (deferred update) and modals (deferred reply) by custom_id prefix', async () => {
    const { deps, queue } = routerDeps({ handlers: testHandlers });
    const b = await handleInteraction(buttonInteraction('approve:job1', { roles: [MOD_ROLE] }), deps);
    expect(b.response).toEqual({ type: InteractionResponseType.DeferredMessageUpdate });
    const m = await handleInteraction(modalInteraction('approve:job1', { roles: [MOD_ROLE] }), deps);
    expect(m.response.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    const items = queue.take();
    expect(items.map((i) => i.type === 'interaction-task' && i.task.input)).toEqual([{ job: 'job1' }, { job: 'job1' }]);
    // Only slash commands trigger the unread-notices hint.
    expect(items.every((i) => i.type === 'interaction-task' && !i.noticeHint)).toBe(true);
  });

  it('returns a modal as the first response', async () => {
    const { deps } = routerDeps({ handlers: testHandlers });
    const r = await handleInteraction(commandInteraction('reason', { roles: [MOD_ROLE] }), deps);
    expect(r.response.type).toBe(InteractionResponseType.Modal);
  });

  it('turns a throwing handler and unknown commands into ephemeral errors', async () => {
    const { deps } = routerDeps({ handlers: testHandlers });
    for (const name of ['boom', 'does-not-exist']) {
      const r = await handleInteraction(commandInteraction(name), deps);
      const data = (r.response as { data: { flags: number } }).data;
      expect(data.flags & MessageFlags.Ephemeral).toBeTruthy();
    }
  });
});

import { InteractionResponseType, MessageFlags } from 'discord-api-types/v10';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlers } from '../src/commands/index.ts';
import {
  handleInteraction,
  NOT_ALLOWED,
  NOT_HERE,
  NOT_MEMBER,
  RATE_LIMITED,
  START_FAILED,
  withReference,
} from '../src/interactions/router.ts';
import { MemoryRateLimiter } from '../src/memory.ts';
import type { InteractionHandlers, QueueMessage } from '../src/interactions/types.ts';
import type { RateLimiter, WorkQueue } from '../src/ports.ts';
import {
  buttonInteraction,
  commandInteraction,
  FakeClock,
  GUILD_ID,
  GUILDS,
  MEMBER_ROLE,
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
      access: 'member',
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
    const r = await handleInteraction(commandInteraction('notices'), deps);
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

    it('a slow queue still gets the deferred answer in time, and the task is enqueued after it', async () => {
      vi.useFakeTimers();
      let finish!: () => void;
      const sent: QueueMessage[] = [];
      const slow: WorkQueue<QueueMessage> = {
        send: (m) => new Promise<void>((ok) => (finish = () => (sent.push(m), ok()))),
        sendBatch: () => Promise.resolve(),
      };
      const reported: string[] = [];
      const { deps } = routerDeps({ queue: slow, enqueueTimeoutMs: 1000, reportStartFailure: async (_ref, kind) => void reported.push(kind) });
      const pending = handleInteraction(commandInteraction('leaderboard', { options: [{ name: 'game', type: 3, value: 'ets2' }] }), deps);
      await vi.advanceTimersByTimeAsync(1000);
      const r = await pending;
      expect(r.response.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
      expect(r.after).toBeDefined();
      finish();
      await r.after;
      expect(sent).toHaveLength(1);
      expect(reported).toEqual([]);
    });

    it('a slow send that then fails is retried once, then the user is told', async () => {
      vi.useFakeTimers();
      let attempts = 0;
      const rejects: WorkQueue<QueueMessage> = {
        send: () => (++attempts === 1 ? new Promise<void>((_, no) => setTimeout(() => no(new Error('queue down')), 1500)) : Promise.reject(new Error('queue down'))),
        sendBatch: () => Promise.resolve(),
      };
      const reported: string[] = [];
      const { deps } = routerDeps({ queue: rejects, enqueueTimeoutMs: 1000, reportStartFailure: async (_ref, kind) => void reported.push(kind) });
      const pending = handleInteraction(commandInteraction('notices'), deps);
      await vi.advanceTimersByTimeAsync(1000);
      const r = await pending;
      expect(r.response.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
      await vi.advanceTimersByTimeAsync(600);
      await r.after;
      expect(attempts).toBe(2);
      expect(reported).toEqual(['defer']);
    });

    it('a stalled queue still gets an answer before the deadline', async () => {
      vi.useFakeTimers();
      const stalled: WorkQueue<QueueMessage> = { send: () => new Promise(() => {}), sendBatch: () => new Promise(() => {}) };
      const { deps } = routerDeps({ queue: stalled });
      const pending = handleInteraction(commandInteraction('notices'), deps);
      await vi.advanceTimersByTimeAsync(1000);
      const r = await pending;
      expect(r.response.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    });

    it('a failing queue is reported to the user ephemerally', async () => {
      const failing: WorkQueue<QueueMessage> = {
        send: () => Promise.reject(new Error('queue down')),
        sendBatch: () => Promise.reject(new Error('queue down')),
      };
      const { deps } = routerDeps({ queue: failing });
      const r = await handleInteraction(commandInteraction('notices'), deps);
      const data = (r.response as { data: { content: string; flags: number } }).data;
      expect(data.content).toBe(withReference(START_FAILED, commandInteraction('notices').id));
      expect(data.flags & MessageFlags.Ephemeral).toBeTruthy();
    });
  });

  describe('rate limiting of slash commands', () => {
    const content = (r: { response: unknown }) => (r.response as { data?: { content?: string } }).data?.content;

    it('refuses the sixth command in 20 s, privately, without queueing it; any kind of command counts', async () => {
      const clock = new FakeClock();
      const { deps, queue } = routerDeps({ clock, limiter: new MemoryRateLimiter(5, 20_000, clock) });
      const names = ['notices', 'about', 'notices', 'about', 'notices'];
      for (const name of names) expect(content(await handleInteraction(commandInteraction(name, { roles: [MEMBER_ROLE] }), deps))).not.toBe(RATE_LIMITED);
      const r = await handleInteraction(commandInteraction('notices', { roles: [MEMBER_ROLE] }), deps);
      expect(content(r)).toBe(RATE_LIMITED);
      expect((r.response as { data: { flags: number } }).data.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(queue.take()).toHaveLength(3);
      // A new window starts after 20 s.
      clock.t += 20_000;
      expect((await handleInteraction(commandInteraction('notices', { roles: [MEMBER_ROLE] }), deps)).response.type).toBe(
        InteractionResponseType.DeferredChannelMessageWithSource,
      );
    });

    it('applies to moderators too, but not to buttons or forms', async () => {
      const { deps } = routerDeps({ handlers: testHandlers, limiter: new MemoryRateLimiter(0, 20_000) });
      expect(content(await handleInteraction(commandInteraction('notices', { roles: [MOD_ROLE] }), deps))).toBe(RATE_LIMITED);
      const button = await handleInteraction(buttonInteraction('approve:job1', { roles: [MOD_ROLE] }), deps);
      expect(button.response.type).toBe(InteractionResponseType.DeferredMessageUpdate);
    });

    it('lets users through when the limiter is down or slow', async () => {
      vi.useFakeTimers();
      const broken: RateLimiter = { allow: () => Promise.reject(new Error('binding down')) };
      const stalled: RateLimiter = { allow: () => new Promise(() => {}) };
      for (const limiter of [broken, stalled]) {
        const { deps } = routerDeps({ limiter, limiterTimeoutMs: 500 });
        const pending = handleInteraction(commandInteraction('notices', { roles: [MEMBER_ROLE] }), deps);
        await vi.advanceTimersByTimeAsync(500);
        expect((await pending).response.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
      }
    });
  });

  describe('moderator access', () => {
    const cases: [string, Parameters<typeof commandInteraction>[1], boolean | 'dm'][] = [
      ['in the guild with a moderator role', { roles: [MOD_ROLE] }, true],
      ['in the guild without the role', { roles: ['999999999999999999'] }, false],
      ['in a DM (no member.roles)', { guild: false }, 'dm'],
    ];
    for (const [label, opts, allowed] of cases) {
      it(`${allowed === true ? 'allows' : 'refuses'} a moderator command ${label}`, async () => {
        const { deps } = routerDeps({ handlers: testHandlers });
        const r = await handleInteraction(commandInteraction('modtool', opts), deps);
        const content = (r.response as { data: { content: string } }).data.content;
        expect(content).toBe(allowed === true ? 'mod ok' : allowed === 'dm' ? NOT_HERE : NOT_ALLOWED);
      });
    }

    it('refuses any command in a server that is not configured', async () => {
      const other = { '888888888888888888': GUILDS[GUILD_ID]! };
      const { deps } = routerDeps({ handlers: testHandlers, guilds: other });
      const r = await handleInteraction(commandInteraction('modtool', { roles: [MOD_ROLE] }), deps);
      expect((r.response as { data: { content: string } }).data.content).toBe(NOT_HERE);
    });

    it('uses each server’s own moderator roles', async () => {
      const guilds = {
        '888888888888888888': { ...GUILDS[GUILD_ID]!, moderator_roles: ['777777777777777777'] },
        [GUILD_ID]: GUILDS[GUILD_ID]!,
      };
      const { deps } = routerDeps({ handlers: testHandlers, guilds });
      const r = await handleInteraction(commandInteraction('modtool', { roles: [MOD_ROLE] }), deps);
      expect((r.response as { data: { content: string } }).data.content).toBe('mod ok');
      const elsewhere = await handleInteraction(commandInteraction('modtool', { roles: ['777777777777777777'] }), deps);
      expect((elsewhere.response as { data: { content: string } }).data.content).toBe(NOT_ALLOWED);
    });

    it('member commands need a member or moderator role; /about is open to all', async () => {
      const { deps } = routerDeps({ handlers: testHandlers });
      const content = async (opts: Parameters<typeof commandInteraction>[1], name = 'boom') =>
        ((await handleInteraction(commandInteraction(name, opts), deps)).response as { data: { content: string } }).data.content;
      expect(await content({ roles: [] })).toBe(NOT_MEMBER);
      expect(await content({ roles: [MEMBER_ROLE] })).toMatch(/^Something went wrong handling that\. \(Reference: \d+\)$/);
      expect(await content({ roles: [MOD_ROLE] })).toMatch(/^Something went wrong handling that\. \(Reference: \d+\)$/);
      expect(await content({ guild: false })).toBe(NOT_HERE);
      const about = await handleInteraction(commandInteraction('about', { guild: false }), deps);
      expect(about.response.type).toBe(InteractionResponseType.ChannelMessageWithSource);
      expect(JSON.stringify(about.response)).toContain('PlasmaTrack');
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

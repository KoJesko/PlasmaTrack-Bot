import { MessageFlags } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { tasks } from '../src/commands/index.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import {
  GENERIC_FAILURE,
  INTERACTION_TOKEN_TTL_MS,
  NOTICES_TASK,
  processQueueMessage,
} from '../src/interactions/tasks.ts';
import { RetryableError, UserFacingError, type QueueMessage, type TaskDefinition } from '../src/interactions/types.ts';
import type { Notice } from '../src/ports.ts';
import { APP_ID, BACKEND, GUILD_ID, INTERACTION_TOKEN, taskDeps, USER_A, USER_B } from './helpers.ts';

function message(taskName: string, now: number, noticeHint = true, userId = USER_A): QueueMessage {
  return {
    type: 'interaction-task',
    task: { name: taskName, input: null },
    interaction: { id: '1', applicationId: APP_ID, token: INTERACTION_TOKEN, userId, guildId: GUILD_ID, receivedAt: now },
    noticeHint,
  };
}

function notice(id: string, createdAt: number, text = `notice ${id}`): Notice {
  return { id, backend: BACKEND, kind: 'invalid_delivery', text, createdAt, expiresAt: createdAt + 86_400_000 };
}

describe('notices task', () => {
  it("shows only the invoking user's unread notices, ephemerally, then marks them read", async () => {
    const { deps, discord, notices, clock } = taskDeps();
    await notices.add(USER_A, notice('a1', clock.t - 2000, 'Job 12 was marked Invalid'));
    await notices.add(USER_A, notice('a2', clock.t - 1000, 'Speed penalty activated on job 13'));
    await notices.add(USER_B, notice('b1', clock.t - 500, 'SECRET-OF-USER-B'));

    const r = await processQueueMessage(message(NOTICES_TASK, clock.t), tasks, deps);
    expect(r).toEqual({ status: 'done' });
    const [edit] = discord.calls;
    const body = JSON.stringify(edit!.message);
    expect(edit!.op).toBe('edit');
    expect((edit!.message as { flags: number }).flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(body).toContain('Job 12 was marked Invalid');
    expect(body).toContain('Speed penalty activated');
    expect(body).not.toContain('SECRET-OF-USER-B');
    expect(await notices.countUnread(USER_A, BACKEND)).toBe(0);
    expect(await notices.countUnread(USER_B, BACKEND)).toBe(1);
    // No hint after /notices itself.
    expect(discord.calls).toHaveLength(1);
  });

  it('keeps notices unread if Discord rejects the message (they are retried)', async () => {
    const { deps, discord, notices, clock } = taskDeps();
    await notices.add(USER_A, notice('a1', clock.t - 1000));
    discord.failNext = new DiscordApiError(429, undefined, 3.2, 'rate limited');
    const r = await processQueueMessage(message(NOTICES_TASK, clock.t), tasks, deps);
    expect(r).toEqual({ status: 'retry', delaySeconds: 4 });
    expect(await notices.countUnread(USER_A, BACKEND)).toBe(1);
  });

  it('ignores expired notices', async () => {
    const { deps, discord, notices, clock } = taskDeps();
    await notices.add(USER_A, { ...notice('old', clock.t - 10), expiresAt: clock.t - 1 });
    await processQueueMessage(message(NOTICES_TASK, clock.t), tasks, deps);
    expect(JSON.stringify(discord.calls[0]!.message)).toContain('no unread notices');
    expect(await notices.purgeExpired()).toBe(1);
  });
});

describe('processQueueMessage', () => {
  const ok: TaskDefinition = { name: 'ok', run: async () => ({ message: { content: 'done' } }) };
  const flaky: TaskDefinition = {
    name: 'flaky',
    run: async () => {
      throw new RetryableError('server busy', 7);
    },
  };
  const userError: TaskDefinition = {
    name: 'user-error',
    run: async () => {
      throw new UserFacingError('Job not found.');
    },
  };
  const bug: TaskDefinition = {
    name: 'bug',
    run: async () => {
      throw new Error('internal detail that users must not see');
    },
  };
  const all = [ok, flaky, userError, bug];

  it('edits the deferred reply and sends the unread-notices hint when there are some', async () => {
    const { deps, discord, notices, clock } = taskDeps();
    await notices.add(USER_A, notice('a1', clock.t));
    await processQueueMessage(message('ok', clock.t), all, deps);
    expect(discord.calls.map((c) => c.op)).toEqual(['edit', 'followup']);
    const hint = discord.calls[1]!.message as { content: string; flags: number };
    expect(hint.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(hint.content).toContain('1 unread notice');
  });

  it('sends no hint when there are no notices or the hint is off', async () => {
    const { deps, discord, notices, clock } = taskDeps();
    await processQueueMessage(message('ok', clock.t), all, deps);
    await notices.add(USER_A, notice('a1', clock.t));
    await processQueueMessage(message('ok', clock.t, false), all, deps);
    expect(discord.calls.map((c) => c.op)).toEqual(['edit', 'edit']);
  });

  it('maps failures: retryable → retry, user-facing → shown, bugs → generic text', async () => {
    const { deps, discord, clock, lines } = taskDeps();
    expect(await processQueueMessage(message('flaky', clock.t), all, deps)).toEqual({ status: 'retry', delaySeconds: 7 });
    expect(discord.calls).toHaveLength(0);

    await processQueueMessage(message('user-error', clock.t), all, deps);
    expect((discord.calls[0]!.message as { content: string }).content).toBe('Job not found.');

    await processQueueMessage(message('bug', clock.t), all, deps);
    expect((discord.calls[1]!.message as { content: string }).content).toBe(GENERIC_FAILURE);
    expect(JSON.stringify(discord.calls)).not.toContain('internal detail');
    expect(lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('drops work whose interaction token has (nearly) expired', async () => {
    const { deps, discord, clock } = taskDeps();
    const r = await processQueueMessage(message('ok', clock.t - INTERACTION_TOKEN_TTL_MS + 10_000), all, deps);
    expect(r.status).toBe('dropped');
    expect(discord.calls).toHaveLength(0);
  });

  it('handles the standalone notice hint for immediate replies', async () => {
    const { deps, discord, notices, clock } = taskDeps();
    await notices.add(USER_A, notice('a1', clock.t));
    await notices.add(USER_A, notice('a2', clock.t));
    const hint: QueueMessage = {
      type: 'notice-hint',
      interaction: { id: '1', applicationId: APP_ID, token: INTERACTION_TOKEN, userId: USER_A, guildId: GUILD_ID, receivedAt: clock.t },
    };
    expect(await processQueueMessage(hint, all, deps)).toEqual({ status: 'done' });
    expect((discord.calls[0]!.message as { content: string }).content).toContain('2 unread notices');
  });
});

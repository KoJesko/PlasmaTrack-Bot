import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed } from 'discord-api-types/v10';
import { ApiError, idempotencyKey } from '../../api/client.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, MessageFlags } from '../../discord/constants.ts';
import { DiscordApiError, type OutgoingMessage } from '../../discord/rest.ts';
import { UserFacingError, type CommandDefinition, type ComponentDefinition, type TaskDefinition } from '../../interactions/types.ts';
import { checkTruckersMpAccounts, TRUCKERSMP_PROFILE } from '../../truckersmp/client.ts';
import { discordTime, distance, escapeMarkdown, GAME_NAMES } from '../format.ts';
import { booleanOption, stringOption, subcommand, userOption } from '../options.ts';
import { tokenMessage } from '../token.ts';
import { adminFor, modFailure, privateMessage, REASON_OPTION } from './common.ts';

// /player show | token issue | token revoke | division | access
//
// A moderator-issued token is never shown to the moderator (ADMIN_API §10):
// the bot stores a grant (who, by whom, why; no token) and sends the player a
// button. The click creates the token, with the issuing moderator as the
// actor, and shows it only to the player.

export const PLAYER_SHOW_TASK = 'mod.player.show';
export const PLAYER_WRITE_TASK = 'mod.player.write';
export const TOKEN_GRANT_TASK = 'mod.token.grant';
export const TOKEN_COLLECT_TASK = 'token.collect';
const GRANT_TTL_MS = 7 * 24 * 3600_000;

const userArg = (description: string) => ({ type: ApplicationCommandOptionType.User, name: 'user', description, required: true }) as const;

export const playerCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'player',
    description: 'Moderate a player (moderators; only you see the replies)',
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: 'show', description: 'Account, token and TruckersMP details', options: [userArg('Who')] },
      {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: 'token',
        description: 'Issue or revoke a player’s token',
        options: [
          { type: ApplicationCommandOptionType.Subcommand, name: 'issue', description: 'Send the player a button to collect a new token (you never see it)', options: [userArg('Who gets it'), REASON_OPTION] },
          { type: ApplicationCommandOptionType.Subcommand, name: 'revoke', description: 'Stop the player’s token from working', options: [userArg('Whose token'), REASON_OPTION] },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'division',
        description: 'Put a player in or out of the Singleplayer Division',
        options: [
          userArg('Who'),
          { type: ApplicationCommandOptionType.Boolean, name: 'singleplayer', description: 'In the Singleplayer Division?', required: true },
          REASON_OPTION,
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'access',
        description: 'Block or allow a player’s uploads (blocked players are hidden from leaderboards)',
        options: [
          userArg('Who'),
          { type: ApplicationCommandOptionType.Boolean, name: 'disabled', description: 'Block them?', required: true },
          REASON_OPTION,
        ],
      },
    ],
  },
  handle: ({ interaction }) => {
    const sub = subcommand(interaction);
    const target = userOption(interaction, 'user');
    if (!target) return { kind: 'reply', ephemeral: true, message: { content: 'Pick a user.' } };
    const reason = stringOption(interaction, 'reason') ?? '';
    switch (sub) {
      case 'show':
        return { kind: 'defer', ephemeral: true, task: { name: PLAYER_SHOW_TASK, input: { target } } };
      case 'token issue':
        return { kind: 'defer', ephemeral: true, task: { name: TOKEN_GRANT_TASK, input: { target, reason } } };
      case 'token revoke':
        return { kind: 'defer', ephemeral: true, task: { name: PLAYER_WRITE_TASK, input: { target, reason, change: { revoke: true } } } };
      case 'division':
        return {
          kind: 'defer',
          ephemeral: true,
          task: { name: PLAYER_WRITE_TASK, input: { target, reason, change: { singleplayer_division: booleanOption(interaction, 'singleplayer') ?? false } } },
        };
      case 'access':
        return {
          kind: 'defer',
          ephemeral: true,
          task: { name: PLAYER_WRITE_TASK, input: { target, reason, change: { disabled: booleanOption(interaction, 'disabled') ?? false } } },
        };
      default:
        return { kind: 'reply', ephemeral: true, message: { content: 'Unknown subcommand.' } };
    }
  },
};

export const playerShowTask: TaskDefinition = {
  name: PLAYER_SHOW_TASK,
  async run(input, { interaction, deps }) {
    const { target } = input as { target: string };
    const p = await adminFor(deps, interaction)
      .player(target)
      .catch((err: unknown) => {
        throw modFailure(err);
      });
    if (!p.linked) return { message: privateMessage({ content: `<@${target}> hasn’t linked PlasmaTrack.` }) };
    const checks = await checkTruckersMpAccounts(deps.truckersmp, target, p.truckersmp_accounts.map((a) => a.account_id), 10);
    const tmp = checks.map((c) => {
      const name = 'name' in c ? escapeMarkdown(c.name) : `Account ${c.accountId}`;
      const status = c.status === 'confirmed' ? '✓ confirmed by TruckersMP' : c.status === 'not-linked' ? 'reported only (TruckersMP shows no matching Discord)' : 'couldn’t check';
      return `[${name}](${TRUCKERSMP_PROFILE}${c.accountId}): ${status}`;
    });
    const token = p.token ? `made ${discordTime(p.token.created_at, 'f')}, last used ${p.token.last_used_at ? discordTime(p.token.last_used_at, 'R') : 'never'}` : 'none';
    const embed: APIEmbed = {
      title: escapeMarkdown(p.display_name),
      description: [`<@${target}>`, p.role ? `role: ${p.role}` : null, p.created_at ? `since ${discordTime(p.created_at, 'D')}` : null].filter(Boolean).join(' · '),
      fields: [
        { name: 'Status', value: [p.disabled ? '**Uploads blocked**' : 'Active', p.singleplayer_division ? 'Singleplayer Division' : null].filter(Boolean).join(' · '), inline: true },
        { name: 'Token', value: token, inline: true },
        ...(['ets2', 'ats'] as const).map((g) => ({
          name: GAME_NAMES[g],
          value: `**${p.stats[g].points}** points · ${p.stats[g].job_count} jobs · ${distance(p.stats[g].world_mi, p.stats[g].world_km)} · ${p.stats[g].pending_review_count} in review`,
        })),
        ...(tmp.length > 0 ? [{ name: 'TruckersMP accounts reported by the tracker', value: tmp.join('\n').slice(0, 1024) }] : []),
        ...(p.truckersmp_flags && p.truckersmp_flags.length > 0
          ? [{ name: 'TruckersMP flags', value: p.truckersmp_flags.map((f) => `\`${f.kind}\``).join(', ') }]
          : []),
      ],
    };
    return { message: privateMessage({ embeds: [embed] }) };
  },
};

interface WriteInput {
  target: string;
  reason: string;
  change: { revoke?: true; singleplayer_division?: boolean; disabled?: boolean };
}

export const playerWriteTask: TaskDefinition = {
  name: PLAYER_WRITE_TASK,
  async run(input, { interaction, deps }) {
    const { target, reason, change } = input as WriteInput;
    const admin = adminFor(deps, interaction);
    const meta = { reason, idempotencyKey: idempotencyKey(interaction.id, 'player.write') };
    try {
      if (change.revoke) {
        const res = await admin.revokeToken(target, meta);
        return { message: privateMessage({ content: res.revoked_token_id ? `Revoked <@${target}>’s token.` : `<@${target}> had no active token.` }) };
      }
      const { revoke: _, ...fields } = change;
      await admin.updatePlayer(target, fields, meta);
      const what =
        fields.singleplayer_division !== undefined
          ? fields.singleplayer_division
            ? 'is now in the Singleplayer Division (for jobs delivered from now on; a recalculation applies it to earlier jobs)'
            : 'is no longer in the Singleplayer Division'
          : fields.disabled
            ? 'can no longer upload, and is hidden from leaderboards'
            : 'can upload again';
      return { message: privateMessage({ content: `<@${target}> ${what}.` }) };
    } catch (err) {
      throw modFailure(err, `<@${target}> hasn’t linked PlasmaTrack.`);
    }
  },
};

// ---------------------------------------------------------------------------
// Moderator-issued tokens

export const tokenGrantTask: TaskDefinition = {
  name: TOKEN_GRANT_TASK,
  async run(input, { interaction, deps }) {
    const { target, reason } = input as { target: string; reason: string };
    if (!deps.backend) throw new UserFacingError('This only works in a PlasmaTrack server.');
    adminFor(deps, interaction); // fails early if the backend isn't connected
    const now = deps.clock.now();
    const grant = {
      id: crypto.randomUUID(),
      backend: deps.backend,
      discordUserId: target,
      moderatorId: interaction.userId,
      reason: reason.trim(),
      createdAt: now,
      expiresAt: now + GRANT_TTL_MS,
      usedAt: null,
    };
    await deps.grants.create(grant);
    try {
      await deps.discord.sendDirectMessage(target, grantMessage(grant.id, grant.expiresAt));
      return { message: privateMessage({ content: `Sent <@${target}> a button to collect their token. You won’t see the token. The button works for 7 days.` }) };
    } catch (err) {
      if (!(err instanceof DiscordApiError) || err.retryable) throw err;
      await deps.notices.add(target, {
        id: `${deps.backend}:grant:${grant.id}`,
        backend: deps.backend,
        kind: 'other',
        text: 'A moderator issued you a PlasmaTrack token. Collect it with the button below.',
        createdAt: now,
        expiresAt: grant.expiresAt,
      });
      return {
        message: privateMessage({
          content: `<@${target}>’s DMs are closed, so the button is waiting in their \`/notices\` in this server (for 7 days). Let them know.`,
        }),
      };
    }
  },
};

export function grantButton(grantId: string): APIActionRowComponent<APIComponentInMessageActionRow> {
  return {
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.Button, style: ButtonStyle.Primary, label: 'Get your token', custom_id: `tokg:${grantId}` }],
  };
}

function grantMessage(grantId: string, expiresAt: number): OutgoingMessage {
  return {
    content: `A PlasmaTrack moderator issued you a token for the desktop tracker. Click the button to see it; only you will. The button works until <t:${Math.floor(expiresAt / 1000)}:f>.`,
    components: [grantButton(grantId)],
  };
}

/** The player's button, in a DM or in /notices. Not role-gated: only the grant's player can use it. */
export const grantComponent: ComponentDefinition = {
  prefix: 'tokg',
  access: 'public',
  handle: (_ctx, arg) =>
    /^[0-9a-f-]{36}$/.test(arg)
      ? { kind: 'defer', ephemeral: true, task: { name: TOKEN_COLLECT_TASK, input: { grantId: arg } } }
      : { kind: 'reply', ephemeral: true, message: { content: 'That button is broken.' } },
};

export const tokenCollectTask: TaskDefinition = {
  name: TOKEN_COLLECT_TASK,
  async run(input, { interaction, deps }) {
    const { grantId } = input as { grantId: string };
    const grant = await deps.grants.get(grantId);
    const ephemeral = (content: string) => ({ message: { content, flags: MessageFlags.Ephemeral } });
    if (!grant || grant.discordUserId !== interaction.userId) return ephemeral('This button isn’t for you.');
    if (grant.usedAt !== null) return ephemeral('You already collected this token. Lost it? Run `/token new` for a new one.');
    if (grant.expiresAt <= deps.clock.now()) return ephemeral('This button has expired. Ask a moderator to issue a new token.');
    const api = deps.apiByName(grant.backend);
    if (!api) return ephemeral('The PlasmaTrack server isn’t connected right now. Try again later.');
    try {
      // The grant's ID as the key: a second click replays and never shows the token again.
      const issued = await api
        .admin(grant.moderatorId)
        .issueToken(interaction.userId, undefined, { reason: grant.reason, idempotencyKey: `grant:${grant.id}` });
      await deps.grants.markUsed(grant.id, deps.clock.now());
      return { message: { ...tokenMessage(issued), flags: MessageFlags.Ephemeral } };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'forbidden') {
        return ephemeral('The moderator who issued this can’t issue tokens any more. Ask a moderator to issue a new one.');
      }
      throw modFailure(err);
    }
  },
};

export const playerTasks = [playerShowTask, playerWriteTask, tokenGrantTask, tokenCollectTask];

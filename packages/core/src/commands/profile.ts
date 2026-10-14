import type { APIEmbed } from 'discord-api-types/v10';
import { apiFailure, requireApi } from '../api/errors.ts';
import type { GameStats } from '../api/schemas.ts';
import { ApplicationCommandOptionType, MessageFlags } from '../discord/constants.ts';
import type { CommandDefinition, TaskDefinition } from '../interactions/types.ts';
import { checkTruckersMpAccounts, TRUCKERSMP_PROFILE, type TruckersMpCheck } from '../truckersmp/client.ts';
import { distance, escapeMarkdown, GAME_NAMES } from './format.ts';
import { booleanOption, PRIVATE_OPTION, userOption } from './options.ts';

export const PROFILE_TASK = 'player.profile';

interface ProfileInput {
  target: string;
  private: boolean;
}

export const profileCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'profile',
    description: 'A player’s PlasmaTrack stats, per game',
    options: [
      { type: ApplicationCommandOptionType.User, name: 'user', description: 'Whose profile (default: yours)', required: false },
      PRIVATE_OPTION,
    ],
  },
  handle: ({ interaction, userId }) => {
    const priv = booleanOption(interaction, 'private') ?? false;
    const input: ProfileInput = { target: userOption(interaction, 'user') ?? userId, private: priv };
    return { kind: 'defer', ephemeral: priv, task: { name: PROFILE_TASK, input } };
  },
};

export const profileTask: TaskDefinition = {
  name: PROFILE_TASK,
  async run(input, { interaction, deps }) {
    const { target, private: priv } = input as ProfileInput;
    const api = requireApi(deps);
    const profile = await api.getPlayer(target).catch((err: unknown) => {
      throw apiFailure(err);
    });
    const flags = priv ? MessageFlags.Ephemeral : 0;
    const self = target === interaction.userId;
    if (!profile.linked) {
      const content = self ? 'You haven’t linked PlasmaTrack yet. Use `/token new` to start.' : `<@${target}> hasn’t linked PlasmaTrack.`;
      return { message: { content, flags } };
    }

    const embed: APIEmbed = {
      title: escapeMarkdown(profile.display_name),
      description: [
        `<@${target}>`,
        profile.singleplayer_division ? 'Singleplayer Division' : null,
        profile.disabled ? '**Account disabled**' : null,
      ]
        .filter(Boolean)
        .join(' · '),
      fields: [statsField('ets2', profile.stats.ets2), statsField('ats', profile.stats.ats)],
    };

    // TruckersMP accounts the tracker saw, checked against TruckersMP itself.
    const checks = await checkTruckersMpAccounts(
      deps.truckersmp,
      target,
      profile.truckersmp_accounts.map((a) => a.account_id),
    );
    const tmp = truckersMpField(checks, self && priv);
    if (tmp) embed.fields!.push(tmp);

    return { message: { embeds: [embed], flags } };
  },
};

function statsField(game: 'ets2' | 'ats', s: GameStats) {
  const lines = [
    `**${s.points}** points from ${s.job_count} job${s.job_count === 1 ? '' : 's'}`,
    `Driven (1:1): ${distance(s.world_mi, s.world_km)}`,
    `In game: ${distance(s.game_mi, s.game_km)}`,
  ];
  if (s.pending_review_count > 0) lines.push(`${s.pending_review_count} in review`);
  return { name: GAME_NAMES[game], value: lines.join('\n'), inline: true };
}

/**
 * Confirmed accounts are shown to everyone. Unconfirmed ones only to the player
 * themselves, privately, since nothing proves they are theirs.
 */
function truckersMpField(checks: TruckersMpCheck[], showUnconfirmed: boolean) {
  const lines: string[] = [];
  for (const c of checks) {
    const link = `${TRUCKERSMP_PROFILE}${c.accountId}`;
    if (c.status === 'confirmed') lines.push(`[${escapeMarkdown(c.name)}](${link}) ✓ linked to this Discord account on TruckersMP`);
    else if (showUnconfirmed && c.status === 'not-linked') {
      lines.push(`[${escapeMarkdown(c.name)}](${link}): its TruckersMP profile doesn’t show your Discord account. Link Discord on TruckersMP and make it public to confirm it.`);
    } else if (showUnconfirmed) lines.push(`Account ${c.accountId}: couldn’t check with TruckersMP right now.`);
  }
  return lines.length > 0 ? { name: 'TruckersMP', value: lines.join('\n').slice(0, 1024) } : null;
}

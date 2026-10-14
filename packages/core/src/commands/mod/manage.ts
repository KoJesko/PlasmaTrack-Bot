import type { APIApplicationCommandBasicOption, APIApplicationCommandSubcommandOption, APIEmbed } from 'discord-api-types/v10';
import { z } from 'zod';
import { idempotencyKey, type ReleaseInput } from '../../api/client.ts';
import { formatJobId, parseJobId } from '../../api/ids.ts';
import type { AuditEntry } from '../../api/schemas.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType } from '../../discord/constants.ts';
import { UserFacingError, type CommandDefinition, type ComponentDefinition, type TaskDefinition } from '../../interactions/types.ts';
import { checkTruckersMpAccounts, TRUCKERSMP_PROFILE } from '../../truckersmp/client.ts';
import { discordTime } from '../format.ts';
import { attachmentOption, booleanOption, stringOption, subcommand, userOption } from '../options.ts';
import { adminFor, brief, modFailure, privateMessage, REASON_OPTION } from './common.ts';

// /config, /release, /revocation, /admins, /audit and /tmpflags.

export const MANAGE_TASK = 'mod.manage';
const CONFIG_MAX = 256 * 1024;
const RELEASE_MAX = 1024 * 1024;
const CURSOR = /^[\x21-\x7e]{1,64}$/;
const ID = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9_]{1,60}$`);

type Op =
  | { op: 'config.list' }
  | { op: 'config.publish'; file: Upload; current: boolean; reason: string }
  | { op: 'config.current'; version: string; reason: string }
  | { op: 'release.list' }
  | { op: 'release.publish'; version: string; platform: 'windows' | 'linux'; file: Upload; reason: string }
  | { op: 'revocation.list'; status: string | null }
  | { op: 'revocation.schedule'; kind: 'release' | 'config_version'; id: string; reason: string }
  | { op: 'revocation.cancel'; id: string; reason: string }
  | { op: 'admins.list' }
  | { op: 'admins.add' | 'admins.remove'; user: string; reason: string }
  | { op: 'audit'; jobId: string | null; user: string | null; action: string | null; cursor: string | null }
  | { op: 'tmpflags'; cursor: string | null };

interface Upload {
  url: string;
  size: number;
  filename: string;
}

const defer = (input: Op) => ({ kind: 'defer' as const, ephemeral: true, task: { name: MANAGE_TASK, input } });
const reply = (content: string) => ({ kind: 'reply' as const, ephemeral: true, message: { content } });

const S = ApplicationCommandOptionType;
const sub = (name: string, description: string, options: APIApplicationCommandBasicOption[] = []): APIApplicationCommandSubcommandOption => ({
  type: S.Subcommand,
  name,
  description,
  options,
});

export const configCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'config',
    description: 'Published plasmatrack.toml versions (moderators)',
    options: [
      sub('list', 'Config versions, newest first'),
      sub('publish', 'Publish a plasmatrack.toml (max 256 KiB)', [
        { type: S.Attachment, name: 'file', description: 'The plasmatrack.toml file', required: true },
        { type: S.Boolean, name: 'current', description: 'Make it the current version?', required: true },
        REASON_OPTION,
      ]),
      sub('make-current', 'Make an older version current again', [
        { type: S.String, name: 'version', description: 'Version ID, like cfg_3', required: true, max_length: 64 },
        REASON_OPTION,
      ]),
    ],
  },
  handle: ({ interaction }) => {
    const reason = stringOption(interaction, 'reason') ?? '';
    switch (subcommand(interaction)) {
      case 'list':
        return defer({ op: 'config.list' });
      case 'publish': {
        const file = attachmentOption(interaction, 'file');
        if (!file) return reply('Attach the plasmatrack.toml file.');
        if (file.size > CONFIG_MAX) return reply('That file is over 256 KiB.');
        return defer({ op: 'config.publish', file, current: booleanOption(interaction, 'current') ?? false, reason });
      }
      default: {
        const version = stringOption(interaction, 'version')?.trim() ?? '';
        if (!ID('cfg').test(version)) return reply('Version IDs look like `cfg_3`.');
        return defer({ op: 'config.current', version, reason });
      }
    }
  },
};

export const releaseCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'release',
    description: 'Release manifests: the files of each tracker release (moderators)',
    options: [
      sub('list', 'Published releases'),
      sub('publish', 'Publish a release manifest (JSON, max 1 MiB)', [
        { type: S.String, name: 'version', description: 'Release version, like 0.1.0', required: true, max_length: 32 },
        {
          type: S.String,
          name: 'platform',
          description: 'Platform',
          required: true,
          choices: [
            { name: 'Windows', value: 'windows' },
            { name: 'Linux', value: 'linux' },
          ],
        },
        { type: S.Attachment, name: 'file', description: 'JSON: {"files": [{"role", "path_pattern", "sha256"}, …]}', required: true },
        REASON_OPTION,
      ]),
    ],
  },
  handle: ({ interaction }) => {
    if (subcommand(interaction) === 'list') return defer({ op: 'release.list' });
    const file = attachmentOption(interaction, 'file');
    const version = stringOption(interaction, 'version')?.trim() ?? '';
    const platform = stringOption(interaction, 'platform');
    if (!file) return reply('Attach the manifest JSON.');
    if (file.size > RELEASE_MAX) return reply('That file is over 1 MiB.');
    if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) return reply('Versions look like `0.1.0`.');
    if (platform !== 'windows' && platform !== 'linux') return reply('Pick a platform.');
    return defer({ op: 'release.publish', version, platform, file, reason: stringOption(interaction, 'reason') ?? '' });
  },
};

export const revocationCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'revocation',
    description: 'Stop accepting a release or config version, with 21 days’ notice (moderators)',
    options: [
      sub('list', 'Revocations', [
        {
          type: S.String,
          name: 'status',
          description: 'Default: all',
          required: false,
          choices: ['scheduled', 'effective', 'cancelled'].map((s) => ({ name: s, value: s })),
        },
      ]),
      sub('schedule', 'Announce one; players using it are DMed, and it takes effect after 21 days', [
        {
          type: S.String,
          name: 'kind',
          description: 'What to revoke',
          required: true,
          choices: [
            { name: 'Release', value: 'release' },
            { name: 'Config version', value: 'config_version' },
          ],
        },
        { type: S.String, name: 'id', description: 'rel_… or cfg_…', required: true, max_length: 64 },
        REASON_OPTION,
      ]),
      sub('cancel', 'Cancel one before it takes effect', [
        { type: S.String, name: 'id', description: 'Revocation ID, like rev_k2', required: true, max_length: 64 },
        REASON_OPTION,
      ]),
    ],
  },
  handle: ({ interaction }) => {
    const reason = stringOption(interaction, 'reason') ?? '';
    const id = stringOption(interaction, 'id')?.trim() ?? '';
    switch (subcommand(interaction)) {
      case 'list':
        return defer({ op: 'revocation.list', status: stringOption(interaction, 'status') ?? null });
      case 'schedule': {
        const kind = stringOption(interaction, 'kind') === 'config_version' ? 'config_version' : 'release';
        if (!ID(kind === 'release' ? 'rel' : 'cfg').test(id)) return reply(kind === 'release' ? 'Release IDs look like `rel_0_1_0`.' : 'Version IDs look like `cfg_3`.');
        return defer({ op: 'revocation.schedule', kind, id, reason });
      }
      default:
        if (!ID('rev').test(id)) return reply('Revocation IDs look like `rev_k2`.');
        return defer({ op: 'revocation.cancel', id, reason });
    }
  },
};

export const adminsCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'admins',
    description: 'Who the PlasmaTrack server accepts as a moderator (moderators)',
    options: [
      sub('list', 'Admins on the PlasmaTrack server'),
      sub('add', 'Make someone an admin', [{ type: S.User, name: 'user', description: 'Who', required: true }, REASON_OPTION]),
      sub('remove', 'Remove an admin', [{ type: S.User, name: 'user', description: 'Who', required: true }, REASON_OPTION]),
    ],
  },
  handle: ({ interaction }) => {
    const s = subcommand(interaction);
    if (s === 'list') return defer({ op: 'admins.list' });
    const user = userOption(interaction, 'user');
    if (!user) return reply('Pick a user.');
    return defer({ op: s === 'add' ? 'admins.add' : 'admins.remove', user, reason: stringOption(interaction, 'reason') ?? '' });
  },
};

export const auditCommand: CommandDefinition = {
  access: 'moderator',
  json: {
    name: 'audit',
    description: 'The audit log, newest first (moderators)',
    options: [
      { type: S.String, name: 'job', description: 'Only this job', required: false, max_length: 12 },
      { type: S.User, name: 'user', description: 'Only actions on this player', required: false },
      { type: S.String, name: 'action', description: 'Only this action, e.g. job.approve', required: false, max_length: 40 },
    ],
  },
  handle: ({ interaction }) => {
    const jobText = stringOption(interaction, 'job');
    const jobId = jobText ? parseJobId(jobText) : null;
    if (jobText && !jobId) return reply('That isn’t a job ID.');
    const action = stringOption(interaction, 'action')?.trim() ?? null;
    if (action && !/^[a-z_]+\.[a-z_]+$/.test(action)) return reply('Actions look like `job.approve`.');
    return defer({ op: 'audit', jobId, user: userOption(interaction, 'user') ?? null, action, cursor: null });
  },
};

export const tmpflagsCommand: CommandDefinition = {
  access: 'moderator',
  json: { name: 'tmpflags', description: 'TruckersMP accounts shared between players, or players with several (moderators)' },
  handle: () => defer({ op: 'tmpflags', cursor: null }),
};

// Paging buttons for /audit (state in the button) and /tmpflags.
export const manageComponents: ComponentDefinition[] = [
  {
    prefix: 'maud',
    access: 'moderator',
    handle: (_ctx, arg) => {
      const [job, user, action, ...rest] = arg.split(':');
      const cursor = rest.join(':');
      const ok = (job === '-' || !!parseJobId(job ?? '')) && (user === '-' || /^\d{17,20}$/.test(user ?? '')) && (action === '-' || /^[a-z_]+\.[a-z_]+$/.test(action ?? ''));
      if (!ok || (cursor !== '' && !CURSOR.test(cursor))) return { kind: 'update', message: { content: 'This list has expired. Run `/audit` again.', embeds: [], components: [] } };
      return {
        kind: 'defer-update',
        task: { name: MANAGE_TASK, input: { op: 'audit', jobId: job === '-' ? null : job!, user: user === '-' ? null : user!, action: action === '-' ? null : action!, cursor: cursor || null } satisfies Op },
      };
    },
  },
  {
    prefix: 'mtmp',
    access: 'moderator',
    handle: (_ctx, arg) =>
      arg === '' || CURSOR.test(arg)
        ? { kind: 'defer-update', task: { name: MANAGE_TASK, input: { op: 'tmpflags', cursor: arg || null } satisfies Op } }
        : { kind: 'update', message: { content: 'This list has expired. Run `/tmpflags` again.', embeds: [], components: [] } },
  },
];

const manifestSchema = z.object({
  files: z
    .array(
      z.object({
        role: z.enum(['plugin', 'client_binary', 'config_file']),
        path_pattern: z.string().min(1).max(260),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      }),
    )
    .min(1)
    .max(200),
});

/** Downloads a moderator's upload from Discord's CDN, with its size limit enforced again. */
async function download(file: Upload, max: number): Promise<string> {
  if (file.size > max) throw new UserFacingError('That file is too large.');
  if (!/^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(file.url)) throw new UserFacingError('That upload can’t be read.');
  const res = await fetch(file.url);
  if (!res.ok) throw new UserFacingError('Discord didn’t return the upload. Try attaching it again.');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw new UserFacingError('That file is too large.');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UserFacingError('That file isn’t UTF-8 text.');
  }
}

export const manageTask: TaskDefinition = {
  name: MANAGE_TASK,
  async run(input, { interaction, deps }) {
    const op = input as Op;
    const admin = adminFor(deps, interaction);
    const meta = (reason: string) => ({ reason, idempotencyKey: idempotencyKey(interaction.id, op.op) });
    const say = (content: string) => ({ message: privateMessage({ content: content.slice(0, 2000) }) });
    const list = (title: string, lines: string[], footer?: string) => ({
      message: privateMessage({ embeds: [{ title, description: (lines.join('\n') || 'None.').slice(0, 4000), ...(footer ? { footer: { text: footer } } : {}) }] }),
    });
    try {
      switch (op.op) {
        case 'config.list': {
          const page = await admin.listConfigVersions({ limit: 25 });
          return list('Config versions', page.items.map((v) => `\`${v.version_id}\`${v.current ? ' **current**' : ''} · hash \`${v.integrity_hash.slice(0, 12)}…\`${v.created_at ? ` · ${discordTime(v.created_at, 'f')}` : ''}`));
        }
        case 'config.publish': {
          const toml = await download(op.file, CONFIG_MAX);
          const v = await admin.publishConfigVersion(toml, op.current, meta(op.reason));
          return say(`Published \`${v.version_id}\`${v.current ? ' and made it current' : ''} (hash \`${v.integrity_hash.slice(0, 12)}…\`). The \`[local]\` table isn’t part of it.`);
        }
        case 'config.current': {
          const v = await admin.makeConfigVersionCurrent(op.version, meta(op.reason));
          return say(`\`${v.version_id}\` is now the current config version.`);
        }
        case 'release.list': {
          const page = await admin.listReleases({ limit: 25 });
          return list('Releases', page.items.map((r) => `\`${r.release_id ?? '?'}\` **${r.release_version}** · ${r.platform} · ${r.files?.length ?? '?'} files${r.created_at ? ` · ${discordTime(r.created_at, 'D')}` : ''}`));
        }
        case 'release.publish': {
          const text = await download(op.file, RELEASE_MAX);
          let parsed: z.infer<typeof manifestSchema>;
          try {
            parsed = manifestSchema.parse(JSON.parse(text));
          } catch {
            throw new UserFacingError('The manifest must be JSON like {"files": [{"role": "plugin", "path_pattern": "*/plasmatrack.dll", "sha256": "…64 hex…"}]}.');
          }
          const release: ReleaseInput = { release_version: op.version, platform: op.platform, files: parsed.files };
          const r = await admin.publishRelease(release, meta(op.reason));
          return say(`Published release **${r.release_version}** (${r.platform}) as \`${r.release_id ?? '?'}\` with ${parsed.files.length} files.`);
        }
        case 'revocation.list': {
          const page = await admin.listRevocations({ limit: 25, ...(op.status ? { status: op.status } : {}) });
          return list(
            'Revocations',
            page.items.map((r) => `\`${r.revocation_id}\` ${r.target ? `${r.target.kind} \`${r.target.id}\`` : ''} · ${r.status ?? '?'} · takes effect ${discordTime(r.effective_at, 'f')}`),
          );
        }
        case 'revocation.schedule': {
          const r = await admin.scheduleRevocation({ kind: op.kind, id: op.id }, meta(op.reason));
          return say(
            `Scheduled \`${r.revocation_id}\`: ${op.kind === 'release' ? 'release' : 'config version'} \`${op.id}\` stops counting ${discordTime(r.effective_at, 'F')}. ${r.recipients_count ?? 'Its'} players are DMed now.`,
          );
        }
        case 'revocation.cancel': {
          const r = await admin.cancelRevocation(op.id, meta(op.reason));
          return say(`Cancelled \`${r.revocation_id}\`. Players are told they don’t need to update.`);
        }
        case 'admins.list': {
          const page = await admin.listAdmins({ limit: 100 });
          return list('PlasmaTrack server admins', page.items.map((a) => `<@${a.discord_user_id}>${a.display_name ? ` (${a.display_name})` : ''}`));
        }
        case 'admins.add':
          await admin.addAdmin(op.user, meta(op.reason));
          return say(`<@${op.user}> is now an admin on the PlasmaTrack server. They still need a moderator role in Discord.`);
        case 'admins.remove':
          await admin.removeAdmin(op.user, meta(op.reason));
          return say(`<@${op.user}> is no longer an admin on the PlasmaTrack server.`);
        case 'audit': {
          const page = await admin.audit({
            limit: 15,
            cursor: op.cursor,
            ...(op.jobId ? { job_id: op.jobId } : {}),
            ...(op.user ? { target_user: op.user } : {}),
            ...(op.action ? { action: op.action } : {}),
          });
          const embed: APIEmbed = { title: 'Audit log', description: (page.items.map(auditLine).join('\n') || 'Nothing.').slice(0, 4000) };
          const base = `maud:${op.jobId ?? '-'}:${op.user ?? '-'}:${op.action ?? '-'}`;
          return { message: privateMessage({ embeds: [embed], components: pager(base, op.cursor, page.next_cursor) }) };
        }
        case 'tmpflags': {
          const page = await admin.truckersmpFlags({ limit: 10, cursor: op.cursor });
          const lines = await Promise.all(page.items.map((f) => flagLine(f, deps)));
          const embed: APIEmbed = {
            title: 'TruckersMP flags',
            description: (lines.join('\n') || 'No flags.').slice(0, 4000),
            footer: { text: 'IDs are reported by the tracker. ✓ = TruckersMP shows the same Discord account. Flags never change a job by themselves.' },
          };
          return { message: privateMessage({ embeds: [embed], components: pager('mtmp', op.cursor, page.next_cursor) }) };
        }
      }
    } catch (err) {
      throw modFailure(err, 'Not found.');
    }
  },
};

function auditLine(a: AuditEntry): string {
  const actor = typeof a.actor === 'string' ? a.actor : a.actor.discord_user_id ? `<@${a.actor.discord_user_id}>` : 'system';
  const target = a.target ? ` ${a.target.kind === 'job' ? formatJobId(a.target.id) : a.target.kind === 'user' ? `<@${a.target.id}>` : `\`${a.target.id}\``}` : '';
  return `${discordTime(a.at, 'f')} ${actor} \`${a.action}\`${target}${a.reason ? `: ${brief(a.reason, 120)}` : ''}`;
}

async function flagLine(flag: Record<string, unknown>, deps: Parameters<TaskDefinition['run']>[1]['deps']): Promise<string> {
  if (flag['kind'] === 'player_multiple_accounts' && typeof flag['discord_user_id'] === 'string' && Array.isArray(flag['account_ids'])) {
    const user = flag['discord_user_id'];
    const checks = await checkTruckersMpAccounts(deps.truckersmp, user, flag['account_ids'].filter((x): x is number => typeof x === 'number'), 10);
    return `<@${user}> uses ${checks.length} accounts: ${checks.map((c) => `[${c.accountId}](${TRUCKERSMP_PROFILE}${c.accountId})${c.status === 'confirmed' ? ' ✓' : ''}`).join(', ')}`;
  }
  if (flag['kind'] === 'account_multiple_players' && typeof flag['account_id'] === 'number' && Array.isArray(flag['users'])) {
    const account = flag['account_id'];
    const owner = await deps.truckersmp.player(account).catch(() => null);
    const users = (flag['users'] as { discord_user_id?: unknown }[]).map((u) => String(u.discord_user_id ?? '?'));
    return `[Account ${account}](${TRUCKERSMP_PROFILE}${account}) reported by ${users.map((u) => `<@${u}>${owner?.discordId === u ? ' ✓' : ''}`).join(', ')}`;
  }
  return `\`${String(flag['kind'])}\` ${brief(flag, 150)}`;
}

function pager(base: string, current: string | null, next: string | null, sep = ':') {
  const buttons = [];
  if (current) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: `${base}${sep}`, label: 'First page' });
  if (next && CURSOR.test(next) && `${base}${sep}${next}`.length <= 100) {
    buttons.push({ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: `${base}${sep}${next}`, label: 'Next' });
  }
  return buttons.length > 0 ? [{ type: ComponentType.ActionRow, components: buttons }] : [];
}

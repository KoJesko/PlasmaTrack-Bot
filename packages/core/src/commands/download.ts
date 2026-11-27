import type { APIActionRowComponent, APIApplicationCommandStringOption, APIButtonComponent, APIEmbed } from 'discord-api-types/v10';
import { ApiError, type ClientPlatform } from '../api/client.ts';
import { apiFailure, requireApi } from '../api/errors.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, MessageFlags } from '../discord/constants.ts';
import { UserFacingError, type CommandDefinition, type TaskDefinition } from '../interactions/types.ts';
import { discordTime, escapeMarkdown } from './format.ts';
import { booleanOption, PRIVATE_OPTION, stringOption } from './options.ts';

// Getting PlasmaTrack onto a PC, and off it again (owner, 2026-10-15; PUBLIC_API §7):
// - /download: only for the roles that may use the bot. The server hands out no public
//   setup link; each player gets a personal one that works for an hour, shown privately.
//   `platform: linux` gives the Linux package (ETS2/ATS under Proton), which has its own
//   install.sh and no self-update.
// - /uninstall: anyone may run it. The uninstaller link is public and never changes.

export const DOWNLOAD_TASK = 'client.download';
export const UNINSTALL_TASK = 'client.uninstall';

/** Windows warns about programs that aren't code-signed; say what to click. */
export const SMARTSCREEN =
  'Windows may say it protected your PC, because PlasmaTrack isn’t code-signed. Click **More info**, then **Run anyway**.';

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function linkButton(label: string, url: string): APIActionRowComponent<APIButtonComponent> {
  return { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label, url }] };
}

const PLATFORM_OPTION: APIApplicationCommandStringOption = {
  type: ApplicationCommandOptionType.String,
  name: 'platform',
  description: 'Your PC (default: Windows)',
  required: false,
  choices: [
    { name: 'Windows', value: 'windows' },
    { name: 'Linux', value: 'linux' },
  ],
};

interface DownloadInput {
  platform?: ClientPlatform;
}

export const downloadCommand: CommandDefinition = {
  access: 'member',
  json: { name: 'download', description: 'Get PlasmaTrack for Windows or Linux (a personal link, only you see it)', options: [PLATFORM_OPTION] },
  handle: ({ interaction }) => {
    const input: DownloadInput = { platform: stringOption(interaction, 'platform') === 'linux' ? 'linux' : 'windows' };
    return { kind: 'defer', ephemeral: true, task: { name: DOWNLOAD_TASK, input } };
  },
};

const NOT_PUBLISHED: Record<ClientPlatform, string> = {
  windows: 'No PlasmaTrack Setup has been published yet. Ask a moderator.',
  linux: 'No PlasmaTrack package for Linux has been published yet. Ask a moderator.',
};

const windowsSteps = [
  '**Installing**',
  '1. Close ETS2 and ATS.',
  `2. Run the setup. ${SMARTSCREEN}`,
  '3. Paste your token from `/token new` and click **Install**.',
  '',
  'After that PlasmaTrack updates itself. To remove it later, use **Settings → Apps → Installed apps**, or `/uninstall`.',
];

/** `server` is where the personal link points: the URL install.sh asks for. */
function linuxSteps(fileName: string, server: string): string[] {
  return [
    '**Installing** (ETS2/ATS run with Proton)',
    '1. Close ETS2 and ATS.',
    '2. In the folder you downloaded it to:',
    '```sh',
    `tar -xzf ${fileName}`,
    `cd ${fileName.replace(/\.tar\.gz$/, '')}`,
    `./install.sh --server-url ${server}`,
    '```',
    '3. Paste your token from `/token new` when it asks.',
    '',
    'Use the program in this download: one you build yourself isn’t recognised, and its jobs are discarded.',
    'There is no automatic update on Linux; run `/download platform:Linux` for a newer version. To remove it, see `/uninstall`.',
  ];
}

export const downloadTask: TaskDefinition = {
  name: DOWNLOAD_TASK,
  async run(input, { interaction, deps }) {
    // Tasks queued before the platform option have none.
    const platform = (input as DownloadInput).platform ?? 'windows';
    const api = requireApi(deps);
    const dl = await api.getClientDownload(interaction.userId, platform).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) throw new UserFacingError(NOT_PUBLISHED[platform]);
      throw apiFailure(err, { forbidden: 'Your PlasmaTrack account is blocked, so you can’t download the tracker. Ask a moderator.' });
    });
    const fileName = dl.file_name.replace(/`/g, '');
    const embed: APIEmbed = {
      title: `PlasmaTrack ${escapeMarkdown(dl.version)} for ${platform === 'linux' ? 'Linux' : 'Windows'}`,
      description: [
        `\`${fileName}\` · ${mb(dl.bytes)}`,
        `This link is just for you and expires ${discordTime(dl.expires_at, 'R')}. Run \`/download\` again for a new one; please don’t share it.`,
        '',
        ...(platform === 'linux' ? linuxSteps(fileName, new URL(dl.url).origin) : windowsSteps),
      ].join('\n'),
      ...(dl.notes ? { fields: [{ name: 'What’s new', value: escapeMarkdown(dl.notes).slice(0, 1024) }] } : {}),
    };
    return { message: { embeds: [embed], components: [linkButton(`Download (${mb(dl.bytes)})`, dl.url)], flags: MessageFlags.Ephemeral } };
  },
};

interface UninstallInput {
  private: boolean;
}

export const uninstallCommand: CommandDefinition = {
  access: 'public',
  json: { name: 'uninstall', description: 'How to remove PlasmaTrack from your PC (Windows or Linux)', options: [PRIVATE_OPTION] },
  handle: ({ interaction }) => {
    const priv = booleanOption(interaction, 'private') ?? false;
    const input: UninstallInput = { private: priv };
    return { kind: 'defer', ephemeral: priv, task: { name: UNINSTALL_TASK, input } };
  },
};

export const uninstallTask: TaskDefinition = {
  name: UNINSTALL_TASK,
  async run(input, { deps }) {
    const { private: priv } = input as UninstallInput;
    const api = requireApi(deps);
    const client = await api.getClient().catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw apiFailure(err);
    });
    const uninstaller = client?.uninstaller ?? null;
    const embed: APIEmbed = {
      title: 'Removing PlasmaTrack',
      description: [
        '**Windows**',
        '1. Close ETS2 and ATS.',
        '2. Either:',
        '   • **Settings → Apps → Installed apps → PlasmaTrack → Uninstall**, or **Uninstall PlasmaTrack** in the Start menu (PlasmaTrack 0.2.1 or newer); or',
        `   • ${uninstaller ? `download the uninstaller (${mb(uninstaller.bytes)}) and run it` : 'the uninstaller, once one is published'}. It works for every version. ${SMARTSCREEN}`,
        '',
        'It stops PlasmaTrack and removes the game plugin, the startup entry, the shortcuts and the program. It asks separately whether to delete your local data and token; jobs already uploaded stay on the server.',
        '',
        '**Linux**',
        'Close ETS2 and ATS, then run:',
        '```sh',
        '~/.local/share/plasmatrack/bin/uninstall.sh',
        '```',
        'It removes the service, the game plugin and the program. Add `--delete-data` to also delete your local data and token.',
      ].join('\n'),
    };
    return {
      message: {
        embeds: [embed],
        ...(uninstaller ? { components: [linkButton(`Download the uninstaller (${mb(uninstaller.bytes)})`, uninstaller.url)] } : {}),
        flags: priv ? MessageFlags.Ephemeral : 0,
      },
    };
  },
};

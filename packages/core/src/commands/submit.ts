import type { APIActionRowComponent, APIButtonComponent, APIChatInputApplicationCommandInteraction, APIEmbed, APIEmbedField } from 'discord-api-types/v10';
import { idempotencyKey, type ManualJobInput, type PlasmaTrackApi } from '../api/client.ts';
import { apiFailure, requireApi } from '../api/errors.ts';
import { formatJobId } from '../api/ids.ts';
import type { EvidenceItem, Game } from '../api/schemas.ts';
import { ApplicationCommandOptionType, ButtonStyle, ComponentType, MessageFlags } from '../discord/constants.ts';
import type { OutgoingFile } from '../discord/rest.ts';
import { UserFacingError, type CommandDefinition, type ComponentDefinition, type InteractionRef, type TaskDefinition, type TaskDeps, type TaskOutput } from '../interactions/types.ts';
import { stripImageMetadata } from '../image-metadata.ts';
import { MediaError, sniffImageType } from '../media.ts';
import type { ManualDraft } from '../ports.ts';
import { ImageRejectedError } from '../render/client.ts';
import { discordTime, escapeMarkdown, GAME_SHORT, isGame } from './format.ts';
import {
  citySectionTooShort,
  CITY_RULE,
  DATE_EXAMPLE,
  fuelUnitOption,
  IMAGE_TYPES,
  imageOption,
  isDistanceUnit,
  isFuelUnit,
  MAX_ADJUSTED_SECTIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_EVIDENCE_BYTES,
  money,
  numOption,
  parseUtcInstant,
  splitMods,
  textOption,
  typedDistance,
  typedFuel,
  unitOption,
} from './manual-fields.ts';
import { attachmentOption, GAME_OPTION, numberOption, stringOption, subcommand } from './options.ts';

// /submit: a job submitted by hand (PUBLIC_API §6, owner's design 2026-10-15).
//
// `/submit job` checks the typed values, then (from the queue) downloads the
// attached images, has the renderer shrink them to AVIF, uploads them to the
// server and keeps a draft. The player sees a private preview with Send and
// Cancel. Each `/submit adjusted-scale` adds one section at another map scale,
// up to 5 (Discord allows 25 options per command, and /submit job uses 24);
// the preview has a Remove button per section. Nothing reaches the server's
// job list until Send. Every reply is private.

export const SUBMIT_PREPARE_TASK = 'submit.prepare';
export const SUBMIT_ADJUSTED_TASK = 'submit.adjusted';
export const SUBMIT_REMOVE_SECTION_TASK = 'submit.remove-section';
export const SUBMIT_SEND_TASK = 'submit.send';
export const SUBMIT_CANCEL_TASK = 'submit.cancel';
export const JOB_EVIDENCE_TASK = 'job.evidence';

/** A draft lives for an hour; the server keeps unused images for 24 h. */
export const DRAFT_TTL_MS = 60 * 60_000;
/** Ended in the future (beyond clock drift) is refused. */
const FUTURE_SLACK_MS = 5 * 60_000;
/** Discord's limit for the files of one bot message is 10 MiB; stay under it. */
const PREVIEW_FILES_MAX_BYTES = 9 * 1024 * 1024;

export type ImageRole = 'main' | 'custom_map' | 'uk_route' | 'adjusted_scale';

export const IMAGE_LABELS: Record<string, string> = {
  main: 'Evidence',
  custom_map: 'Custom map',
  uk_route: 'UK route',
  adjusted_scale: 'Adjusted-scale evidence',
  other: 'Image',
};

interface AttachmentRef {
  role: ImageRole;
  url: string;
  size: number;
}

/** The typed fields; images are added once uploaded. */
type TypedJob = Omit<ManualJobInput, 'evidence' | 'custom_map' | 'uk' | 'adjusted_scales'> & {
  uk?: { distance: number; entry_city: string; end_city: string };
};

interface PrepareInput {
  job: TypedJob;
  attachments: AttachmentRef[];
}

interface AdjustedInput {
  section: { entry_city: string; exit_city: string; distance: number; scale: number };
  attachment: AttachmentRef;
}

// ---------------------------------------------------------------------------
// Command

const JOB_OPTIONS = [
  { ...GAME_OPTION, description: 'Which game' },
  unitOption(true),
  fuelUnitOption(true),
  textOption('start', 'City where you picked up the cargo', true),
  textOption('start_company', 'Company you picked up from', true),
  textOption('end', 'City you delivered to', true),
  textOption('end_company', 'Company you delivered to', true),
  textOption('cargo_name', 'Cargo, as the game names it', true),
  numOption('distance', 'Distance the game logged for the job (in your unit)', true, 0.01, 100_000),
  numOption('fuel_used', 'Fuel used (in your fuel unit)', true, 0, 100_000),
  numOption('damage', 'Cargo damage, percent (0–100)', true, 0, 100),
  numOption('profit', 'Profit the game showed (€ in ETS2, $ in ATS)', true, -1_000_000_000, 1_000_000_000),
  textOption('date_started', `When you started, UTC, like ${DATE_EXAMPLE}`, true, 40),
  textOption('date_ended', `When you delivered, UTC, like 2026-10-14T08:20:00Z`, true, 40),
  textOption('truck', 'Truck brand, e.g. Scania', true),
  textOption('truck_model', 'Truck model, e.g. S 730', true),
  imageOption('evidence', 'Screenshot proving the delivery (PNG, JPEG, WebP or AVIF)', true),
  numOption('map_scale', 'Map scale (default: ETS2 19, ATS 20)', false, 0.01, 1000),
  textOption('mod_names', 'Mods you used, separated by commas', false, 1000),
  imageOption('custom_map', 'Your route on a custom map (public unless a moderator hides it)', false),
  numOption('uk_distance', 'ETS2: distance driven in the UK (part of distance)', false, 0.01, 100_000),
  textOption('uk_entry_city', 'ETS2: city where you entered the UK', false),
  textOption('uk_end_city', 'ETS2: city where the UK stretch ended', false),
  imageOption('uk_route_evidence', 'ETS2: screenshot of the UK route (a GPS route screenshot counts)', false),
];

const ADJUSTED_OPTIONS = [
  textOption('entry_city', 'City where the section at another scale starts', true),
  textOption('exit_city', 'City where it ends', true),
  numOption('distance', 'Its distance, in the unit of your submission', true, 0.01, 100_000),
  numOption('scale', 'Its map scale, e.g. 1 for a 1:1 map', true, 0.01, 1000),
  imageOption('evidence', 'Screenshot proving that section (PNG, JPEG, WebP or AVIF)', true),
];

export const submitCommand: CommandDefinition = {
  access: 'member',
  json: {
    name: 'submit',
    description: 'Submit a job by hand, with evidence, for a moderator to check (only you see the replies)',
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: 'job', description: 'Start a submission: the job’s details and evidence', options: JOB_OPTIONS },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: 'adjusted-scale',
        description: 'Add a section driven at another map scale to your submission',
        options: ADJUSTED_OPTIONS,
      },
    ],
  },
  handle: ({ interaction }) => {
    const sub = subcommand(interaction);
    if (sub === 'job') {
      const { input, problems } = readJob(interaction);
      if (problems.length > 0 || !input) return problemsReply(problems);
      return { kind: 'defer', ephemeral: true, task: { name: SUBMIT_PREPARE_TASK, input } };
    }
    if (sub === 'adjusted-scale') {
      const problems: string[] = [];
      const attachment = image(interaction, 'evidence', 'adjusted_scale', problems);
      const section = {
        entry_city: stringOption(interaction, 'entry_city')?.trim() ?? '',
        exit_city: stringOption(interaction, 'exit_city')?.trim() ?? '',
        distance: numberOption(interaction, 'distance') ?? 0,
        scale: numberOption(interaction, 'scale') ?? 0,
      };
      if (!section.entry_city || !section.exit_city) problems.push('Give both cities.');
      if (!(section.distance > 0)) problems.push('`distance` must be more than 0.');
      if (!(section.scale > 0)) problems.push('`scale` must be more than 0.');
      // Under 3 is too short in either unit; the exact minimum is checked against the draft's unit.
      else if (citySectionTooShort(section.distance, section.scale, 'mi')) problems.push(CITY_RULE);
      if (problems.length > 0 || !attachment) return problemsReply(problems);
      const input: AdjustedInput = { section, attachment };
      return { kind: 'defer', ephemeral: true, task: { name: SUBMIT_ADJUSTED_TASK, input } };
    }
    return { kind: 'reply', ephemeral: true, message: { content: 'Unknown subcommand.' } };
  },
};

function problemsReply(problems: string[]) {
  return {
    kind: 'reply' as const,
    ephemeral: true,
    message: { content: `Please fix this and run the command again:\n${problems.map((p) => `• ${p}`).join('\n')}`.slice(0, 2000) },
  };
}

function image(i: APIChatInputApplicationCommandInteraction, option: string, role: ImageRole, problems: string[]): AttachmentRef | undefined {
  const a = attachmentOption(i, option);
  if (!a) return undefined;
  if (!a.contentType || !(IMAGE_TYPES as readonly string[]).includes(a.contentType)) {
    problems.push(`\`${option}\` must be a PNG, JPEG, WebP or AVIF image.`);
    return undefined;
  }
  if (a.size > MAX_ATTACHMENT_BYTES) {
    problems.push(`\`${option}\` is larger than 25 MB.`);
    return undefined;
  }
  return { role, url: a.url, size: a.size };
}

/** Everything that can be checked without I/O. */
export function readJob(i: APIChatInputApplicationCommandInteraction): { input: PrepareInput | null; problems: string[] } {
  const problems: string[] = [];
  const text = (name: string) => stringOption(i, name)?.trim() ?? '';
  const game = stringOption(i, 'game');
  const unit = stringOption(i, 'unit');
  const fuelUnit = stringOption(i, 'fuel_unit');
  if (!isGame(game)) problems.push('Pick ETS2 or ATS.');
  if (!isDistanceUnit(unit)) problems.push('Pick miles or kilometres for `unit`.');
  if (!isFuelUnit(fuelUnit)) problems.push('Pick a `fuel_unit`.');

  const startedAt = parseUtcInstant(text('date_started'));
  const endedAt = parseUtcInstant(text('date_ended'));
  if (!startedAt) problems.push(`\`date_started\` must be a UTC time like \`${DATE_EXAMPLE}\`.`);
  if (!endedAt) problems.push('`date_ended` must be a UTC time like `2026-10-14T08:20:00Z`.');
  if (startedAt && endedAt && Date.parse(endedAt) <= Date.parse(startedAt)) problems.push('`date_ended` must be after `date_started`.');

  const distance = numberOption(i, 'distance') ?? 0;
  const damage = numberOption(i, 'damage');
  const fuel = numberOption(i, 'fuel_used');
  const profit = numberOption(i, 'profit');
  if (!(distance > 0)) problems.push('`distance` must be more than 0.');
  if (damage === undefined || damage < 0 || damage > 100) problems.push('`damage` is a percentage from 0 to 100.');
  if (fuel === undefined || fuel < 0) problems.push('`fuel_used` can’t be negative.');
  if (profit === undefined) problems.push('Give the `profit`.');
  const mapScale = numberOption(i, 'map_scale');
  if (mapScale !== undefined && !(mapScale > 0)) problems.push('`map_scale` must be more than 0.');

  // UK section: ETS2 only, all four or none.
  const ukDistance = numberOption(i, 'uk_distance');
  const ukEntry = text('uk_entry_city');
  const ukEnd = text('uk_end_city');
  const ukImage = image(i, 'uk_route_evidence', 'uk_route', problems);
  const ukGiven = [ukDistance !== undefined, ukEntry !== '', ukEnd !== '', attachmentOption(i, 'uk_route_evidence') !== undefined];
  let uk: TypedJob['uk'];
  if (ukGiven.some(Boolean)) {
    if (game !== 'ets2') problems.push('The UK fields are for ETS2 only.');
    else if (!ukGiven.every(Boolean)) problems.push('For the UK stretch, give all four: `uk_distance`, `uk_entry_city`, `uk_end_city` and `uk_route_evidence`.');
    else if (ukDistance! > distance) problems.push('`uk_distance` is part of `distance`, so it can’t be larger.');
    else uk = { distance: ukDistance!, entry_city: ukEntry, end_city: ukEnd };
  }

  const main = image(i, 'evidence', 'main', problems);
  const customMap = image(i, 'custom_map', 'custom_map', problems);
  if (!attachmentOption(i, 'evidence')) problems.push('Attach your `evidence` screenshot.');

  const mods = splitMods(stringOption(i, 'mod_names') ?? '');
  if (problems.length > 0 || !isGame(game) || !isDistanceUnit(unit) || !isFuelUnit(fuelUnit) || !main) return { input: null, problems };

  const job: TypedJob = {
    game,
    unit,
    fuel_unit: fuelUnit,
    start_city: text('start'),
    start_company: text('start_company'),
    end_city: text('end'),
    end_company: text('end_company'),
    cargo_name: text('cargo_name'),
    distance,
    fuel_used: fuel!,
    damage: damage!,
    profit: profit!,
    started_at: startedAt!,
    ended_at: endedAt!,
    truck: text('truck'),
    truck_model: text('truck_model'),
    ...(mods.length > 0 ? { mod_names: mods } : {}),
    ...(mapScale !== undefined ? { map_scale: mapScale } : {}),
    ...(uk ? { uk } : {}),
  };
  const attachments = [main, customMap, uk ? ukImage : undefined].filter((a): a is AttachmentRef => !!a);
  return { input: { job, attachments }, problems };
}

// ---------------------------------------------------------------------------
// Tasks

export const submitPrepareTask: TaskDefinition = {
  name: SUBMIT_PREPARE_TASK,
  async run(input, { interaction, deps }) {
    const { job, attachments } = input as PrepareInput;
    const api = requireApi(deps);
    const backend = deps.backend!;
    if (Date.parse(job.ended_at) > deps.clock.now() + FUTURE_SLACK_MS) throw new UserFacingError('`date_ended` is in the future. Times are in UTC.');

    const uploaded: Uploaded[] = [];
    for (const a of attachments) uploaded.push(await uploadImage(a, api, interaction, deps));
    const id = (role: ImageRole) => uploaded.find((u) => u.role === role)?.evidenceId;

    const { uk, ...rest } = job;
    const full: ManualJobInput = {
      ...rest,
      evidence: [id('main')!],
      ...(id('custom_map') ? { custom_map: id('custom_map')! } : {}),
      ...(uk ? { uk: { ...uk, route_evidence: id('uk_route')! } } : {}),
    };
    const now = deps.clock.now();
    const draft: ManualDraft = { id: crypto.randomUUID(), backend, userId: interaction.userId, rev: 1, job: full, createdAt: now, expiresAt: now + DRAFT_TTL_MS };
    await deps.drafts.put(draft);
    return preview(
      draft,
      uploaded,
      `Check everything, then press **Send**. Drove parts of the trip at another map scale? Add each one first with \`/submit adjusted-scale\` (up to ${MAX_ADJUSTED_SECTIONS}).`,
    );
  },
};

export const submitAdjustedTask: TaskDefinition = {
  name: SUBMIT_ADJUSTED_TASK,
  async run(input, { interaction, deps }) {
    const { section, attachment } = input as AdjustedInput;
    const api = requireApi(deps);
    const draft = normalizeDraft(await deps.drafts.get(deps.backend!, interaction.userId));
    if (!draft) throw new UserFacingError('You have no submission in progress. Start with `/submit job`, then add the adjusted-scale section.');
    const sections = draft.job.adjusted_scales ?? [];
    if (sections.length >= MAX_ADJUSTED_SECTIONS) {
      throw new UserFacingError(`A submission can have at most ${MAX_ADJUSTED_SECTIONS} adjusted-scale sections. Remove one in the preview first.`);
    }
    if (citySectionTooShort(section.distance, section.scale, draft.job.unit)) throw new UserFacingError(CITY_RULE);
    const parts = section.distance + sections.reduce((sum, s) => sum + s.distance, 0) + (draft.job.uk?.distance ?? 0);
    if (parts > draft.job.distance) {
      throw new UserFacingError(
        `The adjusted-scale sections${draft.job.uk ? ' and the UK stretch' : ''} are part of the job’s ${typedDistance(draft.job.distance, draft.job.unit)}, so together they can’t be longer (with this one: ${typedDistance(parts, draft.job.unit)}).`,
      );
    }
    const up = await uploadImage(attachment, api, interaction, deps);
    draft.job.adjusted_scales = [...sections, { ...section, evidence: up.evidenceId }];
    draft.rev++;
    draft.expiresAt = deps.clock.now() + DRAFT_TTL_MS;
    await deps.drafts.put(draft);
    const n = draft.job.adjusted_scales.length;
    return preview(
      draft,
      [up],
      `Added adjusted-scale section ${n} of up to ${MAX_ADJUSTED_SECTIONS}. The images from before are still part of your submission. Press **Send** when everything is right.`,
    );
  },
};

interface RemoveSectionInput {
  id: string;
  rev: number;
  /** From 0. */
  index: number;
}

export const submitRemoveSectionTask: TaskDefinition = {
  name: SUBMIT_REMOVE_SECTION_TASK,
  async run(input, { interaction, deps }) {
    const { id, rev, index } = input as RemoveSectionInput;
    const draft = normalizeDraft(await deps.drafts.get(deps.backend!, interaction.userId));
    if (!draft || draft.id !== id) {
      return { message: { content: 'This submission was already sent, cancelled or has expired. Start again with `/submit job`.', components: [], embeds: [] } };
    }
    if (draft.rev !== rev) return { message: { content: 'This preview is out of date: the submission changed since. Use the newest preview.', components: [] } };
    const sections = draft.job.adjusted_scales ?? [];
    if (index < 0 || index >= sections.length) return { message: { content: 'That section is already gone. Use the newest preview.', components: [] } };
    // Its image stays uploaded but unused; the server deletes it after 24 hours.
    sections.splice(index, 1);
    if (sections.length > 0) draft.job.adjusted_scales = sections;
    else delete draft.job.adjusted_scales;
    draft.rev++;
    draft.expiresAt = deps.clock.now() + DRAFT_TTL_MS;
    await deps.drafts.put(draft);
    return preview(draft, [], `Removed adjusted-scale section ${index + 1}; the ones after it moved up. Your images are still part of the submission.`);
  },
};

/** Drafts saved before sections became a list (an hour at most) hold one `adjusted_scale`. */
function normalizeDraft(draft: ManualDraft | null): ManualDraft | null {
  if (!draft) return null;
  const legacy = (draft.job as { adjusted_scale?: NonNullable<ManualJobInput['adjusted_scales']>[number] }).adjusted_scale;
  if (legacy) {
    draft.job.adjusted_scales = [...(draft.job.adjusted_scales ?? []), legacy];
    delete (draft.job as { adjusted_scale?: unknown }).adjusted_scale;
  }
  return draft;
}

interface SendInput {
  id: string;
  rev: number;
}

export const submitSendTask: TaskDefinition = {
  name: SUBMIT_SEND_TASK,
  async run(input, { interaction, deps }) {
    const { id, rev } = input as SendInput;
    const api = requireApi(deps);
    const draft = normalizeDraft(await deps.drafts.get(deps.backend!, interaction.userId));
    if (!draft || draft.id !== id) {
      return { message: { content: 'This submission was already sent, cancelled or has expired. Start again with `/submit job`.', components: [] } };
    }
    if (draft.rev !== rev) {
      return { message: { content: 'This preview is out of date: you added to the submission since. Use the newest preview.', components: [] } };
    }
    if (Date.parse(draft.job.ended_at) > deps.clock.now() + FUTURE_SLACK_MS) throw new UserFacingError('`date_ended` is in the future. Times are in UTC.');
    // Keyed on the draft, not the click: pressing Send twice submits once.
    const job = await api.submitManualJob(interaction.userId, draft.job, `manual:${draft.id}:${draft.rev}`).catch((err: unknown) => {
      throw apiFailure(err, { forbidden: 'Your PlasmaTrack account is blocked, so you can’t submit jobs. Ask a moderator.' });
    });
    await deps.drafts.delete(draft.backend, draft.userId, draft.id);
    const held = job.held_points !== null && job.held_points !== undefined ? ` It holds **${job.held_points}** points until a moderator approves it.` : '';
    return {
      message: {
        content: `Sent! Job **${formatJobId(job.job_id)}** is waiting for a moderator.${held} See it with \`/job id:${formatJobId(job.job_id)}\`.`,
        components: [],
      },
    };
  },
};

export const submitCancelTask: TaskDefinition = {
  name: SUBMIT_CANCEL_TASK,
  async run(input, { interaction, deps }) {
    const { id } = input as { id: string };
    const deleted = await deps.drafts.delete(deps.backend ?? '', interaction.userId, id);
    return { message: { content: deleted ? 'Cancelled. Nothing was submitted.' : 'This submission was already sent, cancelled or has expired.', components: [] } };
  },
};

// custom_id: "msub:send:{draft id}:{rev}", "msub:cancel:{draft id}" or
// "msub:rm:{draft id}:{rev}:{section index from 0}"
export const submitComponent: ComponentDefinition = {
  prefix: 'msub',
  access: 'member',
  handle: (_ctx, arg) => {
    const [action, id, rev, index] = arg.split(':');
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return { kind: 'update', message: { content: 'This preview has expired. Start again with `/submit job`.', components: [] } };
    if (action === 'send' && rev && /^\d{1,4}$/.test(rev)) return { kind: 'defer-update', task: { name: SUBMIT_SEND_TASK, input: { id, rev: Number(rev) } satisfies SendInput } };
    if (action === 'rm' && rev && /^\d{1,4}$/.test(rev) && index && /^\d$/.test(index)) {
      return { kind: 'defer-update', task: { name: SUBMIT_REMOVE_SECTION_TASK, input: { id, rev: Number(rev), index: Number(index) } satisfies RemoveSectionInput } };
    }
    if (action === 'cancel') return { kind: 'defer-update', task: { name: SUBMIT_CANCEL_TASK, input: { id } } };
    return { kind: 'update', message: { content: 'This preview has expired. Start again with `/submit job`.', components: [] } };
  },
};

// ---------------------------------------------------------------------------
// The submitter's own evidence (the "Evidence" button under a manual /job)

export function evidenceButton(jobId: string): APIActionRowComponent<APIButtonComponent> {
  return {
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Evidence (submitter only)', custom_id: `mev:${jobId}` }],
  };
}

export const evidenceComponent: ComponentDefinition = {
  prefix: 'mev',
  access: 'member',
  handle: (_ctx, arg) => {
    if (!/^[0-9A-Z]{8}$/.test(arg)) return { kind: 'reply', ephemeral: true, message: { content: 'This button has expired.' } };
    return { kind: 'defer', ephemeral: true, task: { name: JOB_EVIDENCE_TASK, input: { jobId: arg } } };
  },
};

export const jobEvidenceTask: TaskDefinition = {
  name: JOB_EVIDENCE_TASK,
  async run(input, { interaction, deps }) {
    const { jobId } = input as { jobId: string };
    const api = requireApi(deps);
    const evidence = await api.getOwnJobEvidence(interaction.userId, jobId).catch((err: unknown) => {
      throw apiFailure(err, { notFound: 'Only the player who submitted this job can see its evidence here. Moderators see it in `/review job`.' });
    });
    const shown = await evidenceImages(evidence.items, deps);
    return {
      message: {
        content: `Evidence for job ${formatJobId(jobId)} (only you can see this).${shown.missing > 0 ? ` ${shown.missing} image(s) couldn’t be loaded.` : ''}`,
        embeds: shown.embeds,
        flags: MessageFlags.Ephemeral,
      },
      files: shown.files,
    };
  },
};

/**
 * A section's image is numbered as submitted. After a moderator removes a section the
 * sheet renumbers, but the images keep their submitted numbers, so say "as submitted".
 */
function imageLabel(item: Pick<EvidenceItem, 'role' | 'section'>): string {
  const base = IMAGE_LABELS[item.role] ?? IMAGE_LABELS['other']!;
  return item.role === 'adjusted_scale' && typeof item.section === 'number' ? `${base}, section ${item.section + 1} as submitted` : base;
}

/**
 * Downloads the server's signed image links (valid for an hour, so fetched
 * now) and lays them out as embeds. Shared with the moderator job view.
 */
export async function evidenceImages(
  items: readonly EvidenceItem[],
  deps: Pick<TaskDeps, 'media' | 'logger'>,
  maxEmbeds = 10,
): Promise<{ embeds: APIEmbed[]; files: OutgoingFile[]; missing: number }> {
  const embeds: APIEmbed[] = [];
  const files: OutgoingFile[] = [];
  let missing = 0;
  let total = 0;
  for (const [n, item] of items.entries()) {
    if (embeds.length >= maxEmbeds) {
      missing++;
      continue;
    }
    try {
      const got = await deps.media.get(item.url, MAX_EVIDENCE_BYTES);
      const type = sniffImageType(got.bytes);
      if (!type || total + got.bytes.length > PREVIEW_FILES_MAX_BYTES) {
        missing++;
        continue;
      }
      total += got.bytes.length;
      const name = `${item.role}-${n + 1}.${type.split('/')[1]}`;
      const label = imageLabel(item);
      files.push({ name, bytes: got.bytes, contentType: type, description: label });
      embeds.push({ title: label, image: { url: `attachment://${name}` } });
    } catch (err) {
      deps.logger.warn('evidence image unavailable', { err, evidenceId: item.evidence_id });
      missing++;
    }
  }
  return { embeds, files, missing };
}

// ---------------------------------------------------------------------------
// Images

interface Uploaded {
  role: ImageRole;
  evidenceId: string;
  file: OutgoingFile;
}

/**
 * Downloads one attachment, shrinks it to AVIF with the renderer and uploads
 * it. If the renderer can't be reached, an image already within the server's
 * 5 MB is uploaded as it is, so submissions don't depend on the renderer.
 */
async function uploadImage(a: AttachmentRef, api: PlasmaTrackApi, interaction: InteractionRef, deps: TaskDeps): Promise<Uploaded> {
  const label = IMAGE_LABELS[a.role]!.toLowerCase();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = (await deps.media.get(a.url, MAX_ATTACHMENT_BYTES)).bytes;
  } catch (err) {
    if (err instanceof MediaError) throw new UserFacingError(`The ${label} image couldn’t be downloaded from Discord. Attach it again and retry.`);
    throw err;
  }
  const type = sniffImageType(bytes);
  if (!type) throw new UserFacingError(`The ${label} file isn’t a PNG, JPEG, WebP or AVIF image.`);

  let out: { bytes: Uint8Array<ArrayBuffer>; contentType: string } = { bytes, contentType: type };
  try {
    out = await deps.images.compressImage(bytes, type);
  } catch (err) {
    if (err instanceof ImageRejectedError) throw new UserFacingError(`The ${label} image couldn’t be read. Try saving it as PNG or JPEG.`);
    deps.logger.warn('image compression unavailable; uploading the original without its metadata', { err, role: a.role });
    if (bytes.length > MAX_EVIDENCE_BYTES) {
      throw new UserFacingError(`The ${label} image is larger than 5 MB and can’t be shrunk right now. Try a smaller image, or try again later.`);
    }
    // Never upload location data: drop EXIF and similar blocks, pixels unchanged.
    const stripped = stripImageMetadata(bytes);
    if (!stripped) throw new UserFacingError(`The ${label} image couldn’t be read. Try saving it as PNG or JPEG.`);
    out = { bytes: stripped, contentType: type };
  }
  if (out.bytes.length > MAX_EVIDENCE_BYTES) throw new UserFacingError(`The ${label} image is still larger than 5 MB after shrinking. Try a smaller one.`);

  const up = await api.uploadEvidence(interaction.userId, out.bytes, out.contentType, idempotencyKey(interaction.id, `evidence:${a.role}`)).catch((err: unknown) => {
    throw apiFailure(err, { forbidden: 'Your PlasmaTrack account is blocked, so you can’t submit jobs. Ask a moderator.' });
  });
  const ext = out.contentType.split('/')[1] ?? 'img';
  return { role: a.role, evidenceId: up.evidence_id, file: { name: `${a.role}.${ext}`, bytes: out.bytes, contentType: out.contentType, description: IMAGE_LABELS[a.role] } };
}

// ---------------------------------------------------------------------------
// Preview

function preview(draft: ManualDraft, images: Uploaded[], note: string): TaskOutput {
  const files: OutgoingFile[] = [];
  const embeds: APIEmbed[] = [summaryEmbed(draft.job)];
  let total = 0;
  let skipped = 0;
  for (const img of images) {
    if (total + img.file.bytes.length > PREVIEW_FILES_MAX_BYTES) {
      skipped++;
      continue;
    }
    total += img.file.bytes.length;
    files.push(img.file);
    embeds.push({ title: IMAGE_LABELS[img.role], image: { url: `attachment://${img.file.name}` } });
  }
  const buttons: APIButtonComponent[] = [
    { type: ComponentType.Button, style: ButtonStyle.Success, label: 'Send', custom_id: `msub:send:${draft.id}:${draft.rev}` },
    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Cancel', custom_id: `msub:cancel:${draft.id}` },
  ];
  const removeButtons: APIButtonComponent[] = (draft.job.adjusted_scales ?? []).map((_, n) => ({
    type: ComponentType.Button,
    style: ButtonStyle.Danger,
    label: `Remove section ${n + 1}`,
    custom_id: `msub:rm:${draft.id}:${draft.rev}:${n}`,
  }));
  return {
    message: {
      content: `${note}${skipped > 0 ? `\n(${skipped} image(s) are too large to show here, but were uploaded.)` : ''}\nThis preview expires ${discordTime(new Date(draft.expiresAt).toISOString(), 'R')}.`,
      embeds,
      components: [
        { type: ComponentType.ActionRow, components: buttons },
        ...(removeButtons.length > 0 ? [{ type: ComponentType.ActionRow, components: removeButtons }] : []),
      ],
      flags: MessageFlags.Ephemeral,
    },
    files,
  };
}

export function summaryEmbed(job: ManualJobInput): APIEmbed {
  const e = escapeMarkdown;
  const game = job.game as Game;
  const fields: APIEmbedField[] = [
    { name: 'Distance (game)', value: typedDistance(job.distance, job.unit), inline: true },
    { name: 'Map scale', value: job.map_scale !== undefined ? `1:${job.map_scale}` : `1:${game === 'ets2' ? 19 : 20} (default)`, inline: true },
    { name: 'Fuel used', value: typedFuel(job.fuel_used, job.fuel_unit), inline: true },
    { name: 'Damage', value: `${job.damage}%`, inline: true },
    { name: 'Profit', value: money(job.profit, game), inline: true },
    { name: 'Truck', value: e(`${job.truck}${job.truck_model ? ` ${job.truck_model}` : ''}`), inline: true },
    { name: 'Started', value: discordTime(job.started_at, 'f'), inline: true },
    { name: 'Delivered', value: discordTime(job.ended_at, 'f'), inline: true },
  ];
  if (job.uk) {
    fields.push({ name: 'UK stretch (scale 1:15)', value: `${typedDistance(job.uk.distance, job.unit)}: ${e(job.uk.entry_city)} → ${e(job.uk.end_city)}` });
  }
  for (const [n, a] of (job.adjusted_scales ?? []).entries()) {
    fields.push({ name: `Adjusted-scale section ${n + 1} (1:${a.scale})`, value: `${typedDistance(a.distance, job.unit)}: ${e(a.entry_city)} → ${e(a.exit_city)}` });
  }
  if (job.mod_names && job.mod_names.length > 0) fields.push({ name: 'Mods', value: job.mod_names.map(e).join(', ').slice(0, 1024) });
  return {
    title: `Manual submission · ${GAME_SHORT[game]} (preview)`,
    description: `**${e(job.cargo_name)}**: ${e(job.start_city)} (${e(job.start_company)}) → ${e(job.end_city)} (${e(job.end_company)})`,
    color: 0x5865f2,
    fields,
    footer: { text: 'The server works out the points; a moderator checks the evidence before they count.' },
  };
}

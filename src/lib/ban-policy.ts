// The EXOTIX moderation policy: fixed, shared categories over the existing WARCON ban lists.
// This file owns validation and wording only. Writing a list entry, syncing it to WARDOGS and
// delivering an announcement stay with the existing list and delivery modules.
import { MAX_CHAT } from './chat';
import { banUid } from './ban-message';
import { oneLine } from './saved-messages';

export const BAN_CATEGORY_IDS = [
	'rule-violation',
	'griefing',
	'abusive-conduct',
	'cheating',
	'player-review'
] as const;
export type BanCategoryId = (typeof BAN_CATEGORY_IDS)[number];

export type AnnouncementScope = 'origin' | 'org';
export type AnnouncementMode = 'ordered' | 'random';

export interface BanCategoryDefinition {
	id: BanCategoryId;
	label: string;
	description: string;
	/** Whole-day durations. Zero means permanent. */
	durations: readonly number[];
	/** The default destination for this category's public announcement. */
	announcementScope: AnnouncementScope;
}

const LADDER = [1, 3, 7, 30, 0] as const;

/** The categories are deliberately fixed so a case remains comparable across EXOTIX games. */
export const BAN_CATEGORIES: readonly BanCategoryDefinition[] = [
	{
		id: 'rule-violation',
		label: 'Rule Violation',
		description:
			'Breaking a published community, server or game rule, including exploiting, stream sniping, prohibited coordination, restrictions, spam, advertising or ban evasion.',
		durations: LADDER,
		announcementScope: 'origin'
	},
	{
		id: 'griefing',
		label: 'Griefing',
		description:
			'Deliberately sabotaging teammates, shared assets, the match or another player’s ability to play.',
		durations: LADDER,
		announcementScope: 'origin'
	},
	{
		id: 'abusive-conduct',
		label: 'Abusive Conduct',
		description:
			'Harassment, hate speech, threats, sharing private information, malicious impersonation or targeted intimidation.',
		durations: LADDER,
		announcementScope: 'origin'
	},
	{
		id: 'cheating',
		label: 'Cheating',
		description:
			'Confirmed prohibited software, automation or game manipulation that gives an unfair advantage.',
		durations: [0],
		announcementScope: 'org'
	},
	{
		id: 'player-review',
		label: 'Player Review',
		description:
			'Access restricted across EXOTIX while staff resolve a specific account, conduct or gameplay review.',
		durations: [0],
		announcementScope: 'origin'
	}
];

export const MAX_BAN_ANNOUNCEMENTS = 20;
export const MAX_BAN_NOTE = 10_000;
export const PLAYER_MESSAGE_TOKENS = [
	'category',
	'reason',
	'duration',
	'expires',
	'reference',
	'ticket_id',
	'name',
	'player',
	'source',
	'server',
	'event_server'
] as const;
export type PlayerMessageToken = (typeof PLAYER_MESSAGE_TOKENS)[number];

export interface BanCategoryPolicy {
	id: BanCategoryId;
	playerMessage: string;
	announcementEnabled: boolean;
	announcementScope: AnnouncementScope;
	announcementMode: AnnouncementMode;
	announcementMessages: string[];
}

export interface BanPolicy {
	/** Disabled policies leave legacy WARCON bans unchanged. */
	enabled: boolean;
	categories: BanCategoryPolicy[];
}

export interface BanPolicyView extends BanPolicy {
	version: string;
}

/** A ban case stores information that must never enter templates or a public announcement. */
export interface BanCase {
	categoryId: BanCategoryId;
	category: string;
	reason: string;
	days: number;
	ticketId: string | null;
	notes: string;
	originServerId: string | null;
	/** Stored after the entry id exists, so the player sees the exact text used. */
	playerMessage: string;
}

/** Private case data as shown to staff who can edit the ban list. */
export type BanCaseView = BanCase;

export interface BanTemplateValues {
	category: string;
	reason: string;
	days: number;
	expiresAt: Date | null;
	entryId: string;
	ticketId: string | null;
	playerName: string;
	source: string;
}

export interface PrepareBanCaseFacts {
	/** The entry is inserted first, which gives unticketed cases their stable reference. */
	entryId: string;
	playerName: string;
	source: string;
	expiresAt: Date | null;
}

export const durationText = (days: number): string =>
	days === 0 ? 'Permanent' : `${days} day${days === 1 ? '' : 's'}`;

export const categoryFor = (id: unknown): BanCategoryDefinition | undefined =>
	BAN_CATEGORIES.find((category) => category.id === id);

const defaultPlayerMessage =
	'{category} | {reason} | {duration} | Appeal discord.gg/exotix | Ref {reference}';

const defaultAnnouncement = '{source} | {player} was banned for {duration} for {reason}.';

function defaultPlayerMessageFor(category: BanCategoryDefinition): string {
	return category.id === 'player-review'
		? 'Your access is restricted while staff complete a Player Review | Appeal discord.gg/exotix | Ref {reference}'
		: defaultPlayerMessage;
}

function defaultAnnouncementFor(category: BanCategoryDefinition): string {
	return category.id === 'player-review'
		? '{source} | {player} is currently under staff review.'
		: defaultAnnouncement;
}

export const DEFAULT_BAN_POLICY: BanPolicy = {
	enabled: false,
	categories: BAN_CATEGORIES.map((category) => ({
		id: category.id,
		playerMessage: defaultPlayerMessageFor(category),
		announcementEnabled: true,
		announcementScope: category.announcementScope,
		announcementMode: 'ordered',
		announcementMessages: [defaultAnnouncementFor(category)]
	}))
};

const token = /\{([a-z_]+)\}/gi;

/** The tokens a template uses that this policy cannot fill. */
export const unknownBanPolicyTokens = (text: string): string[] =>
	[...new Set([...text.matchAll(token)].map(([, key]) => key.toLowerCase()))].filter(
		(key) => !(PLAYER_MESSAGE_TOKENS as readonly string[]).includes(key)
	);

function template(value: unknown, label: string, max: number): string {
	const raw = String(value ?? '')
		.toWellFormed()
		.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.trim();
	if (raw.length > max) throw new Error(`${label} is limited to ${max} characters.`);
	const text = oneLine(raw, max);
	if (!text) throw new Error(`${label} is required.`);
	if (/[{}]/.test(text.replace(token, ''))) throw new Error(`${label} has an invalid placeholder.`);
	if (unknownBanPolicyTokens(text).length)
		throw new Error(`${label} uses a placeholder that the ban policy does not know.`);
	return text;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('The ban policy is invalid.');
	return value as Record<string, unknown>;
}

/** Validates a complete policy. Categories and their duration ladders remain fixed. */
export function validateBanPolicy(raw: unknown): BanPolicy {
	const policy = asRecord(raw);
	if (typeof policy.enabled !== 'boolean')
		throw new Error('Set whether the ban policy is enabled.');
	if (!Array.isArray(policy.categories) || policy.categories.length !== BAN_CATEGORIES.length)
		throw new Error('The ban policy must configure every category.');
	const configured = new Map<BanCategoryId, BanCategoryPolicy>();
	for (const rawCategory of policy.categories) {
		const value = asRecord(rawCategory);
		const definition = categoryFor(value.id);
		if (!definition || configured.has(definition.id))
			throw new Error('The ban policy has an unknown category.');
		if (typeof value.announcementEnabled !== 'boolean')
			throw new Error(`${definition.label}: choose whether announcements are enabled.`);
		if (value.announcementScope !== 'origin' && value.announcementScope !== 'org')
			throw new Error(`${definition.label}: choose an announcement scope.`);
		if (definition.id === 'player-review' && value.announcementScope !== 'origin')
			throw new Error('Player Review announcements must stay on the originating server.');
		if (value.announcementMode !== 'ordered' && value.announcementMode !== 'random')
			throw new Error(`${definition.label}: choose an announcement order.`);
		if (!Array.isArray(value.announcementMessages))
			throw new Error(`${definition.label}: announcements must be a list.`);
		if (value.announcementMessages.length > MAX_BAN_ANNOUNCEMENTS)
			throw new Error(`${definition.label}: use at most ${MAX_BAN_ANNOUNCEMENTS} announcements.`);
		const messages = value.announcementMessages.map((message) =>
			template(message, `${definition.label} announcement`, MAX_CHAT)
		);
		if (value.announcementEnabled && !messages.length)
			throw new Error(`${definition.label}: add an announcement or switch it off.`);
		configured.set(definition.id, {
			id: definition.id,
			playerMessage: template(value.playerMessage, `${definition.label} player message`, 200),
			announcementEnabled: value.announcementEnabled,
			announcementScope: value.announcementScope,
			announcementMode: value.announcementMode,
			announcementMessages: messages
		});
	}
	return {
		enabled: policy.enabled,
		categories: BAN_CATEGORIES.map((category) => configured.get(category.id)!)
	};
}

/** Reads a stored policy defensively. Missing or invalid historic data leaves policy enforcement off. */
export function storedBanPolicy(raw: unknown): BanPolicy {
	try {
		return validateBanPolicy(raw);
	} catch {
		return structuredClone(DEFAULT_BAN_POLICY);
	}
}

export function validateBanCase(raw: unknown): Omit<BanCase, 'category' | 'playerMessage'> {
	const caseInput = asRecord(raw);
	const category = categoryFor(caseInput.categoryId);
	if (!category) throw new Error('Choose a ban category.');
	const days = caseInput.days;
	if (typeof days !== 'number' || !Number.isInteger(days) || !category.durations.includes(days))
		throw new Error(`${category.label}: choose one of its approved durations.`);
	const reason = oneLine(caseInput.reason, 200);
	if (!reason) throw new Error('Give the player a public reason.');
	const ticketRaw = caseInput.ticketId;
	const ticketId =
		ticketRaw === undefined || ticketRaw === null || ticketRaw === '' ? null : String(ticketRaw);
	if (ticketId !== null && !/^\d{5}$/.test(ticketId))
		throw new Error('Ticket ID must be exactly five digits.');
	const notes = String(caseInput.notes ?? '')
		.toWellFormed()
		.trim();
	if (notes.length > MAX_BAN_NOTE)
		throw new Error(`Internal notes are limited to ${MAX_BAN_NOTE} characters.`);
	const originServerId =
		caseInput.originServerId === undefined ||
		caseInput.originServerId === null ||
		caseInput.originServerId === ''
			? null
			: String(caseInput.originServerId);
	if (originServerId !== null && originServerId.length > 100)
		throw new Error('Origin server is invalid.');
	return { categoryId: category.id, reason, days, ticketId, notes, originServerId };
}

/** Prepares the immutable case record before its list entry has a stable id. */
export function prepareBanCase(
	policy: BanPolicy,
	moderation: unknown,
	facts: { reason: string; scope: 'org' | 'server'; originServerId: string | null }
): Omit<BanCase, 'category' | 'playerMessage'> {
	// Existing BanDialog callers still hold their public reason separately. Let a structured case
	// explicitly replace it, but never silently turn an empty reason into a category label.
	const source = asRecord(moderation);
	const input = validateBanCase({
		...source,
		reason: source.reason === undefined ? facts.reason : source.reason,
		originServerId:
			source.originServerId === undefined ? facts.originServerId : source.originServerId
	});
	const category = categoryFor(input.categoryId)!;
	if (!policy.categories.some((config) => config.id === category.id))
		throw new Error('The selected category is not in this ban policy.');
	return input;
}

/** Adds the category and final player text after the list entry has a stable id. */
export function finalizeBanCase(
	policy: BanPolicy,
	input: Omit<BanCase, 'category' | 'playerMessage'>,
	facts: PrepareBanCaseFacts
): BanCase {
	const category = categoryFor(input.categoryId)!;
	const playerMessage = playerMessageFor(policy, input.categoryId, {
		category: category.label,
		reason: input.reason,
		days: input.days,
		expiresAt: facts.expiresAt,
		entryId: facts.entryId,
		ticketId: input.ticketId,
		playerName: facts.playerName,
		source: facts.source
	});
	return { ...input, category: category.label, playerMessage };
}

const expiryText = (expiresAt: Date | null): string =>
	!expiresAt
		? 'Never'
		: `${expiresAt.getUTCDate()} ${expiresAt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${expiresAt.getUTCFullYear()} ${String(expiresAt.getUTCHours()).padStart(2, '0')}:${String(expiresAt.getUTCMinutes()).padStart(2, '0')} UTC`;

export function banReference(ticketId: string | null, entryId: string): string {
	return ticketId ? `T-${ticketId}` : banUid(entryId);
}

/** Renders text as WARDOGS will receive it. Notes are deliberately absent from this object. */
export function renderBanPolicyTemplate(
	template: string,
	values: BanTemplateValues,
	max: number
): string {
	const reference = banReference(values.ticketId, values.entryId);
	const tokens: Record<PlayerMessageToken, string> = {
		category: values.category,
		reason: values.reason,
		duration: durationText(values.days),
		expires: expiryText(values.expiresAt),
		reference,
		ticket_id: values.ticketId ?? '',
		name: values.playerName,
		player: values.playerName,
		source: values.source,
		server: values.source,
		event_server: values.source
	};
	const rendered = template.replace(
		token,
		(whole, key: string) => tokens[key.toLowerCase() as PlayerMessageToken] ?? whole
	);
	if (rendered.length > max)
		throw new Error(
			`The rendered ban message exceeds ${max} characters. Shorten its template or reason.`
		);
	return rendered
		.replace(/\s+/g, ' ')
		.replace(/^[\s|·:,;-]+|[\s|·:,;-]+$/g, '')
		.trim();
}

export function playerMessageFor(
	policy: BanPolicy,
	categoryId: BanCategoryId,
	values: BanTemplateValues
): string {
	const category = categoryFor(categoryId);
	const config = policy.categories.find((item) => item.id === categoryId);
	if (!category || !config) throw new Error('Ban policy category is missing.');
	return renderBanPolicyTemplate(
		config.playerMessage,
		{ ...values, category: category.label },
		200
	);
}

/** Chooses one public line. Callers keep the ordered cursor or supply random. */
export function announcementFor(
	policy: BanPolicy,
	categoryId: BanCategoryId,
	values: BanTemplateValues,
	index = 0,
	random = Math.random
): string | null {
	const category = categoryFor(categoryId);
	const config = policy.categories.find((item) => item.id === categoryId);
	if (!category || !config || !config.announcementEnabled || !config.announcementMessages.length)
		return null;
	const at =
		config.announcementMode === 'random'
			? Math.min(
					config.announcementMessages.length - 1,
					Math.floor(random() * config.announcementMessages.length)
				)
			: Math.abs(index) % config.announcementMessages.length;
	return renderBanPolicyTemplate(
		config.announcementMessages[at],
		{ ...values, category: category.label },
		MAX_CHAT
	);
}

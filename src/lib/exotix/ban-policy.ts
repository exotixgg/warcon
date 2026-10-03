// Internal descriptions are stored separately and never passed to the message formatter.
import { substituteBanVariables } from '$lib/ban-message';
export const POLICY_MESSAGE_VARS = ['reason', 'duration', 'reference', 'appeal'] as const;
export const DEFAULT_POLICY_MESSAGE = '{reason} | {duration} | {reference} | {appeal}';
export interface BanLevel {
	id: string;
	label: string;
	days: number;
}
export interface BanCategory {
	id: string;
	label: string;
	description: string;
	action: 'ban' | 'review';
	levels: BanLevel[];
}
export interface BanPolicy {
	enabled: boolean;
	appealText: string;
	/** Missing on policies saved before template support; use the original format. */
	messageTemplate?: string;
	categories: BanCategory[];
}
export interface BanPolicyView extends BanPolicy {
	version: string;
}
export interface BanCaseView {
	policyVersion: string;
	source: 'manual' | 'automated';
	reference: string;
	categoryId: string;
	category: string;
	severity: string;
	days: number;
	description: string;
	presetDays: number;
	extensions?: { at: string; rule: string; reason: string; expiresAt: string | null }[];
	appealText: string;
	message: string;
	messageTemplate?: string;
	reviewStatus?: 'pending' | 'resolved';
}
const levels = (): BanLevel[] => [
	{ id: 'standard', label: 'Standard', days: 7 },
	{ id: 'serious', label: 'Serious', days: 30 },
	{ id: 'critical', label: 'Critical', days: 0 }
];
export const DEFAULT_BAN_POLICY: BanPolicy = {
	enabled: false,
	appealText: 'Appeal on discord.gg/exotix',
	messageTemplate: DEFAULT_POLICY_MESSAGE,
	categories: [
		{
			id: 'rule-violation',
			label: 'Rule violation',
			description:
				'Clearly published server restrictions, including prohibited weapons and vehicles or explicitly prohibited spawn camping. Verified ban evasion belongs here: preserve the original sanction and record the linked case. Use a more specific category when applicable.',
			action: 'ban',
			levels: levels()
		},
		{
			id: 'griefing',
			label: 'Griefing',
			description:
				'Deliberate teammate sabotage: intentional team killing, destroying friendly spawn crates, blocking spawn exits, wrecking friendly vehicles or structures, or obstructing revives. Accidents and legitimate attacks on enemy assets are not griefing.',
			action: 'ban',
			levels: levels()
		},
		{
			id: 'abusive-conduct',
			label: 'Abusive conduct',
			description:
				'Harassment, abusive communications, hate speech, threats, doxxing, extremist promotion, malicious impersonation, deliberate false reports, or persistent disruptive soundboards, music and microphone spam. Assess context and evidence.',
			action: 'ban',
			levels: levels()
		},
		{
			id: 'exploiting',
			label: 'Exploiting',
			description:
				'Deliberate unfair use of bugs, unintended geometry, inaccessible structures, duplication or progression exploits. Also ghosting, stream sniping and prohibited cross-team coordination. Establish evidence of the conduct and the relevant rule.',
			action: 'ban',
			levels: levels()
		},
		{
			id: 'cheating',
			label: 'Cheating',
			description:
				'Conclusive evidence reviewed by a human moderator; obtain a second reviewer where possible. Statistics, young or private accounts and reports alone are insufficient. Never automatically ban for cheating based on heuristic signals.',
			action: 'ban',
			levels: [{ id: 'confirmed', label: 'Confirmed by reviewed evidence', days: 0 }]
		},
		{
			id: 'player-review',
			label: 'Player review',
			description:
				'Human-approved ban with no expiry pending a concrete account or behavior review. Ask the player to verify Steam account ownership and explain the case on Discord. This is not a confirmed cheating finding. Account age, privacy or statistics alone should flag a review, not trigger a ban.',
			action: 'review',
			levels: [{ id: 'pending', label: 'Pending review', days: 0 }]
		}
	]
};
const text = (v: unknown, name: string, max: number) => {
	if (typeof v !== 'string' || !v.trim() || v.trim().length > max)
		throw new Error(`${name} is required (maximum ${max} characters).`);
	return v.trim();
};
export const durationLabel = (days: number) => (days === 0 ? 'PERM' : `${days}d`);
export function validatePolicyMessage(template: string): string {
	const value = text(template, 'Player message template', 200);
	const keys = [...value.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].toLowerCase());
	if (
		/[\r\n]/.test(value) ||
		/[{}]/.test(value.replace(/\{([^{}]+)\}/g, '')) ||
		keys.some((k) => !(POLICY_MESSAGE_VARS as readonly string[]).includes(k))
	)
		throw new Error('Use only {reason}, {duration}, {reference} and {appeal} placeholders.');
	if (POLICY_MESSAGE_VARS.some((k) => !keys.includes(k)))
		throw new Error(
			'Include {reason}, {duration}, {reference} and {appeal} in the player message.'
		);
	return value;
}
export function banCaseMessage(
	reason: string,
	days: number,
	reference: string,
	appealText: string,
	messageTemplate = DEFAULT_POLICY_MESSAGE
): string {
	if (
		!reason.trim() ||
		/[|/\r\n]/.test(reason) ||
		!Number.isInteger(days) ||
		days < 0 ||
		!/^(t-\d{5}|a-\d{7})$/.test(reference) ||
		!appealText.trim() ||
		/[|\r\n]/.test(appealText)
	)
		throw new Error('Invalid ban message fields.');
	const message = substituteBanVariables(validatePolicyMessage(messageTemplate), {
		reason: reason.trim(),
		duration: durationLabel(days),
		reference,
		appeal: appealText.trim()
	});
	if (message.length > 200)
		throw new Error(
			'The complete player message exceeds 200 characters. Shorten the reason or appeal text.'
		);
	return message;
}
export function validateBanPolicy(value: unknown): BanPolicy {
	if (!value || typeof value !== 'object') throw new Error('A ban policy is required.');
	const p = value as Record<string, unknown>;
	if (
		typeof p.enabled !== 'boolean' ||
		!Array.isArray(p.categories) ||
		!p.categories.length ||
		p.categories.length > 12
	)
		throw new Error('Use 1–12 categories and an explicit enabled setting.');
	const appealText = text(p.appealText, 'Appeal text', 150);
	const messageTemplate = validatePolicyMessage(
		p.messageTemplate === undefined ? DEFAULT_POLICY_MESSAGE : (p.messageTemplate as string)
	);
	const ids = new Set<string>();
	const categories = p.categories.map((raw): BanCategory => {
		if (!raw || typeof raw !== 'object') throw new Error('Invalid category.');
		const c = raw as Record<string, unknown>;
		const id = text(c.id, 'Category ID', 40);
		if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id))
			throw new Error('Category IDs must be unique lower-case identifiers.');
		ids.add(id);
		const label = text(c.label, 'Reason', 80),
			description = text(c.description, 'Category guidance', 600);
		if (c.action !== 'ban' && c.action !== 'review')
			throw new Error('Choose ban or pending review for each category.');
		if (
			(id === 'player-review' && c.action !== 'review') ||
			(id === 'cheating' && c.action !== 'ban')
		)
			throw new Error(
				'Player review must remain pending review; cheating requires a confirmed ban.'
			);
		if (!Array.isArray(c.levels) || !c.levels.length || c.levels.length > 4)
			throw new Error('Categories need 1–4 severity levels.');
		const seen = new Set<string>();
		const ls = c.levels.map((raw): BanLevel => {
			const l = (raw ?? {}) as Record<string, unknown>,
				lid = text(l.id, 'Severity ID', 40);
			if (!/^[a-z][a-z0-9-]*$/.test(lid) || seen.has(lid))
				throw new Error('Severity IDs must be unique within a category.');
			seen.add(lid);
			if (!Number.isInteger(l.days) || Number(l.days) < 0 || Number(l.days) > 3650)
				throw new Error('Duration must be whole days from 0 (permanent) to 3650.');
			if ((c.action === 'review' || id === 'cheating') && l.days !== 0)
				throw new Error('Cheating and pending review require a permanent duration.');
			// Automation durations may differ from presets; reserve their largest supported label.
			banCaseMessage(label, 3650, 'a-0000001', appealText, messageTemplate);
			return { id: lid, label: text(l.label, 'Severity', 100), days: Number(l.days) };
		});
		return { id, label, description, action: c.action, levels: ls };
	});
	return { enabled: p.enabled, appealText, messageTemplate, categories };
}
export function manualBanCase(policy: BanPolicyView, body: Record<string, unknown>): BanCaseView {
	if (body.policyVersion !== policy.version)
		throw new Error('The ban policy changed. Reopen the ban form.');
	const category = policy.categories.find((c) => c.id === body.categoryId);
	if (!category) throw new Error('Choose a ban category.');
	const level = category.levels.find((l) => l.id === body.levelId);
	if (!level) throw new Error('Choose a severity.');
	if (typeof body.ticketId !== 'string' || !/^\d{5}$/.test(body.ticketId))
		throw new Error('TicketID must be exactly five digits.');
	const reference = `t-${body.ticketId}`,
		description = text(body.description, 'Internal description', 10000);
	return {
		policyVersion: policy.version,
		source: 'manual',
		reference,
		categoryId: category.id,
		category: category.label,
		severity: level.label,
		days: level.days,
		presetDays: level.days,
		description,
		appealText: policy.appealText,
		messageTemplate: policy.messageTemplate ?? DEFAULT_POLICY_MESSAGE,
		message: banCaseMessage(
			category.label,
			level.days,
			reference,
			policy.appealText,
			policy.messageTemplate
		),
		...(category.action === 'review' ? { reviewStatus: 'pending' as const } : {})
	};
}

import { shownName, type ChatLine } from './chat-read';

export const archiveRanges = ['1h', '24h', '7d', '30d', 'all', 'custom'] as const;
export type ArchiveRange = (typeof archiveRanges)[number];
export const archiveDurations = {
	'1h': 3600000,
	'24h': 86400000,
	'7d': 604800000,
	'30d': 2592000000
};

export function archiveWindow(range: ArchiveRange, now: number, from = '', to = '') {
	if (range === 'custom')
		return { lower: from ? Date.parse(from) : null, upper: to ? Date.parse(to) : null };
	return { lower: range === 'all' ? null : now - archiveDurations[range], upper: null };
}

export interface ChatSource {
	id: string;
	name: string;
	enabled: boolean;
	state: string;
	lastRead: string | null;
	epoch: number | null;
	retired: boolean;
	canSend: boolean;
}
export interface ArchiveLine {
	id: string;
	at: string;
	serverId: string;
	kind: 'message' | 'gap' | 'start' | 'end';
	speaker: string;
	steamId: string | null;
	channel: string;
	body: string;
	seq: number | null;
	epoch: number | null;
	faction: string;
	ping: boolean;
}
export interface ArchivePage {
	servers: ChatSource[];
	lines: ArchiveLine[];
	next: string | null;
}

export type LiveChatLine = ChatLine & { observedAt?: string };
export type ChatEntry = ArchiveLine & { live?: LiveChatLine };

export function chatTimeline(
	archived: ArchiveLine[],
	live: LiveChatLine[],
	serverId: string,
	filters: {
		range: ArchiveRange;
		player: string;
		any?: string;
		channel: string;
		q?: string;
		faction?: string;
		from?: string;
		to?: string;
	},
	now: number,
	archiveEpoch: number | null
): ChatEntry[] {
	if (!live.length) return archived;
	const entries: ChatEntry[] = archived.map((line) => ({ ...line }));
	const bySequence = new Map<number, ChatEntry[]>();
	for (const line of entries) {
		if (line.serverId !== serverId || line.kind !== 'message' || line.seq === null) continue;
		const same = bySequence.get(line.seq);
		if (same) same.push(line);
		else bySequence.set(line.seq, [line]);
	}
	const { lower, upper } = archiveWindow(filters.range, now, filters.from, filters.to);
	const player = filters.player.toLowerCase(),
		any = filters.any?.toLowerCase(),
		q = filters.q?.toLowerCase(),
		faction = filters.faction?.toLowerCase();
	for (const l of live) {
		const at = l.at ?? l.observedAt;
		if (
			!at ||
			(lower !== null && Date.parse(at) < lower) ||
			(upper !== null && Date.parse(at) > upper) ||
			(filters.channel && l.channel !== filters.channel) ||
			(faction && l.faction.toLowerCase() !== faction) ||
			(q && !l.text.toLowerCase().includes(q))
		)
			continue;
		const speaker = shownName(l);
		const names = [l.name, l.hiddenName, l.steamId, speaker].map((s) => s.toLowerCase());
		if (
			player &&
			(/^\d{17}$/.test(player) ? l.steamId !== player : !speaker.toLowerCase().includes(player))
		)
			continue;
		if (
			any &&
			![...names, l.text.toLowerCase(), l.typed?.toLowerCase() ?? ''].some((s) => s.includes(any))
		)
			continue;
		const saved = bySequence
			.get(l.seq)
			?.find(
				(a) =>
					(l.at ? a.at === l.at : archiveEpoch !== null && a.epoch === archiveEpoch) &&
					a.body === l.text &&
					a.speaker === speaker &&
					a.channel === l.channel &&
					(a.steamId ?? '') === l.steamId
			);
		if (saved) saved.live = l;
		else
			entries.push({
				id: 'live-' + l.seq,
				at,
				serverId,
				kind: 'message',
				seq: l.seq,
				epoch: null,
				speaker,
				steamId: l.steamId || null,
				channel: l.channel,
				faction: l.faction,
				body: l.text,
				ping: l.ping,
				live: l
			});
	}
	const rank = { start: 0, message: 1, gap: 2, end: 3 };
	return entries.sort(
		(a, b) => b.at.localeCompare(a.at) || rank[b.kind] - rank[a.kind] || (b.seq ?? 0) - (a.seq ?? 0)
	);
}

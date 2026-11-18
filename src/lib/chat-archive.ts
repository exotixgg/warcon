export const archiveRanges = ['1h', '24h', '7d', '30d', 'all'] as const;
export type ArchiveRange = (typeof archiveRanges)[number];
export interface ChatSource {
	id: string;
	name: string;
	enabled: boolean;
	state: string;
	lastRead: string | null;
	retired: boolean;
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
}
export interface ArchivePage {
	servers: ChatSource[];
	lines: ArchiveLine[];
	next: string | null;
}

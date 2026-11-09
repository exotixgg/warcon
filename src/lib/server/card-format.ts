// Shared chat-card formatting. Names are shortened only at grapheme boundaries.
/** Compact display values are intentional: the RCON chat transport is limited to 256 characters. */
export function compactNumber(value: number): string {
	const n = Math.max(0, Math.round(value));
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
	return String(n);
}

export function compactMinutes(value: number): string {
	const minutes = Math.max(0, Math.round(value));
	return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
}

export function shortCardName(value: string, max = 20): string {
	const text = value.replace(/\s+/g, ' ').trim();
	const chars =
		typeof Intl.Segmenter === 'function'
			? Array.from(
					new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
					(part) => part.segment
				)
			: Array.from(text);
	if (text.length <= max) return text;
	if (max <= 1) return '…';
	let output = '';
	for (const part of chars) {
		if (output.length + part.length + 1 > max) break;
		output += part;
	}
	return output ? `${output}…` : '…';
}

export function cardServerLabel(name: string): string {
	return shortCardName(name.replace(/^EXOTIX(?:-|\s+)/i, 'EXOTIX.GG '), 24) || '-';
}

export const cardLeaderLine = (name: string, value: string, unit: string) =>
	`${name} — ${value} ${unit}`;

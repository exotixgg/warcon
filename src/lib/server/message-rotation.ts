// A short-lived, read-only rotation snapshot for message placeholders. Never infer the next
// entry from a map name: maps repeat with different weather and random rotations have no order.
import { mapName } from '$lib/format';
import { MESSAGE_RULES, canonical } from '$lib/placeholders';
import type { Rotation, RotationEntry, Status, TriggerKind } from '$lib/types';

export const MESSAGE_ROTATION_TTL_MS = 30_000;
export type RotationStatus = Pick<Status, 'map' | 'rotationNow' | 'rotationNext'>;
export interface MessageRotation {
	at: number;
	map: string;
	nowIndex: number;
	nextIndex: number;
	rotation: Rotation | null;
}

export function usesMessageRotation(rows: { kind: TriggerKind; config: unknown }[]): boolean {
	return rows.some(({ kind, config }) => {
		const c = (config ?? {}) as Record<string, unknown>;
		return MESSAGE_RULES[kind]?.fields.some((field) => {
			const texts = Array.isArray(c[field]) ? c[field] : [c[field]];
			return texts.some(
				(text: unknown) =>
					typeof text === 'string' &&
					[...text.matchAll(/\{([a-z_]+)\}/gi)].some(([, name]) =>
						['next_map', 'next_weather', 'match_card'].includes(canonical(name))
					)
			);
		});
	});
}

const sameMap = (a: string, b: string) => mapName(a).toLowerCase() === mapName(b).toLowerCase();

export function messageRotationSnapshot(
	status: RotationStatus,
	rotation: Rotation | null,
	at: number
): MessageRotation {
	return {
		at,
		map: status.map,
		nowIndex: status.rotationNow,
		nextIndex: status.rotationNext,
		rotation
	};
}

export function messageRotationDue(
	seen: MessageRotation | null | undefined,
	status: RotationStatus,
	now: number
): boolean {
	return (
		!seen ||
		now < seen.at ||
		now - seen.at >= MESSAGE_ROTATION_TTL_MS ||
		!sameMap(seen.map, status.map) ||
		seen.nowIndex !== status.rotationNow ||
		seen.nextIndex !== status.rotationNext
	);
}

/** Unknown, expired, disabled, denied or disagreeing observations have no trustworthy next entry. */
export function nextMessageEntry(
	status: RotationStatus | null,
	seen: MessageRotation | null | undefined,
	now: number
): RotationEntry | null {
	if (!status?.map || !seen || messageRotationDue(seen, status, now)) return null;
	const r = seen.rotation;
	if (
		!r?.enabled ||
		!Number.isInteger(r.nextIndex) ||
		r.nextIndex < 0 ||
		r.nextIndex !== status.rotationNext ||
		r.nowIndex !== status.rotationNow
	)
		return null;
	const next = r.entries[r.nextIndex];
	if (
		!next?.map ||
		next.denied ||
		next.status !== 'next' ||
		r.entries.filter((e) => e.status === 'next').length !== 1 ||
		r.entries.filter((e) => e.status === 'now').length > 1
	)
		return null;
	if (r.nowIndex >= 0 && !sameMap(r.entries[r.nowIndex]?.map ?? '', status.map)) return null;
	return next;
}

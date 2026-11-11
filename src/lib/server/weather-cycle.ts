// The Weather cycle rule (kind `weather_cycle`). WARDOGS changes the time of day and weather of the
// match being played when asked (PUT /v1/world/lighting, Match control's setWeather): no map change,
// no restart. The rule asks every few minutes while the server has its players on, going through its
// lightings in its own order, or picking one at random, and never the one the server shows already.
// The next map starts on its rotation entry's own lighting, and the rule changes that at its next
// turn. At delivery the server's own list of lightings is read first, so one it does not offer (rain
// is allowed on some servers only, and read at startup) is kept as skipped rather than sent. No
// database here.
import { ApiError, int, str } from './http';
import { ACTIONS } from './actions';
import { settingsFingerprint } from './fingerprint';
import type { WardogsClient } from './rcon';
import { mapName, prettify } from '../format';
import type { CatalogItem, Rotation, Status } from '../types';

/** The outbox action that changes the weather for the rule (not in ACTIONS). */
export const WEATHER_CYCLE = 'weather_cycle';
export const WEATHER_DEFAULT_MINUTES = 30;
/** Any sooner and the weather flickers rather than changes. */
export const WEATHER_MIN_MINUTES = 5;
export const WEATHER_MAX_MINUTES = 1440;
/** More than the game lists (nine on Season 2). */
const MAX_LIGHTINGS = 20;
/** A lighting id as the game's catalog gives them ("DayLateRain"). */
const LIGHTING_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export interface WeatherCycleConfig {
	/** lighting ids, in the order the rule goes through them */
	lightings: string[];
	everyMinutes: number;
	/** any of the others at random, rather than the next in order */
	random: boolean;
	/** changes only while at least this many are on */
	minPlayers: number;
	/** Starting presets the rule leaves alone. Absent on older rules. */
	skipStartingLightings?: string[];
}

function lightingIds(values: unknown): string[] {
	const lightings: string[] = [];
	for (const v of Array.isArray(values) ? values : []) {
		const id = str(v, 101);
		if (!LIGHTING_ID.test(id))
			throw new ApiError(
				400,
				`"${id.slice(0, 40)}" is not a lighting: use the ids the server lists, such as DayLateRain.`
			);
		if (!lightings.some((x) => same(x, id))) lightings.push(id);
	}
	if (lightings.length > MAX_LIGHTINGS)
		throw new ApiError(400, `At most ${MAX_LIGHTINGS} lightings.`);
	return lightings;
}

export function validateWeatherCycle(c: Record<string, unknown>): WeatherCycleConfig {
	const lightings = lightingIds(c.lightings);
	if (lightings.length < 2)
		throw new ApiError(400, 'Pick at least two lightings to change between.');
	const skipStartingLightings = lightingIds(c.skipStartingLightings);
	if (lightings.some((id) => skipsLighting(skipStartingLightings, id)))
		throw new ApiError(400, 'Remove excluded presets from the cycle’s lighting list.');
	const everyMinutes = int(c.everyMinutes, WEATHER_DEFAULT_MINUTES);
	if (everyMinutes < WEATHER_MIN_MINUTES || everyMinutes > WEATHER_MAX_MINUTES)
		throw new ApiError(
			400,
			`Change the weather every ${WEATHER_MIN_MINUTES} to ${WEATHER_MAX_MINUTES} minutes.`
		);
	return {
		lightings,
		everyMinutes,
		random: c.random === true,
		minPlayers: int(c.minPlayers, 1, 0, 1000),
		...(skipStartingLightings.length ? { skipStartingLightings } : {})
	};
}

/** The fingerprint a rule's rows carry: a change decided under other settings is not sent. */
export const weatherCycleSettingsKey = (cfg: WeatherCycleConfig): string =>
	settingsFingerprint(cfg);

/** Where the rule is in its list: the place of the lighting it last put on, -1 before the first. */
export const weatherCycleIndex = (state: unknown): number => {
	const i = (state as { index?: unknown } | null)?.index;
	return typeof i === 'number' && Number.isInteger(i) && i >= 0 ? i : -1;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const skipsLighting = (excluded: readonly string[], lighting: string): boolean =>
	excluded.some((id) => same(id, lighting));

/** A protected preset can be visible before the status and rotation indices agree on map travel. */
export function weatherCycleBlock(
	excluded: readonly string[],
	status: Pick<Status, 'map' | 'lighting' | 'rotationNow'>,
	rotation: Rotation | null
): string | null {
	if (!excluded.length) return null;
	if (skipsLighting(excluded, status.lighting))
		return `The active lighting is ${lightingName(status.lighting)}, an excluded preset.`;
	if (rotation && !rotation.enabled && status.map && status.lighting) return null;
	const entry = rotation?.entries[status.rotationNow];
	if (
		!entry?.lighting ||
		!status.map ||
		!status.lighting ||
		rotation?.nowIndex !== status.rotationNow ||
		entry.denied ||
		!same(mapName(entry.map), mapName(status.map))
	)
		return 'The starting preset could not be verified.';
	return skipsLighting(excluded, entry.lighting)
		? `This round starts with ${lightingName(entry.lighting)}, an excluded preset.`
		: null;
}

/** "Day Late Rain": a lighting's name in the panel's own words, from its id. */
export const lightingName = (id: string): string => prettify(id) || id;

/**
 * The lighting the rule puts on next and its place in the list: in order, the one after the last
 * it put on (the top the first time), passing over the one the server shows; at random, any but the
 * one the server shows. Null only when the list holds nothing else.
 */
export function nextLighting(
	cfg: Pick<WeatherCycleConfig, 'lightings' | 'random'>,
	last: number,
	showing: string,
	rand: () => number = Math.random
): { index: number; lighting: string } | null {
	const n = cfg.lightings.length;
	if (cfg.random) {
		const others = cfg.lightings
			.map((lighting, index) => ({ index, lighting }))
			.filter((l) => !same(l.lighting, showing));
		return others.length
			? others[Math.min(others.length - 1, Math.floor(rand() * others.length))]
			: null;
	}
	for (let step = 1; step <= n; step++) {
		const index = (last + step) % n;
		if (!same(cfg.lightings[index], showing)) return { index, lighting: cfg.lightings[index] };
	}
	return null;
}

/**
 * The change, at delivery: the server's lightings read, and the rule's sent only when the server
 * lists it, under the id the server gives it (`skipped` otherwise: the outbox keeps the row, with
 * no audit row). The result is the panel's own words.
 */
export async function changeWeather(
	client: WardogsClient,
	params: Record<string, unknown>
): Promise<{ message: string; skipped?: true }> {
	const lighting = str(params.lighting, 100);
	const { lightings } = (await ACTIONS.lightings.run(client, {})) as { lightings: CatalogItem[] };
	const offered = lightings.find((l) => same(l.id, lighting));
	if (!offered)
		return {
			skipped: true,
			message: `Not sent: ${lightingName(lighting)} is not among the lightings this server lists.`
		};
	const excluded = Array.isArray(params.skipStartingLightings)
		? (params.skipStartingLightings as string[])
		: [];
	if (excluded.length) {
		const rotation = (await ACTIONS.rotation.run(client, {})) as Rotation;
		const status = (await ACTIONS.status.run(client, {})) as Status;
		const block = weatherCycleBlock(excluded, status, rotation);
		if (block) return { skipped: true, message: `Not sent: ${block}` };
		if (status.playerCount < Number(params.minPlayers))
			return { skipped: true, message: 'Not sent: the player count fell below the minimum.' };
	}
	await ACTIONS.setWeather.run(client, { lighting: offered.id });
	return { message: `Changed the weather to ${lightingName(offered.id)}.` };
}

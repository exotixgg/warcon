import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, readJson, route } from '$lib/server/http';
import { getOrg, requireServerCap } from '$lib/server/access';
import { reservationView } from '$lib/server/owned-org-reservations';
import {
	removeServerEntry,
	renewOwnedServerReservation,
	removeOwnedServerReservation
} from '$lib/server/lists';

/** Scope-specific read used to retire a legacy server row after organisation coverage is verified. */
export const GET = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'slots.manage'
	);
	const org = await getOrg(env, server.orgId);
	if (!org) throw new ApiError(404, 'Organisation not found.');
	return apiJson({
		ok: true,
		entry: await reservationView(env, org, user, param(event, 'steamId'), server)
	});
});

/** Withdraws a slot the server's own list holds. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'slots.manage'
	);
	const org = await getOrg(env, server.orgId);
	if (!org) throw new ApiError(404, 'Organisation not found.');
	const result = await removeServerEntry(
		env,
		event.request,
		user,
		server,
		org,
		'reserve',
		param(event, 'steamId')
	);
	return apiJson({ ok: true, ...result });
});

/** Extends or withdraws only the exact finite EXOTIX reservation observed by the caller. */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'slots.manage'
	);
	const org = await getOrg(env, server.orgId);
	if (!org) throw new ApiError(404, 'Organisation not found.');
	const body = await readJson(event.request);
	const operation =
		body.remove === true ? removeOwnedServerReservation : renewOwnedServerReservation;
	const result = await operation(
		env,
		event.request,
		user,
		server,
		org,
		param(event, 'steamId'),
		body
	);
	return apiJson({ ok: true, ...result });
});

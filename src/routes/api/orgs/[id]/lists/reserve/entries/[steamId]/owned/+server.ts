import { getEnv } from '$lib/server/env';
import { requireListsRole } from '$lib/server/access';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { reservationView, mutateOwnedOrgReservation } from '$lib/server/owned-org-reservations';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	return apiJson({
		ok: true,
		entry: await reservationView(env, org, user, param(event, 'steamId'))
	});
});
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	return apiJson({
		ok: true,
		...(await mutateOwnedOrgReservation(
			env,
			event.request,
			org,
			user,
			param(event, 'steamId'),
			await readJson(event.request),
			true
		))
	});
});
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	return apiJson({
		ok: true,
		...(await mutateOwnedOrgReservation(
			env,
			event.request,
			org,
			user,
			param(event, 'steamId'),
			await readJson(event.request),
			false
		))
	});
});

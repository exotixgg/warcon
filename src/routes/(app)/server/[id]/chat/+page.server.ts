import { getEnv } from '$lib/server/env';
import { requireServerCap } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const env = getEnv();
	try {
		await requireServerCap(env, locals, params.id, 'chat.read');
	} catch (err) {
		const e = normalizeError(err);
		if (e) error(e.status, e.message);
		throw err;
	}
};

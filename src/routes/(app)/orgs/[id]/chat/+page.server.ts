import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireUser, getOrg } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { chatSources } from '$lib/server/chat-history';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const env = getEnv();
	try {
		const sources = await chatSources(env, requireUser(locals), params.id);
		const home = sources.find((s) => !s.retired);
		if (home) {
			const search = new URLSearchParams(url.search);
			search.set('scope', 'org');
			redirect(307, '/server/' + encodeURIComponent(home.id) + '/chat?' + search);
		}
		const org = await getOrg(env, params.id);
		if (!org) error(404, 'Organisation unavailable.');
		return { chatOrg: { id: org.id, name: org.name } };
	} catch (err) {
		const e = normalizeError(err);
		if (e) error(e.status, e.message);
		throw err;
	}
};

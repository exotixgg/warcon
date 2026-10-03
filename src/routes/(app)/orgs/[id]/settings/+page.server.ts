import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireOrgRole } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';

export const load: PageServerLoad = async ({ locals, params }) => {
	try {
		const { org } = await requireOrgRole(getEnv(), locals, params.id, 'owner');
		return { banOrganization: { id: org.id, name: org.name, banMessage: org.banMessage } };
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};

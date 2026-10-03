import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { settingsView } from '$lib/server/settings';
import { asc } from 'drizzle-orm';
import { organizations } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (locals.user?.role !== 'owner') error(403, 'Owner access required.');
	const [settings, banOrganizations] = await Promise.all([
		settingsView(env),
		env.db
			.select({
				id: organizations.id,
				name: organizations.name,
				banMessage: organizations.banMessage
			})
			.from(organizations)
			.orderBy(asc(organizations.name))
	]);
	return { settings, banOrganizations };
};

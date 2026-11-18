import { eq } from 'drizzle-orm';
import { getEnv } from '$lib/server/env';
import { requireServerCap } from '$lib/server/access';
import { chatArchiveSources } from '$lib/server/db/schema';
import { normalizeError } from '$lib/server/http';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const env = getEnv();
	try {
		const { server } = await requireServerCap(env, locals, params.id, 'chat.read');
		const [source] = await env.db
			.select({ enabled: chatArchiveSources.enabled })
			.from(chatArchiveSources)
			.where(eq(chatArchiveSources.serverId, server.id));
		return { archiveEnabled: source?.enabled ?? false };
	} catch (err) {
		const e = normalizeError(err);
		if (e) error(e.status, e.message);
		throw err;
	}
};

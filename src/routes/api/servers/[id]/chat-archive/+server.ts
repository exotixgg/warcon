import { eq } from 'drizzle-orm';
import { getEnv } from '$lib/server/env';
import { requireServerManager } from '$lib/server/access';
import { apiJson, ApiError, param, readJson, route } from '$lib/server/http';
import { chatArchiveSources as sources } from '$lib/server/db/schema';
import { gateway } from '$lib/server/gateway';
import { writeAudit } from '$lib/server/audit';
import type { ChatTerms } from '$lib/chat-read';

export const PUT = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerManager(env, event.locals, param(event, 'id'));
	const { enabled } = await readJson(event.request);
	if (typeof enabled !== 'boolean') throw new ApiError(400, 'Choose whether to collect chat.');
	if (enabled) {
		const terms = (await gateway().run(env, server, 'chatTerms', {})) as ChatTerms;
		if (!terms.accepted || terms.cut)
			throw new ApiError(409, 'Review and accept the game’s chat terms first.');
	}
	const values = {
		serverId: server.id,
		orgId: server.orgId,
		name: server.name,
		enabled,
		changedAt: new Date(),
		revision: crypto.randomUUID(),
		state: enabled ? 'waiting' : 'off'
	};
	if (enabled)
		await env.db
			.insert(sources)
			.values(values)
			.onConflictDoUpdate({
				target: sources.serverId,
				set: values,
				setWhere: eq(sources.enabled, false)
			});
	else
		await env.db
			.update(sources)
			.set({ enabled, changedAt: values.changedAt, revision: values.revision, state: 'off' })
			.where(eq(sources.serverId, server.id));
	await writeAudit(env, event.request, {
		actor: user,
		server,
		orgId: server.orgId,
		category: 'server',
		action: 'server.chat_archive',
		message: enabled ? 'Chat collection enabled.' : 'Chat collection paused.',
		outcome: 'ok'
	});
	return apiJson({ ok: true, enabled });
});

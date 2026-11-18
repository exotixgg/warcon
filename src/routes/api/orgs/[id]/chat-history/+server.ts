import { getEnv } from '$lib/server/env';
import { requireUser } from '$lib/server/access';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { chatHistory } from '$lib/server/chat-history';

// Keep moderation search text out of request URLs and access logs.
export const POST = route(async (event) => {
	const user = requireUser(event.locals);
	const body = await readJson(event.request);
	const p = new URLSearchParams();
	for (const key of [
		'server',
		'range',
		'limit',
		'before',
		'around',
		'player',
		'q',
		'any',
		'channel'
	])
		if (typeof body[key] === 'string') p.set(key, body[key]);
	return apiJson(await chatHistory(getEnv(), user, param(event, 'id'), p));
});

import { eq, sql, type SQL } from 'drizzle-orm';
import {
	archiveRanges,
	archiveDurations,
	type ArchiveLine,
	type ArchivePage,
	type ChatSource
} from '$lib/chat-archive';
import { accessibleServers, getOrg, keyForbidden, orgRoleFor, type SessionUser } from './access';
import { chatArchiveSources as sources, servers } from './db/schema';
import type { Env } from './env';
import { ApiError } from './http';

// Scope every request independently, including subsequent pages and live refreshes.
export async function chatSources(
	env: Env,
	user: SessionUser,
	orgId: string
): Promise<ChatSource[]> {
	if (user.apiKey) throw keyForbidden();
	const [org, live, role] = await Promise.all([
		getOrg(env, orgId),
		accessibleServers(env, user, orgId),
		orgRoleFor(env, user, orgId)
	]);
	if (!org || org.suspendedAt || (!live.length && role !== 'owner'))
		throw new ApiError(404, 'Organisation not found.', 'not_found');
	const allowed = live.filter((s) => s.caps.includes('chat.read'));
	const rows = await env.db
		.select({ source: sources, registered: servers.id })
		.from(sources)
		.leftJoin(servers, eq(servers.id, sources.serverId))
		.where(eq(sources.orgId, orgId));
	const byId = new Map(rows.map((r) => [r.source.serverId, r.source]));
	const view = (id: string, name: string, retired = false): ChatSource => {
		const s = byId.get(id);
		return {
			id,
			name,
			retired,
			enabled: !!s?.enabled && !retired,
			state: s?.enabled ? s.state : 'waiting',
			epoch: s?.epoch ?? null,
			lastRead: s?.lastReadAt?.toISOString() ?? null
		};
	};
	const result = allowed.map((s) => view(s.id, s.name));
	if (role === 'owner')
		for (const r of rows)
			if (!r.registered) result.push(view(r.source.serverId, r.source.name, true));
	if (!result.length && role !== 'owner')
		throw new ApiError(403, 'Read chat permission is required.');
	return result.sort(
		(a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id)
	);
}

const kinds = ['start', 'message', 'gap', 'end'] as const;
function before(p: URLSearchParams) {
	const value = p.get('before');
	if (!value) return null;
	const [at, kind, id, ...extra] = value.split('|');
	if (
		extra.length ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) ||
		!Number.isFinite(Date.parse(at)) ||
		!/^\d{1,16}$/.test(id) ||
		!kinds.includes(kind as (typeof kinds)[number])
	)
		throw new ApiError(400, 'Invalid chat page cursor.');
	return { at, rank: kinds.indexOf(kind as (typeof kinds)[number]), id };
}
function contains(column: SQL, value: string) {
	const pattern = '%' + value.replace(/[!%_]/g, '!$&') + '%';
	return sql`${column} ilike ${pattern} escape '!'`;
}

export async function chatHistory(
	env: Env,
	user: SessionUser,
	orgId: string,
	p: URLSearchParams
): Promise<ArchivePage> {
	const list = await chatSources(env, user, orgId);
	const selected = p.get('server');
	if (selected && !list.some((s) => s.id === selected))
		throw new ApiError(404, 'Server unavailable.');
	const ids = selected ? [selected] : list.map((s) => s.id);
	const range = p.get('range') ?? '1h';
	if (!archiveRanges.some((r) => r === range)) throw new ApiError(400, 'Invalid chat time range.');
	const limit = Math.min(100, Math.max(1, Number(p.get('limit')) || 100));
	if (!Number.isInteger(limit)) throw new ApiError(400, 'Invalid page size.');
	const player = (p.get('player') ?? '').trim(),
		text = (p.get('q') ?? '').trim(),
		any = (p.get('any') ?? '').trim(),
		channel = (p.get('channel') ?? '').trim();
	if (player.length > 100 || text.length > 500 || any.length > 500 || channel.length > 24)
		throw new ApiError(400, 'Search is too long.');
	const cursor = before(p);
	const focus = p.get('around');
	if (focus && !Number.isFinite(Date.parse(focus)))
		throw new ApiError(400, 'Invalid context time.');
	const lower = focus
		? Date.parse(focus) - 300000
		: range !== 'all'
			? Date.now() - archiveDurations[range as keyof typeof archiveDurations]
			: null;
	// A server's live buffer can still be read when retention is off.
	const liveRoundWindow = !focus && list.some((s) => s.id === selected && !s.retired);
	const upper = focus ? Date.parse(focus) + 300000 : null;
	if (!ids.length) return { servers: list, lines: [], next: null };
	const idSet = sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `
	);
	function bounds(at: SQL, rank: SQL, id: SQL) {
		return sql`${lower !== null ? sql`and ${at} >= ${new Date(lower).toISOString()}::timestamptz` : sql``}
			${upper !== null ? sql`and ${at} <= ${new Date(upper).toISOString()}::timestamptz` : sql``}
			${cursor ? sql`and (${at},${rank},${id}) < (${cursor.at}::timestamptz,${cursor.rank}::int,${cursor.id}::bigint)` : sql``}`;
	}
	const rank = sql`case when c.kind='gap' then 2 else 1 end`;
	const parts = [
		sql`(select c.at, c.id, ${rank} as rank, c.server_id, c.kind,c.speaker,c.steam_id,c.channel,c.body,c.seq,c.epoch,c.faction,c.ping
		from chat_messages c where c.org_id=${orgId} and c.server_id in (${idSet})
		${bounds(sql`c.at`, rank, sql`c.id`)}
		${player || text || any || channel ? sql`and c.kind='message'` : sql``}
		${player ? sql`and ${/^\d{17}$/.test(player) ? sql`c.steam_id=${player}` : contains(sql`c.speaker`, player)}` : sql``}
		${text ? sql`and ${contains(sql`c.body`, text)}` : sql``}
		${channel ? sql`and c.channel=${channel}` : sql``}
        ${any ? sql`and (${contains(sql`c.speaker`, any)} or ${contains(sql`c.body`, any)} or c.steam_id=${any})` : sql``}
        order by c.at desc,rank desc,c.id desc limit ${limit + 1})`
	];
	if (!player && !text && !any && !channel)
		for (const end of [false, true]) {
			const at = end ? sql`m.ended_at` : sql`m.started_at`,
				rank = end ? sql`3` : sql`0`;
			parts.push(sql`(select ${at} as at,m.id,${rank} as rank,m.server_id,${end ? 'end' : 'start'}::text as kind,
			'' as speaker,null::text as steam_id,'' as channel,
			concat_ws(' · ',nullif(m.map,''),nullif(m.experiences,''),${
				end
					? sql`case when m.winner<>'' then 'Winner: '||m.winner end,
				(select string_agg(concat_ws(' ',f->>'name',f->>'score'),', ' order by pos)
				 from jsonb_array_elements(case when jsonb_typeof(m.final_scores)='array' then m.final_scores else '[]'::jsonb end) with ordinality as scores(f,pos))`
					: sql`null::text`
			}) as body, null::bigint as seq, null::int as epoch, ''::text as faction, false as ping
			from matches m left join chat_archive_sources s on s.server_id=m.server_id and s.org_id=${orgId}
            where m.server_id in (${idSet}) and ${at} is not null
            and ((coalesce(m.ended_at,'infinity'::timestamptz)>=s.created_at and (s.enabled or ${at}<=s.changed_at))
                 ${liveRoundWindow ? sql`or ${at} >= now() - interval '1 hour'` : sql``})
            ${bounds(at, rank, sql`m.id`)}
			order by ${at} desc,m.id desc limit ${limit + 1})`);
		}
	// Source game and match timestamps have millisecond precision. Always return UTC for deep links.
	const rows = (await env.db
		.execute(sql`select to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
		id::text,server_id as "serverId",kind,speaker,steam_id as "steamId",channel,body,seq::double precision as seq,epoch,faction,ping
		from (${sql.join(parts, sql` union all `)}) as timeline order by at desc,rank desc,id::bigint desc limit ${limit + 1}`)) as unknown as ArchiveLine[];
	const lines = rows.slice(0, limit),
		last = lines.at(-1);
	return {
		servers: list,
		lines,
		next: last && rows.length > limit ? [last.at, last.kind, last.id].join('|') : null
	};
}

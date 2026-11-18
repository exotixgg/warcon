<script lang="ts">
	import { untrack } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { fmtTime } from '$lib/format';
	import {
		archiveRanges,
		type ArchiveRange,
		type ArchivePage,
		type ArchiveLine,
		type ChatSource
	} from '$lib/chat-archive';
	let {
		orgId,
		serverId = '',
		initialPlayer = '',
		compact = false,
		around = ''
	}: {
		orgId: string;
		serverId?: string;
		initialPlayer?: string;
		compact?: boolean;
		around?: string;
	} = $props();
	let range = $state<ArchiveRange>(untrack(() => (initialPlayer ? 'all' : '1h')));
	let player = $state(untrack(() => initialPlayer)),
		draftPlayer = $state(untrack(() => initialPlayer));
	let query = $state(''),
		draftQuery = $state(''),
		server = $state('');
	let sources = $state<ChatSource[]>([]),
		lines = $state<ArchiveLine[]>([]),
		next = $state<string | null>(null);
	let error = $state(''),
		loaded = $state(false),
		moreBusy = $state(false),
		browsing = $state(false);
	let revision = $state(0);
	let serial = 0;
	const filters = $derived({
		server: serverId || server,
		range,
		player,
		q: query,
		limit: compact ? '10' : '100',
		around
	});
	const sourceMap = $derived(new Map(sources.map((s) => [s.id, s])));
	// Use the server's own suffix (EU-03 → 3). For duplicate or unnumbered names,
	// reserve the other suffixes first and assign an unused number in stable name/ID order.
	const numbers = $derived.by(() => {
		const numbers = new Map<string, number>();
		const used = new Set<number>();
		for (const s of sources) {
			const n = Number(s.name.match(/(?:^|[-\s])(\d+)$/)?.[1]);
			if (n > 0 && Number.isSafeInteger(n) && !used.has(n)) {
				numbers.set(s.id, n);
				used.add(n);
			}
		}
		let n = 1;
		for (const s of sources)
			if (!numbers.has(s.id)) {
				while (used.has(n)) n++;
				numbers.set(s.id, n);
				used.add(n);
			}
		return numbers;
	});
	function search() {
		const target = draftPlayer.trim();
		if (target && target !== player) range = 'all';
		player = target;
		query = draftQuery.trim();
	}
	function request(scope: string, params: typeof filters, before = '') {
		return api<ArchivePage>('POST', `/api/orgs/${encodeURIComponent(scope)}/chat-history`, {
			...params,
			before
		});
	}
	$effect(() => {
		const params = filters,
			scope = orgId;
		revision;
		const version = ++serial;
		lines = [];
		loaded = false;
		error = '';
		next = null;
		browsing = false;
		moreBusy = false;
		const stop = untrack(() =>
			poll(
				async () => {
					try {
						const page = await request(scope, params);
						if (version !== serial) return;
						if (browsing) {
							const allowed = new Set(page.servers.map((s) => s.id));
							lines = lines.filter((l) => allowed.has(l.serverId));
							sources = page.servers;
							return;
						}
						lines = page.lines;
						sources = page.servers;
						next = page.next;
						loaded = true;
						error = '';
					} catch (e) {
						if (version !== serial) return;
						lines = [];
						sources = [];
						next = null;
						loaded = true;
						error = errorMessage(e);
					}
				},
				compact ? 30000 : 5000
			)
		);
		return () => {
			serial++;
			stop();
		};
	});
	async function older() {
		if (!next || moreBusy) return;
		const version = serial;
		browsing = true;
		moreBusy = true;
		try {
			const page = await request(orgId, filters, next);
			if (version !== serial) return;
			// Grants are re-evaluated for each page, even during a long review.
			const permitted = new Set(page.servers.map((s) => s.id));
			lines = [...lines.filter((l) => permitted.has(l.serverId)), ...page.lines];
			next = page.next;
			sources = page.servers;
			error = '';
		} catch (e) {
			if (version === serial) {
				error = errorMessage(e);
				lines = [];
				next = null;
				sources = [];
			}
		} finally {
			if (version === serial) moreBusy = false;
		}
	}
	const orgPath = $derived('/orgs/' + encodeURIComponent(orgId) + '/chat');
	const focusedSource = $derived(sourceMap.get(serverId));
</script>

<section class="my-3 panel">
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<span class="mr-auto label-sm mb-0"
			>{compact
				? 'Recent chat'
				: around
					? 'Conversation context'
					: serverId
						? 'Server chat'
						: 'All server chats'}</span
		>
		{#if compact}
			<a class="btn btn-sm" href="{orgPath}?player={encodeURIComponent(initialPlayer)}"
				>View all messages</a
			>
		{:else if around}
			<a class="btn btn-sm" href="/server/{encodeURIComponent(serverId)}/chat">Back to latest</a>
		{:else}
			<label class="text-xs text-mist-400"
				>Time range
				<select aria-label="Time range" class="ml-1 input w-auto" bind:value={range}>
					{#each archiveRanges as r}<option value={r}>{r === 'all' ? 'All' : r}</option>{/each}
				</select>
			</label>
		{/if}
	</div>
	{#if !compact && !around}
		<form
			class="mb-3 flex flex-wrap items-end gap-2"
			onsubmit={(e) => {
				e.preventDefault();
				search();
			}}
		>
			{#if !serverId}
				<label class="text-xs text-mist-400"
					>Server
					<select aria-label="Server" class="block input" bind:value={server}>
						<option value="">All permitted servers</option>
						{#each sources as s}<option value={s.id}
								>#{numbers.get(s.id)} · {s.name}{s.retired ? ' (retired)' : ''}</option
							>{/each}
					</select>
				</label>
			{/if}
			<label class="text-xs text-mist-400"
				>Player or SteamID<input
					class="block input"
					bind:value={draftPlayer}
					maxlength="100"
				/></label
			>
			<label class="text-xs text-mist-400"
				>Message contains<input
					class="block input"
					bind:value={draftQuery}
					maxlength="500"
				/></label
			>
			<button class="btn btn-sm" type="submit">Search</button>
		</form>
	{/if}
	{#if focusedSource}
		<p class="note mb-2">
			{focusedSource.enabled
				? focusedSource.state === 'ready'
					? 'Collecting'
					: focusedSource.state === 'terms'
						? 'Waiting for chat terms'
						: focusedSource.state === 'unavailable'
							? 'RCON unavailable'
							: 'Waiting for first read'
				: 'Collection off'}{focusedSource.lastRead
				? ' · Last read ' + fmtTime(focusedSource.lastRead)
				: ''}
		</p>
	{:else if !compact && sources.length}
		<div class="mb-3 flex flex-wrap gap-2 text-xs text-mist-400">
			{#each sources as s}<span title={s.lastRead ? 'Last read ' + fmtTime(s.lastRead) : s.state}
					><b class="font-mono">#{numbers.get(s.id)}</b>
					{s.name}{s.retired
						? ' · retired'
						: !s.enabled
							? ' · off'
							: s.state === 'ready'
								? ''
								: ' · ' + s.state}</span
				>{/each}
		</div>
	{/if}
	{#if error}<p class="callout">{error}</p>
	{:else if !loaded}<p class="note">Loading chat…</p>
	{:else if !lines.length}<p class="note">
			{compact ? 'No archived messages from this player.' : 'No chat entries match these filters.'}
		</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead
					><tr
						><th>Time</th>{#if !serverId}<th>Server</th>{/if}<th>Player / round</th><th>Message</th
						></tr
					></thead
				>
				<tbody>
					{#each lines as l (l.kind + l.id)}
						{@const source = sourceMap.get(l.serverId)}
						{@const path = '/server/' + encodeURIComponent(l.serverId)}
						<tr>
							<td class="font-mono text-xs whitespace-nowrap text-mist-400">
								{#if l.kind === 'message' && !source?.retired && !around}
									<a
										class="hover:underline"
										title="Open surrounding conversation"
										href="{path}/chat?around={encodeURIComponent(l.at)}">{fmtTime(l.at)}</a
									>
								{:else}{fmtTime(l.at)}{/if}
							</td>
							{#if !serverId}<td title={source?.name} class="font-mono whitespace-nowrap"
									>#{numbers.get(l.serverId)}
									<span class="hidden text-xs text-mist-400 lg:inline">{source?.name}</span></td
								>{/if}
							{#if l.kind === 'message'}
								<td
									>{#if l.steamId}<a
											class="text-accent hover:underline"
											href={source?.retired
												? orgPath + '?player=' + encodeURIComponent(l.steamId)
												: path + '/players/' + l.steamId}>{l.speaker}</a
										>{:else}{l.speaker}{/if}
									{#if l.channel}<span class="ml-1 text-xs text-mist-400">{l.channel}</span
										>{/if}</td
								>
								<td class="break-words whitespace-pre-wrap">{l.body}</td>
							{:else}
								<td class="font-semibold text-mist-400"
									>{l.kind === 'gap'
										? 'Collection gap'
										: l.kind === 'start'
											? 'Round started'
											: 'Round ended'}</td
								>
								<td
									>{#if l.kind !== 'gap' && !source?.retired}<a
											class="text-accent hover:underline"
											href="{path}/matches/{l.id}">{l.body || 'Match details'}</a
										>{:else}{l.body}{/if}</td
								>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	{#if !compact && (next || browsing)}
		<div class="mt-3 flex gap-2">
			{#if next}<button class="btn btn-sm" disabled={moreBusy} onclick={older}>Load older</button
				>{/if}
			{#if browsing}<button class="btn btn-sm" onclick={() => revision++}>Return to latest</button
				>{/if}
		</div>
	{/if}
</section>

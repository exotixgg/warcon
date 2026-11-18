<script lang="ts">
	import { untrack, tick, type Snippet } from 'svelte';
	import ChatComposer from './ChatComposer.svelte';
	import type { FactionScore, ServerInfo } from '$lib/types';
	import FactionChip from './FactionChip.svelte';
	import Badge from './Badge.svelte';
	import { api, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { fmtTime } from '$lib/format';
	import {
		archiveRanges,
		chatTimeline,
		type LiveChatLine,
		type ArchiveRange,
		type ArchivePage,
		type ArchiveLine,
		type ChatSource
	} from '$lib/chat-archive';

	let {
		orgId,
		operator,
		serverId = '',
		homeId = '',
		initialPlayer = '',
		compact = false,
		around = '',
		server = $bindable(''),
		live = [],
		liveLoading = false,
		scores = null,
		notice,
		footer,
		inspect
	}: {
		orgId: string;
		operator?: Pick<ServerInfo, 'orgName' | 'manager'>;
		serverId?: string;
		homeId?: string;
		initialPlayer?: string;
		compact?: boolean;
		around?: string;
		server?: string;
		live?: LiveChatLine[];
		liveLoading?: boolean;
		scores?: FactionScore[] | null;
		notice?: Snippet;
		footer?: Snippet;
		inspect?: (line: LiveChatLine) => void;
	} = $props();
	let range = $state<ArchiveRange>(untrack(() => (initialPlayer && !compact ? 'all' : '1h')));
	let player = $state(untrack(() => initialPlayer));
	let playerDraft = $state(untrack(() => initialPlayer));
	let query = $state(''),
		draft = $state('');
	let faction = $state(''),
		teamDraft = $state('');
	$effect(() => {
		const values = [playerDraft.trim(), draft.trim(), teamDraft.trim()];
		const timer = setTimeout(() => {
			[player, query, faction] = values;
		}, 300);
		return () => clearTimeout(timer);
	});
	let channel = $state('');
	let fromLocal = $state(''),
		toLocal = $state('');
	function toUtc(value: string, end: boolean) {
		if (!value) return '';
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return '';
		if (end) date.setSeconds(59, 999);
		return date.toISOString();
	}
	const from = $derived(range === 'custom' ? toUtc(fromLocal, false) : '');
	const to = $derived(range === 'custom' ? toUtc(toLocal, true) : '');
	const invalidWindow = $derived(
		range === 'custom' && ((!from && !to) || (from && to && from > to))
	);
	const filterId = $props.id();
	let target = $state('');
	let composer = $state<ReturnType<typeof ChatComposer>>();
	const sending = $derived(composer?.locked() ?? false);
	let now = $state(Date.now());
	let scroller: HTMLDivElement;
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
		server,
		range,
		player,
		q: query,
		faction,
		from,
		to,
		channel,
		limit: compact ? '10' : '100',
		around
	});
	const sourceMap = $derived(new Map(sources.map((s) => [s.id, s])));
	const destination = $derived(sourceMap.get(server || target));
	async function replyTo(entry: ArchiveLine) {
		if (!entry.steamId || sending || !sourceMap.get(entry.serverId)?.canSend) return;
		if (!server) target = entry.serverId;
		await tick();
		if (destination?.id === entry.serverId) await composer?.replyTo(entry.steamId, entry.speaker);
	}

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
		scroller?.scrollTo({ top: 0 });
		lines = [];
		loaded = false;
		error = '';
		next = null;
		browsing = false;
		moreBusy = false;
		if (invalidWindow) {
			loaded = true;
			return;
		}
		const stop = untrack(() =>
			poll(
				async () => {
					try {
						const page = await request(scope, params);
						if (version !== serial) return;
						now = Date.now();
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

	const focusedSource = $derived(sourceMap.get(server));
	const allPath = $derived(
		homeId || serverId
			? '/server/' + encodeURIComponent(homeId || serverId) + '/chat?scope=org'
			: orgPath
	);
	const channels = $derived(
		[
			...new Set(
				[
					'Global',
					'Team',
					'Squad',
					'Proximity',
					'Vehicle',
					channel,
					...lines.map((l) => l.channel),
					...live.map((l) => l.channel)
				].filter(Boolean)
			)
		].sort()
	);
	const factions = $derived(
		[
			...new Set(
				[
					'RED',
					'BLU',
					'GRN',
					...(scores ?? []).map((s) => s.name),
					...lines.map((l) => l.faction),
					...live.map((l) => l.faction)
				].filter(Boolean)
			)
		].sort()
	);
	const visibleLive = $derived(
		server && server === serverId && !around && sourceMap.has(server) && !error && !invalidWindow
			? live
			: []
	);
	const entries = $derived(
		chatTimeline(lines, visibleLive, serverId, filters, now, focusedSource?.epoch ?? null)
	);
	const clock = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const day = new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
	function historyStatus(state: string) {
		if (state === 'ready') return 'History on';
		if (state === 'terms') return 'Waiting for accepted chat terms';
		if (state === 'unavailable') return 'Waiting for RCON';
		return 'Waiting for first read';
	}
</script>

<section class="my-3 min-w-0 panel" aria-label={compact ? 'Recent chat' : 'Chat'}>
	<header class="flex flex-wrap items-center gap-2">
		<h2 class="mr-auto label-sm mb-0">{compact ? 'Recent chat' : 'Chat'}</h2>
		{#if compact}
			<a
				class="btn btn-sm"
				href={allPath +
					(allPath.includes('?') ? '&' : '?') +
					'player=' +
					encodeURIComponent(initialPlayer)}>View all messages</a
			>
		{:else if around}
			<a class="btn btn-sm" href="/server/{encodeURIComponent(serverId)}/chat">Back to latest</a>
		{:else}
			{#if serverId}
				<div
					class="inline-flex rounded-ctl border border-white/10 p-0.5"
					role="group"
					aria-label="Chat scope"
				>
					<button
						class="btn btn-sm"
						class:btn-primary={server === serverId}
						disabled={sending}
						aria-pressed={server === serverId}
						onclick={() => (server = serverId)}>This server</button
					>
					<button
						class="btn btn-sm"
						class:btn-primary={!server}
						disabled={sending}
						aria-pressed={!server}
						onclick={() => {
							target = '';
							server = '';
						}}>All servers</button
					>
				</div>
			{:else}
				<select aria-label="Server" class="input w-auto" bind:value={server}
					><option value="">All servers</option>
					{#each sources as s}<option value={s.id}>#{numbers.get(s.id)} · {s.name}</option>{/each}
				</select>
			{/if}
			{#if !server}<a
					class="btn btn-sm"
					href={allPath}
					target="_blank"
					rel="noopener"
					aria-label="Open all servers in a new window">Open window ↗</a
				>{/if}
		{/if}
		{#if !around && !compact && (draft || playerDraft || teamDraft || channel || range !== '1h')}
			<button
				type="button"
				class="btn btn-sm"
				onclick={() => {
					draft = '';
					playerDraft = '';
					teamDraft = '';
					channel = '';
					range = '1h';
					fromLocal = '';
					toLocal = '';
				}}>Clear filters</button
			>
		{/if}
		{#if !around}
			<select aria-label="History time range" class="input w-auto" bind:value={range}>
				{#each archiveRanges as r}<option value={r}
						>{r === 'all' ? 'All time' : r === 'custom' ? 'Custom dates' : 'Last ' + r}</option
					>{/each}
			</select>
		{/if}
	</header>
	{#if !compact && !around}
		<div
			class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_8rem]"
		>
			<label class="min-w-0"
				><span class="field-label">Message</span><input
					type="search"
					class="input min-w-0"
					aria-label="Message text"
					placeholder="Search message text…"
					maxlength="500"
					bind:value={draft}
				/></label
			>
			<label class="min-w-0"
				><span class="field-label">Player</span><input
					type="search"
					class="input min-w-0"
					aria-label="Filter by player"
					placeholder="Player name or SteamID…"
					maxlength="100"
					bind:value={playerDraft}
				/></label
			>
			<label class="min-w-0"
				><span class="field-label">Team</span><input
					type="search"
					class="input min-w-0"
					aria-label="Filter by team"
					placeholder="All teams"
					maxlength="24"
					list={filterId + '-teams'}
					bind:value={teamDraft}
				/></label
			>
			<datalist id={filterId + '-teams'}
				>{#each factions as name}<option value={name}></option>{/each}</datalist
			>
			<label class="min-w-0"
				><span class="field-label">Channel</span><select
					aria-label="Channel"
					class="input min-w-0"
					bind:value={channel}
				>
					<option value="">All channels</option>{#each channels as c}<option value={c}>{c}</option
						>{/each}
				</select></label
			>
		</div>
	{/if}
	{#if range === 'custom' && !around}
		<div class="mt-2 flex flex-wrap items-end gap-2">
			<label class="text-xs text-mist-400"
				>From (local time)<input
					type="datetime-local"
					class="input"
					bind:value={fromLocal}
				/></label
			>
			<label class="text-xs text-mist-400"
				>Through (local time)<input
					type="datetime-local"
					class="input"
					bind:value={toLocal}
				/></label
			>
		</div>
	{/if}
	{#if !compact && (!server || focusedSource)}
		<div class="my-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mist-400">
			{#if focusedSource}
				<span>{focusedSource.retired ? 'Retired server' : historyStatus(focusedSource.state)}</span>
			{:else}
				{#each sources as s (s.id)}<span
						><b class="font-mono">#{numbers.get(s.id)}</b>
						{s.name}{s.retired
							? ' · retired'
							: s.state === 'ready'
								? ''
								: ' · ' + historyStatus(s.state)}</span
					>{/each}
			{/if}
		</div>
	{/if}
	{#if server && server === serverId && !around}{@render notice?.()}{/if}
	<div
		class="mt-2 max-h-[45vh] overflow-y-auto rounded-ctl border border-white/10 bg-ink-950"
		bind:this={scroller}
	>
		{#if invalidWindow}<p class="p-4 text-sm text-mist-400">
				{from && to
					? 'End time must follow start time.'
					: 'Enter a start or end time to view history.'}
			</p>
		{:else if error}<p class="callout">{error}</p>
		{:else if !loaded || (!entries.length && liveLoading)}<p class="p-4 text-sm text-mist-400">
				Loading chat…
			</p>
		{:else if !entries.length}<p class="p-4 text-sm text-mist-400">
				{compact ? 'No archived messages from this player.' : 'No messages in this view.'}
			</p>
		{:else}
			<ol class="m-0 list-none p-0">
				{#each entries as entry, i (entry.serverId + ':' + entry.kind + ':' + entry.id)}
					{@const source = sourceMap.get(entry.serverId)}
					{@const path = '/server/' + encodeURIComponent(entry.serverId)}
					{@const date = new Date(entry.at)}
					<li class="group border-b border-white/5 last:border-b-0">
						{#if !i || day.format(date) !== day.format(new Date(entries[i - 1].at))}
							<div
								class="border-b border-white/10 bg-white/5 px-3 py-1 font-mono text-[11px] text-mist-400"
							>
								{day.format(date)}
							</div>
						{/if}
						<div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-[13px]">
							<time
								datetime={entry.at}
								class="font-mono text-xs text-mist-400"
								title={fmtTime(entry.at)}
							>
								{#if entry.kind === 'message' && !source?.retired && !around && !entry.id.startsWith('live-')}
									<a
										class="hover:underline"
										title="View conversation around this message"
										href="{path}/chat?around={encodeURIComponent(entry.at)}">{clock.format(date)}</a
									>
								{:else}{clock.format(date)}{/if}
							</time>
							{#if !server}<span
									class="rounded-sm bg-white/10 px-1 font-mono text-xs"
									title={source?.name}>#{numbers.get(entry.serverId)}</span
								>{/if}
							{#if entry.kind === 'message'}
								{#if entry.channel}<span class="text-xs text-mist-400">{entry.channel}</span>{/if}
								{#if entry.faction}<span class="text-xs"
										><FactionChip
											faction={entry.faction}
											scores={entry.serverId === serverId ? scores : null}
										/></span
									>{/if}
								{#if entry.steamId}
									<a
										class="font-semibold text-accent hover:underline"
										href={source?.retired
											? orgPath + '?player=' + entry.steamId
											: path + '/players/' + entry.steamId}>{entry.speaker}</a
									>
								{:else}<strong>{entry.speaker}</strong>{/if}
								{#if entry.live?.anonymous}<Badge tone="info">anon</Badge>{/if}
								{#if entry.ping}<Badge>ping</Badge>{/if}
								{#if entry.live?.typed}<Badge tone="warn">filtered</Badge>{/if}
								<span class="min-w-0 [overflow-wrap:anywhere] break-words whitespace-pre-wrap"
									>{entry.body}</span
								>
								{#if operator && !compact && !around && entry.steamId && source?.canSend}
									<button
										type="button"
										aria-label={'Whisper to ' + entry.speaker}
										class="ml-auto text-xs text-mist-400 hover:text-accent hover:underline focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
										disabled={sending}
										onclick={() => replyTo(entry)}>Whisper</button
									>
								{/if}
								{#if entry.live && inspect}
									{@const line = entry.live}
									<button
										class="text-xs text-mist-400 hover:underline"
										aria-label="Inspect chat line {line.seq}"
										onclick={() => inspect?.(line)}>Details</button
									>
								{/if}
							{:else}
								<span class="font-semibold text-mist-400"
									>{entry.kind === 'start'
										? 'Round started'
										: entry.kind === 'end'
											? 'Round ended'
											: 'Collection gap'}</span
								>
								{#if entry.kind !== 'gap' && !source?.retired}<a
										class="text-accent hover:underline"
										href="{path}/matches/{entry.id}">{entry.body || 'Match details'}</a
									>{:else}{entry.body}{/if}
								<span class="my-auto grow border-t border-white/15"></span>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
			{#if !compact && next}<button class="m-2 btn btn-sm" disabled={moreBusy} onclick={older}
					>Load older messages</button
				>{/if}
		{/if}
	</div>
	{#if browsing}<button class="mt-2 btn btn-sm" onclick={() => revision++}>Return to latest</button
		>{/if}
	{#if operator && !compact && !around && (server ? destination?.canSend : sources.some((s) => s.canSend))}
		<section aria-label="Send a message" class="mt-3 space-y-2 border-t border-white/10 pt-3">
			<div class="flex flex-wrap items-center gap-2">
				<h3 class="field-label mb-0!">Send to</h3>
				{#if server}
					<strong class="text-sm">{destination?.name}</strong>
				{:else}
					<select
						aria-label="Destination server"
						class="input w-auto max-w-full"
						disabled={sending}
						bind:value={target}
					>
						<option value="">Choose a server…</option>
						{#each sources.filter((s) => s.canSend) as s (s.id)}<option value={s.id}
								>#{numbers.get(s.id)} · {s.name}</option
							>{/each}
					</select>
				{/if}
			</div>
			{#if destination?.canSend}
				{#key destination.id}
					<ChatComposer
						server={{ ...destination, orgId, orgName: operator.orgName, manager: operator.manager }}
						bind:this={composer}
					/>
				{/key}
			{/if}
		</section>
	{/if}
	{#if server && server === serverId && !around && !error && focusedSource}{@render footer?.()}{/if}
</section>

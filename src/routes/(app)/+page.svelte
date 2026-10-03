<script lang="ts">
	import { watchLive } from '$lib/live';
	import { rconPost, errorMessage } from '$lib/api';
	import { MAX_CHAT } from '$lib/chat';
	import { toast } from '$lib/toast.svelte';
	import { fmtNum, mapName } from '$lib/format';
	import { setHealth } from '$lib/health.svelte';
	import MapArt from '$lib/components/MapArt.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { LiveView, ServerInfo, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let news = $state('');
	let newsConfirmation = $state<{ message: string; targets: ServerInfo[] } | null>(null);
	let sendingNews = $state(false);
	let newsReport = $state<{
		message: string;
		sentIds: string[];
		failed: { id: string; name: string; error: string }[];
	} | null>(null);
	let canBroadcastAll = $derived(
		data.servers.length > 0 && data.servers.every((s) => s.caps.includes('chat.send'))
	);
	let retryingNews = $derived(
		newsReport !== null && newsReport.message === news.trim() && newsReport.failed.length > 0
	);

	function reviewNews() {
		const message = news.trim();
		if (!message || message.length > MAX_CHAT || !canBroadcastAll || sendingNews) return;
		const failed = retryingNews ? new Set(newsReport!.failed.map((s) => s.id)) : null;
		const targets = data.servers.filter((s) => !failed || failed.has(s.id));
		if (targets.length) newsConfirmation = { message, targets };
	}

	async function sendNews() {
		const confirmed = newsConfirmation;
		if (!confirmed || sendingNews) return;
		newsConfirmation = null;
		sendingNews = true;
		const sentIds = retryingNews ? [...newsReport!.sentIds] : [];
		const failed: { id: string; name: string; error: string }[] = [];
		try {
			// A few requests at a time keeps the dashboard responsive without flooding the game listeners.
			for (let i = 0; i < confirmed.targets.length; i += 4) {
				const group = confirmed.targets.slice(i, i + 4);
				const results = await Promise.allSettled(
					group.map((s) => rconPost(s.id, 'broadcast', { message: confirmed.message }))
				);
				results.forEach((result, index) => {
					const server = group[index];
					if (result.status === 'fulfilled') sentIds.push(server.id);
					else
						failed.push({ id: server.id, name: server.name, error: errorMessage(result.reason) });
				});
			}
			if (failed.length) {
				newsReport = { message: confirmed.message, sentIds, failed };
				toast(
					`Server news sent to ${sentIds.length} of ${sentIds.length + failed.length} servers.`,
					'err'
				);
			} else {
				newsReport = null;
				news = '';
				toast(
					`Server news sent to ${sentIds.length} server${sentIds.length === 1 ? '' : 's'}.`,
					'ok'
				);
			}
		} finally {
			sendingNews = false;
		}
	}

	type Summary =
		{ ok: true; status: Status; reservedSlots: number | null } | { ok: false; error: string };
	let summaries = $state<Record<string, Summary>>({});

	// Every observation the worker makes of these servers arrives here as it happens.
	function onLive(v: LiveView) {
		if (v.ok && v.status)
			summaries[v.serverId] = { ok: true, status: v.status, reservedSlots: v.reservedSlots };
		else if (v.status && !v.ok)
			summaries[v.serverId] = { ok: false, error: v.error || 'Unreachable.' };
		else summaries[v.serverId] = { ok: false, error: v.error || 'Not observed yet.' };
		setHealth(v.serverId, v.ok);
	}

	$effect(() => {
		const ids = data.servers.map((s) => s.id);
		return watchLive(ids, onLive);
	});

	// ── Sorting and filtering ─────────────────────────────────────────────────────────────
	// Sort and status filter survive a reload; the search box does not.
	const VIEW_KEY = 'warcon.dashboardView';
	const SORTS = ['default', 'name', 'players', 'fill', 'map', 'problems'] as const;
	const SHOWS = ['all', 'online', 'populated', 'offline'] as const;
	type Sort = (typeof SORTS)[number];
	type Show = (typeof SHOWS)[number];

	let q = $state('');
	let orgFilter = $state('');
	let sort = $state<Sort>('default');
	let show = $state<Show>('all');
	let restored = $state(false);

	$effect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
			if (SORTS.includes(saved.sort)) sort = saved.sort;
			if (SHOWS.includes(saved.show)) show = saved.show;
		} catch {
			/* nothing saved, or private mode */
		}
		restored = true;
	});
	$effect(() => {
		const view = { sort, show };
		if (!restored) return;
		try {
			localStorage.setItem(VIEW_KEY, JSON.stringify(view));
		} catch {
			/* private mode */
		}
	});

	/** organisations represented on the board; the select only appears when there is more than one */
	let orgs = $derived.by(() => {
		if (data.scope) return [];
		const seen = new Map<string, string>();
		for (const s of data.servers) seen.set(s.orgId, s.orgName);
		return [...seen].map(([id, name]) => ({ id, name }));
	});

	type Row = { s: (typeof data.servers)[number]; i: number; sum: Summary | undefined };
	const status = (r: Row) => (r.sum?.ok ? r.sum.status : null);
	const fill = (st: Status) => (st.maxPlayers ? st.playerCount / st.maxPlayers : 0);
	/** 0 offline, 1 not yet observed, 2 online */
	const health = (r: Row) => (!r.sum ? 1 : r.sum.ok ? 2 : 0);
	const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
	/** online servers first, then by a live number descending; offline and unobserved keep their own order */
	const byLive = (pick: (st: Status) => number) => (a: Row, b: Row) => {
		const sa = status(a);
		const sb = status(b);
		if (sa && sb) return pick(sb) - pick(sa);
		return (sb ? 1 : 0) - (sa ? 1 : 0);
	};
	const comparators: Record<Sort, (a: Row, b: Row) => number> = {
		default: () => 0,
		name: (a, b) => byText(a.s.name, b.s.name),
		players: byLive((st) => st.playerCount),
		fill: byLive(fill),
		map: (a, b) => {
			const ma = status(a)?.map;
			const mb = status(b)?.map;
			if (ma && mb) return byText(mapName(ma), mapName(mb));
			return (mb ? 1 : 0) - (ma ? 1 : 0);
		},
		problems: (a, b) => health(a) - health(b)
	};

	let shown = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		const cmp = comparators[sort];
		return data.servers
			.map((s, i): Row => ({ s, i, sum: summaries[s.id] }))
			.filter((r) => {
				if (orgFilter && r.s.orgId !== orgFilter) return false;
				const st = status(r);
				if (show === 'online' && !st) return false;
				if (show === 'offline' && health(r) !== 0) return false;
				if (show === 'populated' && !(st && st.playerCount > 0)) return false;
				if (!needle) return true;
				const hay =
					`${r.s.name} ${r.s.host}:${r.s.port} ${r.s.orgName} ` +
					`${st?.serverName ?? ''} ${st ? mapName(st.map) : ''}`;
				return hay.toLowerCase().includes(needle);
			})
			.sort((a, b) => cmp(a, b) || a.i - b.i)
			.map((r) => r.s);
	});
	let filtering = $derived(!!q.trim() || !!orgFilter || show !== 'all');
	const clearFilters = () => {
		q = '';
		orgFilter = '';
		show = 'all';
	};
</script>

<svelte:head><title>Dashboard · {data.appName}</title></svelte:head>

<h1 class="mb-5 text-xl font-semibold tracking-tight">Dashboard</h1>

{#if !data.servers.length}
	<div class="callout">
		{#if data.scope}
			No servers in {data.scope.name}{data.canManage ? ' yet' : ' are shared with you'}. Pick
			another organisation, or all of them, from the header.
		{:else if data.canManage}
			No servers yet. <a href="/servers" class="font-semibold text-accent underline"
				>Add your first server</a
			>{#if data.demoAllowed}
				&nbsp;— or add one with host <code class="chip">demo</code>, port
				<code class="chip">1</code>, password <code class="chip">demo</code> to try the panel against
				the built-in mock game server.{:else}.{/if}
		{:else}
			No servers have been shared with you yet. Ask an owner of your organisation to grant you
			access{#if data.canCreateOrg}, or <a
					href="/sign-up"
					class="font-semibold text-accent underline">create your own organisation</a
				>{/if}.
		{/if}
	</div>
{:else}
	{#if data.servers.length > 1 || canBroadcastAll}
		<div class="mb-4 flex flex-wrap items-center gap-2">
			{#if data.servers.length > 1}
				<input
					class="input sm:w-64"
					type="search"
					placeholder="Search name, host, map…"
					bind:value={q}
					aria-label="Search servers"
				/>
				<select class="input w-auto pr-[30px]" bind:value={show} aria-label="Show">
					<option value="all">All servers</option>
					<option value="online">Online</option>
					<option value="populated">With players</option>
					<option value="offline">Offline</option>
				</select>
				{#if orgs.length > 1}
					<select
						class="input w-auto pr-[30px] sm:max-w-56"
						bind:value={orgFilter}
						aria-label="Organisation"
					>
						<option value="">All organisations</option>
						{#each orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
					</select>
				{/if}
			{/if}
			{#if canBroadcastAll}
				<form
					class="flex min-w-0 flex-1 items-center gap-2 sm:min-w-72"
					onsubmit={(event) => {
						event.preventDefault();
						reviewNews();
					}}
				>
					<input
						class="input min-w-0 flex-1"
						type="text"
						maxlength={MAX_CHAT}
						aria-label="Server news to all servers"
						placeholder="Server news to all servers…"
						bind:value={news}
						disabled={sendingNews}
					/>
					<button
						class="btn shrink-0 btn-primary"
						type="submit"
						disabled={!news.trim() || sendingNews}
						>{sendingNews ? 'Sending…' : retryingNews ? 'Retry failed' : 'Send'}</button
					>
				</form>
			{/if}
			{#if data.servers.length > 1}
				<select class="input w-auto pr-[30px] sm:ml-auto" bind:value={sort} aria-label="Sort by">
					<option value="default">Sort: default</option>
					<option value="name">Sort: name</option>
					<option value="players">Sort: most players</option>
					<option value="fill">Sort: fullest</option>
					<option value="map">Sort: map</option>
					<option value="problems">Sort: problems first</option>
				</select>
				{#if filtering}
					<span class="text-[12.5px] text-mist-400">{shown.length} of {data.servers.length}</span>
				{/if}
			{/if}
		</div>
	{/if}
	{#if newsReport?.failed.length && retryingNews}
		<div class="callout mb-4 border-l-danger" role="status">
			<b
				>Not sent to {newsReport.failed.length} server{newsReport.failed.length === 1
					? ''
					: 's'}:</b
			>
			{#each newsReport.failed as failure (failure.id)}
				<div>{failure.name}: {failure.error}</div>
			{/each}
			<p class="note mt-2">
				Retry failed sends only, or change the message to start a new broadcast.
			</p>
		</div>
	{/if}

	{#if !shown.length}
		<div class="callout">
			No servers match. <button
				type="button"
				class="font-semibold text-accent underline"
				onclick={clearFilters}>Clear filters</button
			>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
			{#each shown as s (s.id)}
				{@const sum = summaries[s.id]}
				<a
					href="/server/{encodeURIComponent(s.id)}"
					class="block rise panel transition hover:border-white/16 hover:bg-white/[0.055]"
				>
					<div class="mb-1 flex items-center gap-2">
						<Pulse ok={sum ? sum.ok : undefined} />
						<span class="truncate font-semibold">{s.name}</span>
						<span class="ml-auto"><RoleBadge role={s.roleName} /></span>
					</div>
					<div class="mb-3 font-mono text-[12px] text-mist-400">
						{#if s.host}{s.host}:{s.port}{:else}{s.orgName}{/if}{#if s.demo}&nbsp;· demo{/if}
					</div>
					{#if !sum}
						<div class="text-[13px] text-mist-600">Checking…</div>
					{:else if sum.ok}
						{@const st = sum.status}
						{@const pct = st.maxPlayers
							? Math.min(100, Math.round((st.playerCount / st.maxPlayers) * 100))
							: 0}
						<div class="mb-1 truncate text-[13px] text-mist-400">{st.serverName || '—'}</div>
						<MapArt map={st.map} lighting={st.lighting} variant="wide" alt="" class="mb-2" />
						<div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
							<span class="text-mist-400">Map <b class="text-mist-100">{mapName(st.map)}</b></span>
							{#if st.matchSeconds !== null}<span class="text-mist-400"
									>Match <b class="text-mist-100">{Math.floor(st.matchSeconds / 60)} min</b></span
								>{/if}
							<span class="ml-auto text-mist-400"
								><b class="text-mist-100">{fmtNum(st.playerCount)}</b> / {fmtNum(
									st.maxPlayers
								)}{#if sum.reservedSlots}
									+ {sum.reservedSlots} reserved{/if} players</span
							>
						</div>
						<div class="mb-3 progress"><span class="progress-bar" style="width:{pct}%"></span></div>
						<div class="flex flex-wrap gap-1.5">
							{#each st.scores as f (f.name)}
								<span class="badge bg-white/5" style="color:{f.colorHex || 'inherit'}"
									>{f.name} {fmtNum(f.score)}</span
								>
							{/each}
						</div>
					{:else}
						<div class="text-[13px] text-danger">{sum.error}</div>
					{/if}
				</a>
			{/each}
		</div>
	{/if}
{/if}

{#if newsConfirmation}
	{@const review = newsConfirmation}
	<Modal title="Confirm server news" onclose={() => (newsConfirmation = null)}>
		<p>
			Broadcast this message to {review.targets.length} server{review.targets.length === 1
				? ''
				: 's'} in {data.scope?.name ?? 'all organisations'}?
		</p>
		<div class="mt-3 rounded border border-white/10 bg-white/5 p-3 break-words whitespace-pre-wrap">
			{review.message}
		</div>
		<p class="note mt-3">Servers: {review.targets.map((s) => s.name).join(', ')}</p>
		{#snippet actions()}
			<button type="button" class="btn" data-close onclick={() => (newsConfirmation = null)}
				>Cancel</button
			>
			<button type="button" class="btn btn-primary" onclick={sendNews}
				>Broadcast to {review.targets.length} servers</button
			>
		{/snippet}
	</Modal>
{/if}

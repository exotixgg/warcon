<script lang="ts">
	import { untrack } from 'svelte';
	import type { LiveChatLine } from '$lib/chat-archive';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import ChatHistory from '$lib/components/ChatHistory.svelte';
	import { api, ApiError, rconGet, rconPost, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { fmtTime } from '$lib/format';
	import { identity, throttled } from '$lib/health.svelte';
	import {
		CHAT_PAGE,
		takeRead,
		termsBlocks,
		type ChatLine,
		type ChatRead,
		type ChatTerms
	} from '$lib/chat-read';
	import Badge from '$lib/components/Badge.svelte';
	import type { FactionScore, LiveView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let manager = $derived(data.server.manager);
	let scope = $state(untrack(() => (page.url.searchParams.get('scope') === 'org' ? '' : id)));
	const around = $derived(page.url.searchParams.get('around') ?? '');
	const showLive = $derived(scope === id && !around && data.reachable);
	let configBusy = $state(false);
	async function enableArchive() {
		configBusy = true;
		try {
			await api('PUT', `/api/servers/${encodeURIComponent(id)}/chat-archive`, { enabled: true });
			await invalidateAll();
			toast('Chat history enabled.', 'ok');
		} catch (e) {
			toast(errorMessage(e), 'err');
		} finally {
			configBusy = false;
		}
	}

	/** how often the game is asked for new lines while the tab shows */
	const EVERY_MS = 4000;
	/** pages of a read taken in one go, when a busy server has more than one waiting */
	const MAX_PAGES = 3;
	/** while the terms wait to be accepted, they are read again every so many ticks (20 s) */
	const RECHECK = 5;
	/** the longest the tab waits between tries while its reads keep failing */
	const MAX_WAIT_MS = 60_000;
	/** the game's start, as the worker works it out, wobbles by a second or two between looks */
	const RESTART_MS = 60_000;

	let terms = $state<ChatTerms | null>(null);
	/**
	 * Why the tab has stopped asking: the build serves no chat, the reader may not read it, the
	 * server is no longer theirs to see, or the game rejects the stored password. The panel records
	 * every refusal and every rejected password, in the audit trail and on the organisation's
	 * Discord, so a tab that kept asking would fill both.
	 */
	let closed = $state<'' | 'unserved' | 'forbidden' | 'gone' | 'stopped'>('');
	let problem = $state('');
	/** newest first */
	let lines = $state<LiveChatLine[]>([]);
	let loaded = $state(false);
	let busy = $state(false);
	/** the version an owner accepted here that the server said has yet to take effect */
	let pending = $state(0);
	let latest = 0;
	/** failed reads in a row, and the time before which the tab does not try again */
	let fails = 0;
	let notBefore = 0;

	let picked = $state<ChatLine | null>(null);
	let showTerms = $state(false);

	// The factions' colours, from what the worker last saw of the server: asked once, of the panel
	// alone, so this tab neither sends the game another request nor has the server watched closer.
	let scores = $state<FactionScore[] | null>(null);
	$effect(() => {
		const server = id;
		void api<{ live: Record<string, LiveView> }>(
			'GET',
			`/api/live?ids=${encodeURIComponent(server)}&slim=1`
		)
			.then((d) => (scores = d.live[server]?.status?.scores ?? null))
			.catch(() => (scores = null));
	});

	let blocks = $derived(terms ? termsBlocks(terms.text) : []);

	/** Drops what the tab holds, and the terms too when they may no longer stand. */
	function startOver(andTerms: boolean) {
		lines = [];
		latest = 0;
		picked = null;
		loaded = false;
		if (andTerms) terms = null;
	}

	/** A failed read: what ends the tab's asking, and how long it waits before the next try. */
	function failed(err: unknown) {
		const e = err instanceof ApiError ? err : null;
		// an answer the game gave carries the game's status; the panel's own refusals carry none
		const upstream = (e?.data as { error?: { upstreamStatus?: unknown } } | null)?.error
			?.upstreamStatus;
		const own = upstream === undefined ? e : null;
		problem = errorMessage(err);
		const shut = (why: 'unserved' | 'forbidden' | 'gone' | 'stopped') => {
			closed = why;
			startOver(true);
		};
		if (e?.code === 'no_route') return shut('unserved');
		if (own?.code === 'forbidden' || own?.code === 'api_key_forbidden') return shut('forbidden');
		if (own?.status === 404) return shut('gone');
		// the stored RCON password was rejected: no later try goes better, and each is recorded
		if (upstream === 401) return shut('stopped');
		fails++;
		notBefore = Date.now() + Math.min(EVERY_MS * 2 ** fails, MAX_WAIT_MS);
	}
	function succeeded() {
		problem = '';
		fails = 0;
	}

	async function readTerms() {
		let read: ChatTerms;
		try {
			read = await rconGet<ChatTerms>(id, 'chatTerms');
		} catch (err) {
			return failed(err);
		}
		succeeded();
		terms = read;
		if (read.accepted || read.requiredVersion !== pending) pending = 0;
	}

	async function readChat() {
		for (let page = 0; page < MAX_PAGES; page++) {
			let read: ChatRead;
			try {
				read = await rconGet<ChatRead>(id, 'chat', { after: latest, limit: CHAT_PAGE });
			} catch (err) {
				failed(err);
				// the game's own refusal: its terms stand unaccepted again (withdrawn, or a new version)
				if (!closed && err instanceof ApiError && err.status === 409) startOver(true);
				return;
			}
			succeeded();
			const next = takeRead({ lines, latest }, read);
			// the game numbers its lines from 1 again after a restart: start over with it
			if (next.restarted) startOver(false);
			else {
				const observed = new Date().toISOString();
				lines = (next.lines as LiveChatLine[]).map((l) =>
					l.at || l.observedAt ? l : { ...l, observedAt: observed }
				);
				latest = next.latest;
				loaded = true;
			}
			if (!next.more) return;
		}
	}

	// The game's start, as the layout's live view has it. When it moves on, the game is a new
	// process: it numbers its lines from 1 again and may ask for its terms again. A lower number
	// in a read says the same (takeRead), but not after a restart that passed while this tab was
	// hidden and brought more lines than the tab had read.
	let knownStart = 0;
	function restarted(): boolean {
		const iso = identity[id]?.startedAt ?? data.identity.startedAt;
		const at = iso ? Date.parse(iso) : NaN;
		if (!Number.isFinite(at)) return false;
		const moved = knownStart > 0 && at - knownStart > RESTART_MS;
		knownStart = at;
		return moved;
	}

	let waited = 0;
	async function tick() {
		// not once the tab has stopped, nor before a failed read's wait is up, nor while the game
		// has asked the panel to slow down
		if (closed || Date.now() < notBefore || throttled[id]) return;
		if (restarted()) startOver(true);
		// not accepted yet: look again now and then, for an owner may accept them from another page
		if (!terms || (!terms.accepted && (pending || ++waited % RECHECK === 0))) await readTerms();
		if (!closed && terms?.accepted) await readChat();
	}
	$effect(() => {
		if (showLive) return poll(tick, EVERY_MS);
	});

	function tryAgain() {
		closed = '';
		problem = '';
		fails = 0;
		notBefore = 0;
		void tick();
	}

	async function accept() {
		if (!terms || busy || terms.cut) return;
		const version = terms.requiredVersion;
		if (
			!(await confirmDialog(
				`Accept the chat terms, version ${version}, for ${data.server.name}? You accept them for ${data.server.orgName}, which runs this server. The audit trail records who accepted them and when.`,
				{ okLabel: 'Accept the terms' }
			))
		)
			return;
		busy = true;
		try {
			const done = await rconPost<{ pending?: boolean }>(id, 'chatTermsAccept', { version });
			if (done.pending) pending = version;
			toast(
				done.pending
					? `Chat terms version ${version} accepted. The server says it has yet to take effect.`
					: `Chat terms version ${version} accepted.`,
				'ok'
			);
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
		// what the server says now: accepted, still to take effect, or another version to read
		await readTerms();
		if (!closed && terms?.accepted) await readChat();
	}
</script>

{#snippet termsText()}
	<div class="space-y-2 text-[13.5px] leading-relaxed">
		{#each blocks as b, i (i)}
			{#if 'ul' in b}
				<ul class="list-disc space-y-1 pl-5">
					{#each b.ul as item, k (k)}<li>{item}</li>{/each}
				</ul>
			{:else}
				<p>{b.p}</p>
			{/if}
		{:else}
			<p class="text-mist-400">The server sent no text with its terms.</p>
		{/each}
	</div>
{/snippet}

{#snippet settings()}
	{#if manager && scope === id && !data.archiveEnabled}
		<button class="btn btn-sm" disabled={configBusy} onclick={enableArchive}>
			Enable indefinite chat history
		</button>
	{/if}
{/snippet}

{#snippet notice()}
	{#if !data.reachable}
		<p class="callout">Live chat unavailable. {data.problem}</p>
	{:else if closed === 'unserved'}
		<div class="panel">
			<span class="label-sm">Chat</span>
			<p class="text-[13.5px]">
				This server's build does not serve the in-game chat. It came with Season 3: once the server
				runs that build, the chat shows here.
			</p>
		</div>
	{:else if closed === 'forbidden'}
		<div class="panel">
			<span class="label-sm">Chat</span>
			<p class="text-[13.5px]">
				Reading the in-game chat needs <b>Read chat</b> on this server, which an owner of
				{data.server.orgName} gives to a role.
			</p>
		</div>
	{:else if closed === 'gone'}
		<div class="panel">
			<span class="label-sm">Chat</span>
			<p class="text-[13.5px]">This server is no longer one you can open.</p>
		</div>
	{:else if closed === 'stopped'}
		<div class="panel">
			<span class="label-sm">Chat</span>
			<div class="callout border-danger/30 bg-danger/12">{problem}</div>
			<p class="note">
				The chat is not being read: asking again would only be refused again, and each refusal is
				recorded.
			</p>
			<button class="mt-3 btn btn-sm" onclick={tryAgain}>Try again</button>
		</div>
	{:else if terms && !terms.accepted}
		<div class="max-w-[760px] panel">
			<div class="mb-3 flex flex-wrap items-center gap-3">
				<span class="mr-auto label-sm mb-0">Chat terms</span>
				<Badge tone="warn">not accepted</Badge>
				<span class="font-mono text-[12px] text-mist-400">version {terms.requiredVersion}</span>
			</div>
			<p class="mb-3 text-[13.5px] leading-relaxed">
				The game shows a server's chat only once the terms below have been accepted for it. Until
				then it serves no chat, and it holds back its event feed as well: no kills reach the panel,
				so the kill feed and the rules that go by it stand still.
			</p>
			<div class="rounded-ctl border border-black bg-ink-950 p-4">
				{@render termsText()}
			</div>
			{#if terms.cut}
				<p class="note">
					The server sent more text than the panel shows, so these are not its whole terms and they
					are not accepted from here. Read and accept them in the official RCON console.
				</p>
			{:else if pending === terms.requiredVersion}
				<p class="note">
					Accepted here just now. The server says the acceptance has yet to take effect; this tab
					looks again every few seconds.
				</p>
			{:else if manager}
				<div class="mt-4 flex flex-wrap items-center gap-3">
					<button class="btn btn-primary" disabled={busy} onclick={accept}>Accept the terms</button>
					<span class="text-[12.5px] text-mist-400"
						>For {data.server.orgName}, as an owner of it. The terms are the game's own, as this
						server sent them.</span
					>
				</div>
			{:else}
				<p class="note">
					An owner of {data.server.orgName} accepts them here. It is theirs to do: the terms are an agreement
					of whoever runs the server.
				</p>
			{/if}
		</div>
	{:else if problem}
		<div class="callout border-danger/30 bg-danger/12">{problem}</div>
	{/if}
{/snippet}
{#snippet footer()}
	{#if picked}
		<div class="mt-3 rounded-ctl border border-black bg-ink-950 p-4 text-[13px]">
			<div class="mb-2 flex flex-wrap items-center gap-3">
				<span class="label-sm mb-0">Line {picked.seq}</span>
				<span class="text-mist-400">{picked.at ? fmtTime(picked.at) : '—'}</span>
				<button class="ml-auto btn btn-sm" onclick={() => (picked = null)}>Close</button>
			</div>
			<dl class="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
				<dt class="text-mist-400">Player</dt>
				<dd>
					{picked.name || '—'}
					{#if picked.steamId}
						<a
							class="ml-2 text-accent underline"
							href="/server/{encodeURIComponent(id)}/players/{encodeURIComponent(picked.steamId)}"
							>Player page</a
						>
					{/if}
				</dd>
				<dt class="text-mist-400">Hidden name</dt>
				<dd>
					{#if picked.hiddenName}{picked.hiddenName}
						<span class="text-mist-400"
							>{picked.anonymous
								? '· anonymous mode: the only name other players see'
								: '· not in use: other players see their own name'}</span
						>{:else}<span class="text-mist-400">none sent</span>{/if}
				</dd>
				<dt class="text-mist-400">SteamID</dt>
				<dd class="font-mono text-[12.5px]">
					{#if picked.steamId}{picked.steamId}{:else}<span class="font-sans text-mist-400"
							>none: the game gave this player no platform id</span
						>{/if}
				</dd>
				<dt class="text-mist-400">Faction · channel</dt>
				<dd>{picked.faction || '—'} · {picked.channel || '—'}{picked.ping ? ' · ping' : ''}</dd>
				<dt class="text-mist-400">Seen by players</dt>
				<dd class="break-words">{picked.text}</dd>
				{#if picked.typed}
					<dt class="text-mist-400">Typed</dt>
					<dd class="break-words">{picked.typed}</dd>
				{/if}
			</dl>
		</div>
	{/if}
	<p class="note">
		{#if terms}
			Shown under the game's chat terms, version {terms.acceptedVersion || terms.requiredVersion}:
			<button class="text-accent underline" onclick={() => (showTerms = !showTerms)}
				>{showTerms ? 'hide them' : 'read them'}</button
			>.
		{/if}
	</p>
	{#if showTerms && terms}
		<div class="mt-2 max-w-[760px] rounded-ctl border border-black bg-ink-950 p-4">
			{@render termsText()}
		</div>
	{/if}
{/snippet}

<ChatHistory
	orgId={data.server.orgId}
	serverId={id}
	bind:server={scope}
	initialPlayer={page.url.searchParams.get('player') ?? ''}
	{around}
	live={showLive && terms?.accepted && !closed ? lines : []}
	liveLoading={showLive && !loaded && !problem && !closed && (!terms || terms.accepted)}
	{scores}
	{settings}
	{notice}
	{footer}
	inspect={(line) => (picked = picked?.seq === line.seq ? null : line)}
/>

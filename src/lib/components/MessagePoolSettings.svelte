<script lang="ts">
	import { onMount } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import {
		POOL_ACTIONS,
		POOL_VARIABLES,
		renderPoolMessage,
		validateMessagePools,
		type MessagePool,
		type MessagePoolConfig,
		type PoolAction,
		type WeaponThreshold
	} from '$lib/message-pools';

	let { org }: { org: { id: string; name: string } } = $props();
	type Loaded = {
		config: MessagePoolConfig & { version: string };
		servers: { id: string; name: string }[];
		categories: { id: string; label: string }[];
	};
	let loaded = $state<Loaded | null>(null);
	let busy = $state(false);
	let problem = $state('');
	const url = $derived(`/api/orgs/${encodeURIComponent(org.id)}/message-pools`);
	const label = (action: PoolAction) =>
		({
			join: 'Join whisper',
			round_start: 'Round start',
			round_end: 'Round end',
			ban: 'Ban announcement',
			weapon: 'Weapon rule',
			timer: 'Timed broadcast'
		})[action];
	const sample: Record<string, string | number> = {
		server_name: 'WARDOGS Infantry',
		map: 'Kavkazi',
		players: 64,
		max_players: 100,
		player_name: 'PlayerXY',
		faction: 'Faction',
		welcome_phrase: 'Welcome back',
		server_visit_count: 12,
		exotix_visit_count: 31,
		server_connected_time: '8h 20m',
		exotix_connected_time: '24h 10m',
		winner: 'Faction',
		scores: 'Faction 100 · Rival 85',
		previous_map: 'North America',
		mvp: 'PlayerXY',
		top: 'PlayerXY 18',
		top_kills_name: 'PlayerXY',
		top_kills_count: 18,
		top_cash_name: 'RichPlayer',
		top_cash_gain: 2500,
		best_kd_name: 'PlayerXY',
		best_kd_value: '4.50',
		ban_category: 'Cheating',
		ban_reason: 'Cheating',
		ban_duration: 'Permanent',
		ban_reference: 't-12345',
		victim_name: 'Teammate',
		weapon: 'Id.Item.Example',
		count: 1
	};
	const preview = (pool: MessagePool) =>
		pool.messages[0] ? renderPoolMessage(pool.messages[0], sample) : '';

	async function load() {
		busy = true;
		try {
			loaded = await api<Loaded>('GET', url);
			problem = '';
		} catch (err) {
			problem = errorMessage(err);
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		void load();
	});

	function add(action: PoolAction = 'join') {
		if (!loaded) return;
		const pool: MessagePool = {
			id: crypto.randomUUID(),
			name: `New ${label(action)}`,
			action,
			enabled: action !== 'timer',
			mode: 'ordered',
			messages: ['Welcome to {server_name}, {player_name}!'],
			sendCount: 1,
			initialDelaySeconds: 0,
			spacingSeconds: 10,
			allServers: true,
			serverIds: [],
			onlyFirstVisit: false,
			categoryId: 'general',
			banSources: ['policy', 'legacy', 'automatic'],
			weaponTags: [],
			teamKillsOnly: false,
			thresholds: [{ count: 1, action: 'whisper', days: 1, scope: 'server' }],
			everyMinutes: 10,
			minPlayers: 1,
			maxPlayers: null
		};
		if (action === 'ban')
			pool.messages = ['{player_name} was banned for {ban_category} ({ban_duration}).'];
		if (action === 'weapon')
			pool.messages = ['{player_name}: {weapon} is not allowed on {server_name}.'];
		if (action === 'round_start') pool.messages = ['New round on {map}. Good luck!'];
		if (action === 'round_end') pool.messages = ['Round over: {winner} wins on {previous_map}.'];
		if (action === 'timer') pool.messages = ['Enjoying {server_name}? Invite a friend!'];
		loaded.config.pools = [...loaded.config.pools, pool];
	}
	function setAction(pool: MessagePool, action: PoolAction) {
		pool.action = action;
		pool.enabled = false;
		pool.messages = [''];
	}
	function setAll(pool: MessagePool, all: boolean) {
		pool.allServers = all;
		pool.serverIds = all ? [] : loaded?.servers[0] ? [loaded.servers[0].id] : [];
	}
	function toggleServer(pool: MessagePool, id: string, checked: boolean) {
		pool.serverIds = checked
			? [...pool.serverIds, id]
			: pool.serverIds.filter((value) => value !== id);
	}
	function toggleSource(
		pool: MessagePool,
		source: 'policy' | 'legacy' | 'automatic',
		checked: boolean
	) {
		pool.banSources = checked
			? [...pool.banSources, source]
			: pool.banSources.filter((value) => value !== source);
	}
	function addThreshold(pool: MessagePool) {
		const next = Math.max(0, ...pool.thresholds.map((step) => step.count)) + 1;
		pool.thresholds = [
			...pool.thresholds,
			{ count: next, action: 'whisper', days: 1, scope: 'server' }
		];
	}
	function removeThreshold(pool: MessagePool, step: WeaponThreshold) {
		pool.thresholds = pool.thresholds.filter((value) => value !== step);
	}
	async function save() {
		if (!loaded) return;
		try {
			validateMessagePools(loaded.config);
		} catch (err) {
			toast(errorMessage(err), 'err');
			return;
		}
		busy = true;
		try {
			const answer = await api<{ config: Loaded['config'] }>('PUT', url, loaded.config);
			loaded.config = answer.config;
			toast('Message pools saved.', 'ok');
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

{#if problem}
	<p class="note text-warn">
		{problem} <button class="ml-2 btn btn-sm" onclick={load}>Retry</button>
	</p>
{:else if !loaded}
	<p class="note">Loading message pools…</p>
{:else}
	<p class="note mb-3">
		All servers includes future servers in this organisation. A named-server pool takes precedence
		over an all-server pool for the same action and ban category. Existing automation rules remain
		independent, so disable a matching old rule if you do not want both messages.
	</p>
	<div class="mb-4 flex flex-wrap gap-2">
		{#each POOL_ACTIONS as action}
			<button type="button" class="btn btn-sm" onclick={() => add(action)}>+ {label(action)}</button
			>
		{/each}
	</div>
	{#each loaded.config.pools as pool (pool.id)}
		<details class="mb-3 rounded-ctl border border-black bg-ink-900 p-4">
			<summary class="cursor-pointer font-semibold"
				>{pool.name} · {label(pool.action)} · {pool.enabled ? 'On' : 'Off'}</summary
			>
			<div class="mt-4 grid gap-3 md:grid-cols-2">
				<label class="field-label"
					>Pool name
					<input class="mt-1 input w-full" type="text" maxlength="80" bind:value={pool.name} />
				</label>
				<label class="field-label"
					>Action
					<select
						class="mt-1 input w-full"
						value={pool.action}
						onchange={(event) =>
							setAction(pool, (event.target as HTMLSelectElement).value as PoolAction)}
					>
						{#each POOL_ACTIONS as action}<option value={action}>{label(action)}</option>{/each}
					</select>
				</label>
				<label class="field-label"
					>Selection
					<select class="mt-1 input w-full" bind:value={pool.mode}>
						<option value="ordered">In order</option><option value="random"
							>Random, no immediate repeat</option
						>
					</select>
				</label>
				<label class="field-label flex items-center gap-2 pt-5">
					<input type="checkbox" bind:checked={pool.enabled} /> Enabled
				</label>
			</div>
			<div class="mt-3">
				<label class="field-label flex items-center gap-2">
					<input
						type="checkbox"
						checked={pool.allServers}
						onchange={(event) => setAll(pool, (event.target as HTMLInputElement).checked)}
					/> All servers
				</label>
				{#if !pool.allServers}
					<div class="mt-2 flex flex-wrap gap-3">
						{#each loaded.servers as server}
							<label class="field-label flex items-center gap-2"
								><input
									type="checkbox"
									checked={pool.serverIds.includes(server.id)}
									onchange={(event) =>
										toggleServer(pool, server.id, (event.target as HTMLInputElement).checked)}
								/>
								{server.name}</label
							>
						{/each}
					</div>
				{/if}
			</div>
			{#if pool.action === 'join'}
				<label class="mt-3 field-label flex items-center gap-2">
					<input type="checkbox" bind:checked={pool.onlyFirstVisit} /> First visit only
				</label>
			{:else if pool.action === 'ban'}
				<div class="mt-3 grid gap-3 md:grid-cols-2">
					<label class="field-label"
						>Ban category
						<select class="mt-1 input w-full" bind:value={pool.categoryId}>
							<option value="general">General / uncategorised</option>
							{#each loaded.categories as category}<option value={category.id}
									>{category.label}</option
								>{/each}
						</select>
					</label>
					<div class="field-label">
						Ban sources
						<div class="mt-2 flex flex-wrap gap-3">
							{#each ['policy', 'legacy', 'automatic'] as source}
								<label class="flex items-center gap-2"
									><input
										type="checkbox"
										checked={pool.banSources.includes(source as 'policy' | 'legacy' | 'automatic')}
										onchange={(event) =>
											toggleSource(
												pool,
												source as 'policy' | 'legacy' | 'automatic',
												(event.target as HTMLInputElement).checked
											)}
									/>
									{source}</label
								>
							{/each}
						</div>
					</div>
				</div>
				<p class="note mt-2">
					Announcements are public. Internal case descriptions are never inserted.
				</p>
			{:else if pool.action === 'weapon'}
				<div class="mt-3">
					<label class="field-label"
						>Kill-feed weapon tags, one per line
						<textarea
							class="mt-1 min-h-[75px] input w-full"
							value={pool.weaponTags.join('\n')}
							oninput={(event) =>
								(pool.weaponTags = (event.target as HTMLTextAreaElement).value
									.split('\n')
									.map((v) => v.trim())
									.filter(Boolean))}></textarea>
					</label>
					<label class="mt-2 field-label flex items-center gap-2"
						><input type="checkbox" bind:checked={pool.teamKillsOnly} /> Team kills only</label
					>
					<p class="note mt-1">
						Counts reset each match. Each exact threshold acts once for that player.
					</p>
					{#each pool.thresholds as step, i (i)}
						<div class="mt-2 flex flex-wrap items-end gap-2">
							<label class="field-label"
								>At kill #<input
									class="mt-1 input w-20"
									type="number"
									min="1"
									max="100"
									bind:value={step.count}
								/></label
							>
							<label class="field-label"
								>Action<select class="mt-1 input" bind:value={step.action}>
									<option value="whisper">Whisper</option><option value="kick">Kick</option><option
										value="ban">Ban</option
									>
								</select></label
							>
							{#if step.action === 'ban'}
								<label class="field-label"
									>Days (0 = permanent)<input
										class="mt-1 input w-24"
										type="number"
										min="0"
										max="3650"
										bind:value={step.days}
									/></label
								>
								<label class="field-label"
									>Scope<select class="mt-1 input" bind:value={step.scope}>
										<option value="server">This server</option><option value="org"
											>All organisation servers</option
										>
									</select></label
								>
							{/if}
							<button type="button" class="btn btn-sm" onclick={() => removeThreshold(pool, step)}
								>Remove</button
							>
						</div>
					{/each}
					<button type="button" class="mt-2 btn btn-sm" onclick={() => addThreshold(pool)}
						>+ Threshold</button
					>
				</div>
			{:else if pool.action === 'timer'}
				<div class="mt-3 flex flex-wrap gap-3">
					<label class="field-label"
						>Every minutes<input
							class="mt-1 input w-24"
							type="number"
							min="1"
							max="1440"
							bind:value={pool.everyMinutes}
						/></label
					>
					<label class="field-label"
						>Minimum players<input
							class="mt-1 input w-24"
							type="number"
							min="0"
							max="1000"
							bind:value={pool.minPlayers}
						/></label
					>
					<label class="field-label"
						>Maximum players (blank = no limit)<input
							class="mt-1 input w-28"
							type="number"
							min="0"
							max="1000"
							value={pool.maxPlayers ?? ''}
							oninput={(event) => {
								const value = (event.target as HTMLInputElement).value;
								pool.maxPlayers = value === '' ? null : Number(value);
							}}
						/></label
					>
				</div>
			{/if}
			<div class="mt-4">
				<label class="field-label"
					>Messages, one per line (up to 50)
					<textarea
						class="mt-1 min-h-[110px] input w-full"
						value={pool.messages.join('\n')}
						oninput={(event) =>
							(pool.messages = (event.target as HTMLTextAreaElement).value
								.split('\n')
								.map((v) => v.trim())
								.filter(Boolean))}></textarea>
				</label>
				<p class="note mt-1">
					Placeholders: {POOL_VARIABLES[pool.action].map((v) => `{${v}}`).join(' · ')}
				</p>
				{#if pool.action === 'join'}
					<p class="note mt-1">
						Visit counts include this join. Connected time covers recorded sessions; {`{welcome_phrase}`}
						says Welcome on the first visit and Welcome back later.
					</p>
				{:else if pool.action === 'round_end'}
					<p class="note mt-1">
						Cash gain is the recorded increase in the round. Best K/D needs at least 10 kills.
						Messages using unavailable round stats are skipped.
					</p>
				{/if}
				{#if preview(pool)}<p class="note mt-1">Preview: {preview(pool)}</p>{/if}
			</div>
			<div class="mt-3 flex flex-wrap gap-3">
				<label class="field-label"
					>Messages per event<input
						class="mt-1 input w-24"
						type="number"
						min="1"
						max="5"
						bind:value={pool.sendCount}
					/></label
				>
				<label class="field-label"
					>First delay (seconds)<input
						class="mt-1 input w-24"
						type="number"
						min="0"
						max="300"
						bind:value={pool.initialDelaySeconds}
					/></label
				>
				<label class="field-label"
					>Between messages (seconds)<input
						class="mt-1 input w-24"
						type="number"
						min="0"
						max="300"
						bind:value={pool.spacingSeconds}
					/></label
				>
			</div>
			<div class="mt-4 flex justify-end">
				<button
					type="button"
					class="btn btn-sm"
					onclick={() =>
						loaded &&
						(loaded.config.pools = loaded.config.pools.filter((value) => value.id !== pool.id))}
					>Delete pool</button
				>
			</div>
		</details>
	{/each}
	<div class="flex items-center gap-3">
		<button class="btn btn-primary" disabled={busy} onclick={save}>Save message pools</button>
		<span class="note"
			>Changes are audited. Existing queued messages are checked against current settings before
			delivery.</span
		>
	</div>
{/if}

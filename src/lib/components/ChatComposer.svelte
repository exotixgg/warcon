<script lang="ts">
	import { tick } from 'svelte';
	import { ApiError, errorMessage, rconPost } from '$lib/api';
	import { MAX_CHAT } from '$lib/chat';
	import { watchLive } from '$lib/live';
	import type { ServerInfo, Player } from '$lib/types';
	import SavedMessages from './SavedMessages.svelte';

	let {
		server
	}: {
		server: Pick<ServerInfo, 'id' | 'orgId' | 'orgName' | 'name' | 'manager'>;
	} = $props();
	let busy = $state(false),
		replyName = $state('');
	const inputId = $props.id();
	const modes = ['Server', 'Team', 'Player'] as const;
	let mode = $state<(typeof modes)[number]>('Server');
	let faction = $state(''),
		steamId = $state(''),
		draft = $state('');
	let players = $state<Player[]>([]),
		rosterReady = $state(false);
	let feedback = $state(''),
		failed = $state(false);
	let remaining = $state<string[]>([]);
	const needsRoster = $derived(mode !== 'Server');
	$effect(() => {
		const id = server.id;
		rosterReady = false;
		players = [];
		if (!needsRoster) return;
		let active = true;
		const stop = watchLive([id], (v) => {
			if (!active || v.serverId !== id) return;
			rosterReady = v.ok && !!v.playersAt;
			players = rosterReady
				? v.players
						.filter((p) => /^\d{17}$/.test(p.steamId))
						.sort((a, b) => a.name.localeCompare(b.name) || a.steamId.localeCompare(b.steamId))
				: [];
		});
		return () => {
			active = false;
			stop();
		};
	});
	const teams = $derived(
		[...new Set(players.map((p) => p.faction).filter((f): f is string => !!f))].sort()
	);
	const recipient = $derived(players.find((p) => p.steamId === steamId));
	const ready = $derived(
		!!draft.trim() &&
			(remaining.length > 0 ||
				mode === 'Server' ||
				(mode === 'Player' ? !!recipient : teams.includes(faction)))
	);
	const buttonText = $derived(
		remaining.length
			? `Retry ${remaining.length} unsent`
			: mode === 'Server'
				? 'Broadcast'
				: mode === 'Player'
					? 'Whisper'
					: 'Whisper team'
	);
	export function locked() {
		return busy || !!remaining.length;
	}
	export async function replyTo(id: string, speaker: string) {
		if (locked()) return;
		mode = 'Player';
		steamId = id;
		replyName = speaker;
		feedback = '';
		await tick();
		document.getElementById(inputId)?.focus();
	}
	function changeMode(next: typeof mode) {
		mode = next;
		feedback = '';
	}
	async function send() {
		if (busy || !ready) return;
		const message = draft.trim();
		busy = true;
		feedback = '';
		failed = false;
		try {
			if (mode === 'Team') {
				const result = await rconPost<{ message: string; unsent: string[]; stopped?: string }>(
					server.id,
					'whisperMany',
					remaining.length ? { steamIds: remaining, message } : { faction, message }
				);
				feedback = result.message;
				remaining = result.unsent;
				failed = !!result.stopped;
			} else if (mode === 'Player' && recipient) {
				const name = recipient.name;
				await rconPost(server.id, 'whisper', { steamId, message });
				feedback = `Whisper sent to ${name} on ${server.name}.`;
			} else if (mode === 'Server') {
				await rconPost(server.id, 'broadcast', { message });
				feedback = `Broadcast sent to ${server.name}.`;
			}
			if (!remaining.length) draft = '';
		} catch (err) {
			feedback = errorMessage(err);
			failed = true;
			if (remaining.length && err instanceof ApiError && err.code === 'no_recipients') {
				remaining = [];
				draft = '';
			}
		} finally {
			busy = false;
		}
	}
</script>

<form
	class="space-y-2"
	onsubmit={(e) => {
		e.preventDefault();
		void send();
	}}
>
	<fieldset class="min-w-0 space-y-2" disabled={busy || !!remaining.length}>
		<div class="flex flex-wrap items-center gap-2">
			<div
				role="group"
				aria-label="Message recipient"
				class="inline-flex rounded-ctl border border-white/10 p-0.5"
			>
				{#each modes as m}<button
						type="button"
						class="btn btn-sm"
						class:btn-primary={mode === m}
						aria-pressed={mode === m}
						onclick={() => changeMode(m)}>{m}</button
					>{/each}
			</div>
			{#if mode === 'Team'}
				<select class="input w-auto max-w-full" aria-label="Recipient team" bind:value={faction}>
					<option value=""
						>{!rosterReady
							? 'Waiting for roster…'
							: !teams.length
								? 'No teams online'
								: 'Select a team…'}</option
					>
					{#each teams as team}<option value={team}>{team}</option>{/each}
				</select>
			{:else if mode === 'Player'}
				<select
					class="input w-auto max-w-full"
					aria-label="Recipient player"
					bind:value={steamId}
					onchange={() => {
						replyName = '';
						feedback = '';
					}}
				>
					<option value=""
						>{!rosterReady
							? 'Waiting for roster…'
							: !players.length
								? 'No players online'
								: 'Select an online player…'}</option
					>
					{#if steamId && !recipient}
						<option value={steamId}
							>{replyName || steamId} · {rosterReady ? 'offline' : 'checking roster…'}</option
						>
					{/if}
					{#each players as p (p.steamId)}<option value={p.steamId}>{p.name} · {p.steamId}</option
						>{/each}
				</select>
			{/if}
		</div>
		<SavedMessages
			{server}
			label={mode === 'Server'
				? 'Message to everyone'
				: mode === 'Team'
					? 'Private message to each team member'
					: 'Private message to player'}
			labelFor={inputId}
			{inputId}
			value={draft}
			onpick={(text) => (draft = text)}
			send={buttonText}
		>
			<textarea
				id={inputId}
				class="min-h-14 input resize-y"
				rows="2"
				maxlength={MAX_CHAT}
				placeholder="Write a message…"
				bind:value={draft}></textarea>
		</SavedMessages>
	</fieldset>
	<div class="flex flex-wrap items-center gap-3">
		<span class="mr-auto text-xs text-mist-400" role="status" class:text-danger={failed}
			>{feedback}</span
		>
		{#if remaining.length}<button
				type="button"
				class="btn btn-sm"
				disabled={busy}
				onclick={() => {
					remaining = [];
					draft = '';
					feedback = '';
				}}>Discard unsent</button
			>{/if}
		<button type="submit" class="btn btn-sm btn-primary" disabled={busy || !ready}
			>{busy ? 'Sending…' : buttonText}</button
		>
	</div>
</form>

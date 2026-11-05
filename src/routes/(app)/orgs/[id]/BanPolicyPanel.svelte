<script lang="ts">
	// Fixed moderation categories live beside the legacy ban settings, but do not replace them until
	// an owner explicitly switches this policy on.
	import { invalidateAll } from '$app/navigation';
	import { untrack, type Snippet } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import {
		BAN_CATEGORIES,
		MAX_BAN_ANNOUNCEMENTS,
		PLAYER_MESSAGE_TOKENS,
		unknownBanPolicyTokens,
		type BanPolicy,
		type BanPolicyView
	} from '$lib/ban-policy';

	let {
		org,
		policy,
		owner,
		children
	}: { org: { id: string }; policy: BanPolicyView | null; owner: boolean; children?: Snippet } =
		$props();
	let open = $state(false);
	let busy = $state(false);
	let draft = $state<BanPolicy>(
		untrack(() => (policy ? structuredClone(policy) : { enabled: false, categories: [] }))
	);
	let saved = $state(untrack(() => JSON.stringify(policy)));
	$effect(() => {
		const next = JSON.stringify(policy);
		if (next === saved) return;
		saved = next;
		draft = policy ? structuredClone(policy) : { enabled: false, categories: [] };
	});
	let changed = $derived(JSON.stringify(draft) !== JSON.stringify(policy));
	let unknown = $derived(
		draft.categories.flatMap((item) => [
			...unknownBanPolicyTokens(item.playerMessage),
			...item.announcementMessages.flatMap(unknownBanPolicyTokens)
		])
	);

	function lines(text: string) {
		return text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(0, MAX_BAN_ANNOUNCEMENTS);
	}
	function setLines(index: number, text: string) {
		draft.categories[index].announcementMessages = lines(text);
		draft = { ...draft, categories: [...draft.categories] };
	}
	async function save() {
		busy = true;
		try {
			await api('PATCH', `/api/orgs/${encodeURIComponent(org.id)}`, { banPolicy: draft });
			toast(
				draft.enabled
					? 'Ban policy enabled and saved.'
					: 'Ban policy saved; legacy bans remain in use.',
				'ok'
			);
			await invalidateAll();
			open = false;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<div class="mb-4 panel px-4 py-3.5 sm:px-5">
	<button
		type="button"
		class="flex min-h-6 w-full cursor-pointer items-center gap-3 text-left"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<span class="caps whitespace-nowrap text-mist-400">Moderation settings</span>
		<span class="min-w-0 flex-1 truncate text-[12.5px] text-mist-600"
			>{open
				? ''
				: policy?.enabled
					? 'enabled · fixed EXOTIX categories'
					: 'off · legacy ban reasons remain in use'}</span
		>
		<span class="inline-flex items-center gap-1.5 caps text-mist-400"
			>{open ? 'Close' : owner ? 'Edit' : 'Show'}
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				aria-hidden="true"><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg
			>
		</span>
	</button>

	{#if open}
		{#if !policy}<p class="note mt-3.5">The moderation policy is unavailable for this ban list.</p>
		{:else}
			<form
				class="mt-4 space-y-5"
				onsubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<label class="flex items-start gap-2"
					><input
						type="checkbox"
						class="mt-1"
						disabled={!owner}
						bind:checked={draft.enabled}
					/><span
						><b>Use the EXOTIX moderation policy</b><span class="block text-[12.5px] text-mist-400"
							>New bans use fixed categories and durations. Turning it off restores the legacy
							quick-reason flow; existing cases stay recorded.</span
						></span
					></label
				>
				{#each BAN_CATEGORIES as definition, index (definition.id)}
					{@const item = draft.categories[index]}
					<div class="border-t border-white/5 pt-4">
						<div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
							<h3 class="font-medium">{definition.label}</h3>
							<span class="text-[12.5px] text-mist-600"
								>{definition.durations
									.map((value) =>
										value === 0 ? 'Permanent' : `${value} day${value === 1 ? '' : 's'}`
									)
									.join(' · ')}</span
							>
						</div>
						<p class="note mt-0! mb-3">{definition.description}</p>
						<div class="grid gap-3 lg:grid-cols-2">
							<label class="block"
								><span class="field-label">Player message</span><input
									class="input font-mono text-[12.5px]"
									maxlength="200"
									disabled={!owner}
									bind:value={item.playerMessage}
								/></label
							>
							<div class="grid grid-cols-2 gap-3">
								<label class="block"
									><span class="field-label">Announcement</span><select
										class="input"
										disabled={!owner}
										bind:value={item.announcementEnabled}
										><option value={true}>On</option><option value={false}>Off</option></select
									></label
								><label class="block"
									><span class="field-label">Scope</span><select
										class="input"
										disabled={!owner || definition.id === 'player-review'}
										bind:value={item.announcementScope}
										><option value="origin">Origin server</option><option value="org"
											>All EXOTIX servers</option
										></select
									></label
								>
							</div>
							{#if definition.id === 'player-review'}<p class="note mt-2">
									Player Review announcements stay on the originating server.
								</p>{/if}
						</div>
						<div class="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
							<label class="block"
								><span class="field-label"
									>Announcement pool <span class="text-mist-600 normal-case"
										>one message per line, up to {MAX_BAN_ANNOUNCEMENTS}</span
									></span
								><textarea
									class="min-h-22 input font-mono text-[12.5px]"
									disabled={!owner}
									value={item.announcementMessages.join('\n')}
									oninput={(event) => setLines(index, event.currentTarget.value)}></textarea></label
							><label class="block"
								><span class="field-label">Selection</span><select
									class="input"
									disabled={!owner}
									bind:value={item.announcementMode}
									><option value="ordered">In order</option><option value="random">Random</option
									></select
								></label
							>
						</div>
					</div>
				{/each}
				<p class="note">
					Placeholders: {PLAYER_MESSAGE_TOKENS.map((name) => `{${name}}`).join(' · ')}. Internal
					staff notes can never be inserted into a player message or announcement.
				</p>
				{#if unknown.length}<p class="note text-danger">
						Unknown placeholder{unknown.length === 1 ? '' : 's'}: {[...new Set(unknown)]
							.map((name) => `{${name}}`)
							.join(', ')}.
					</p>{/if}
				{#if owner}<div class="flex justify-end gap-2 border-t border-white/5 pt-4">
						<button
							type="submit"
							class="btn btn-primary"
							disabled={busy || !changed || unknown.length > 0}>Save policy</button
						>
					</div>{/if}
			</form>
		{/if}
		{#if children}<div class="mt-4">{@render children()}</div>{/if}
	{/if}
</div>

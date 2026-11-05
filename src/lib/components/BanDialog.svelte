<script lang="ts">
	// Ban a player: across the whole organisation (the org ban list, pushed to every server) or on
	// one server only. Used from the org ban list page, the players page and the dossier.
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { DEFAULT_BAN_MESSAGE, renderBanMessage } from '$lib/ban-message';
	import { lengthTag, type BanReason } from '$lib/ban-reasons';
	import {
		BAN_CATEGORIES,
		categoryFor,
		durationText,
		playerMessageFor,
		type BanCategoryId,
		type BanPolicyView
	} from '$lib/ban-policy';
	import { describeSync, EXPIRY_OPTIONS, expiryIso } from '$lib/lists';
	import { isSteamId, steamProfiles, type SteamProfile } from '$lib/steam-profiles';
	import type { ListSyncServer, ListSyncSummary } from '$lib/types';
	import Modal from './Modal.svelte';
	import SteamName from './SteamName.svelte';

	let {
		orgId,
		orgName = 'the organisation',
		steamId = '',
		name = '',
		server = null,
		originServers = [],
		canOrg,
		scope: startScope,
		reason: startReason = '',
		banMessage = null,
		banPolicy = null,
		reasons,
		onclose,
		ondone
	}: {
		orgId: string;
		orgName?: string;
		/** fixed when banning a known player; otherwise the dialog asks for one */
		steamId?: string;
		name?: string;
		/** the server the dialog was opened from, if any: offers the "this server only" scope */
		server?: { id: string; name: string } | null;
		/** Servers eligible as the source for a local policy announcement when this opens outside a server. */
		originServers?: { id: string; name: string }[];
		/** may the user write to the org list? */
		canOrg: boolean;
		/** where the dialog starts when both are offered; every server, unless said otherwise */
		scope?: 'org' | 'server';
		/** a reason typed before the dialog opened */
		reason?: string;
		/** the org's ban message, where the page has it: the dialog then shows the text it makes */
		banMessage?: string | null;
		/** The enabled organisation policy replaces legacy quick reasons and expiry choices. */
		banPolicy?: BanPolicyView | null;
		/** the org's quick reasons, the buttons under Reason */
		reasons: BanReason[];
		onclose: () => void;
		ondone: (scope: 'org' | 'server') => unknown;
	} = $props();

	// Initial values only: the dialog is created fresh each time it opens.
	let id = $state(untrack(() => steamId));
	let reason = $state(untrack(() => startReason));
	let expiry = $state('0');
	let custom = $state('');
	let categoryId = $state<BanCategoryId>('rule-violation');
	let days = $state(1);
	let ticketId = $state('');
	let notes = $state('');
	let originServerId = $state(untrack(() => server?.id ?? originServers[0]?.id ?? ''));
	let scope = $state<'org' | 'server'>(
		untrack(() => (canOrg && (startScope !== 'server' || !server) ? 'org' : 'server'))
	);
	let busy = $state(false);
	let policyOn = $derived(!!banPolicy?.enabled);
	let category = $derived(categoryFor(categoryId) ?? BAN_CATEGORIES[0]);
	let policyExpiresAt = $derived(days ? new Date(Date.now() + days * 86400_000) : null);
	let originName = $derived(
		server?.name ?? originServers.find((item) => item.id === originServerId)?.name ?? orgName
	);
	$effect(() => {
		if (policyOn && !category.durations.includes(days)) days = category.durations[0];
		if (policyOn && categoryId === 'player-review') scope = 'org';
	});

	// What the player will be shown, once the org wraps the reason in more than the reason. The
	// uid comes from the entry, which does not exist yet.
	let policyPreview = $derived.by(() => {
		if (!policyOn || !banPolicy) return { text: '', problem: '' };
		try {
			return {
				text: playerMessageFor(banPolicy, categoryId, {
					category: category.label,
					reason: reason.trim(),
					days,
					expiresAt: policyExpiresAt,
					entryId: '000000',
					ticketId: ticketId.trim() || null,
					playerName: name || id.trim() || 'Player',
					source: originName
				}).replaceAll('B-000000', 'B-······'),
				problem: ''
			};
		} catch (err) {
			return { text: '', problem: errorMessage(err) };
		}
	});
	let shown = $derived.by(() => {
		if (policyOn) return policyPreview.text;
		if (!banMessage || banMessage === DEFAULT_BAN_MESSAGE) return '';
		const until = expiryIso(expiry, custom);
		return renderBanMessage(banMessage.replace(/\{uid\}/gi, 'B-······'), {
			entryId: '',
			reason: reason.trim(),
			addedByName: page.data.user?.username ?? '',
			addedAt: new Date(),
			expiresAt: until ? new Date(until) : null
		});
	});

	/** A quick reason fills in its reason and, when it has a length, sets Expires. */
	function pick(r: BanReason) {
		reason = r.reason;
		if (r.days !== null) expiry = String(r.days);
	}

	let who = $derived(name ? `${name} (${steamId})` : steamId || 'a player');
	// A typed id is looked up so the admin sees who they are about to ban.
	let previewId = $derived(steamId ? '' : isSteamId(id.trim()) ? id.trim() : '');
	let preview = $state<SteamProfile | null | undefined>(undefined);
	$effect(() => {
		const want = previewId;
		preview = undefined;
		if (!want) return;
		void steamProfiles([want]).then((r) => {
			if (previewId === want && want in r) preview = r[want];
		});
	});

	async function submit() {
		const target = id.trim();
		if (!/^\d{17}$/.test(target)) {
			toast('Enter a 17-digit SteamID64.', 'err');
			return;
		}
		busy = true;
		try {
			if (policyOn && categoryId === 'player-review' && !canOrg) {
				toast('Player Review requires access to the organisation ban list.', 'err');
				return;
			}
			if (policyOn && policyPreview.problem) {
				toast(policyPreview.problem, 'err');
				return;
			}
			const moderation = policyOn
				? {
						categoryId,
						days,
						ticketId: ticketId.trim(),
						notes: notes.trim(),
						originServerId: originServerId || null
					}
				: undefined;
			if (scope === 'org') {
				const res = await api<{ sync: ListSyncSummary }>(
					'POST',
					`/api/orgs/${encodeURIComponent(orgId)}/lists/ban/entries`,
					{
						steamId: target,
						reason: reason.trim(),
						expiresAt: policyOn
							? (policyExpiresAt?.toISOString() ?? null)
							: expiryIso(expiry, custom),
						...(moderation ? { moderation } : {})
					}
				);
				toast(describeSync(res.sync, `Banned ${target} across ${orgName}.`), 'ok', 8000);
			} else if (server) {
				const res = await api<{ sync: ListSyncServer }>(
					'POST',
					`/api/servers/${encodeURIComponent(server.id)}/lists/ban/entries`,
					{
						steamId: target,
						reason: reason.trim(),
						expiresAt: policyOn
							? (policyExpiresAt?.toISOString() ?? null)
							: expiryIso(expiry, custom),
						...(moderation ? { moderation } : {})
					}
				);
				// The game only bans a connected player; the list keeps the ban for when they join.
				toast(
					res.sync.ok && res.sync.failed
						? `${target} is not on ${server.name} right now: they are banned the moment they join.`
						: describeSync({ servers: [res.sync] }, `Banned ${target} on ${server.name}.`),
					'ok',
					8000
				);
			}
			await ondone(scope);
			onclose();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<Modal title="Ban {who}" {onclose}>
	<form
		class="space-y-3"
		onsubmit={(e) => {
			e.preventDefault();
			void submit();
		}}
	>
		{#if !steamId}
			<label class="block"
				><span class="field-label">SteamID64</span><input
					class="input font-mono"
					type="text"
					inputmode="numeric"
					placeholder="7656119…"
					maxlength="17"
					bind:value={id}
					required
				/></label
			>
			{#if previewId && preview}
				<div class="mt-1.5 text-[12.5px]"><SteamName profile={preview} /></div>
			{:else if previewId && preview === null}
				<div class="mt-1.5 text-[12.5px] text-mist-600">No Steam profile for that id.</div>
			{/if}
		{/if}

		{#if server && canOrg && !(policyOn && categoryId === 'player-review')}
			<fieldset class="space-y-1.5">
				<legend class="field-label">Where</legend>
				<label class="flex items-start gap-2">
					<input type="radio" class="mt-1" bind:group={scope} value="org" />
					<span
						><b>Every server in {orgName}</b>
						<span class="block text-[12.5px] text-mist-400"
							>Goes on the organisation's ban list and is pushed to all its servers, now and in
							future.</span
						></span
					>
				</label>
				<label class="flex items-start gap-2">
					<input type="radio" class="mt-1" bind:group={scope} value="server" />
					<span
						><b>{server.name} only</b>
						<span class="block text-[12.5px] text-mist-400"
							>Goes on this server's own ban list. If the player is not connected, they are banned
							the moment they join.</span
						></span
					>
				</label>
			</fieldset>
		{:else if policyOn && categoryId === 'player-review'}
			<p class="note">
				Player Review is always permanent and applies across {orgName}. Its announcement stays on
				the originating server.
			</p>
		{:else if server}
			<p class="note">
				Goes on {server.name}'s own ban list. If the player is not connected, they are banned the
				moment they join.
			</p>
		{/if}

		{#if policyOn}
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="block"
					><span class="field-label">Category</span><select class="input" bind:value={categoryId}>
						{#each BAN_CATEGORIES as item (item.id)}<option
								value={item.id}
								disabled={item.id === 'player-review' && !canOrg}>{item.label}</option
							>{/each}
					</select></label
				>
				<label class="block"
					><span class="field-label">Duration</span><select
						class="input"
						bind:value={days}
						disabled={category.durations.length === 1}
					>
						{#each category.durations as value (value)}<option {value}>{durationText(value)}</option
							>{/each}
					</select></label
				>
			</div>
			<p class="note mt-0!">{category.description}</p>
			{#if !server}
				<label class="block"
					><span class="field-label"
						>Originating server <span class="text-mist-600 normal-case"
							>for local announcements</span
						></span
					><select class="input" bind:value={originServerId} disabled={!originServers.length}
						><option value="">No originating server</option
						>{#each originServers as item (item.id)}<option value={item.id}>{item.name}</option
							>{/each}</select
					></label
				>
				{#if !originServers.length}<p class="note mt-0!">
						No originating server is available, so origin-only announcements will not be sent.
					</p>{/if}
			{/if}
		{/if}

		<label class="block"
			><span class="field-label">{policyOn ? 'Public reason' : 'Reason'}</span><input
				class="input"
				type="text"
				placeholder={policyOn ? category.label : "Optional, shown in the server's ban list"}
				maxlength="200"
				bind:value={reason}
				required={policyOn}
			/></label
		>
		{#if !policyOn && reasons.length}
			<div class="flex flex-wrap gap-1.5">
				{#each reasons as r (r.label)}
					<button
						type="button"
						class="chip cursor-pointer hover:bg-white/12 {reason === r.reason ? 'text-accent' : ''}"
						title={r.reason}
						onclick={() => pick(r)}
						>{r.label}{#if r.days !== null}<span class="text-mist-400"
								>&nbsp;{lengthTag(r.days)}</span
							>{/if}</button
					>
				{/each}
			</div>
		{/if}

		{#if policyOn}
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="block"
					><span class="field-label"
						>Ticket ID <span class="text-mist-600 normal-case">optional</span></span
					><input
						class="input font-mono"
						type="text"
						inputmode="numeric"
						maxlength="5"
						placeholder="01234"
						bind:value={ticketId}
					/></label
				>
				<label class="block"
					><span class="field-label"
						>Internal notes <span class="text-mist-600 normal-case">private</span></span
					><input
						class="input"
						type="text"
						maxlength="10000"
						placeholder="Visible only to ban-list staff"
						bind:value={notes}
					/></label
				>
			</div>
		{:else}
			<div class="flex flex-wrap gap-3">
				<label class="block sm:w-48"
					><span class="field-label">Expires</span><select class="input" bind:value={expiry}>
						{#each EXPIRY_OPTIONS as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select></label
				>
				{#if expiry === 'custom'}
					<label class="block sm:flex-1"
						><span class="field-label">Until (local time)</span><input
							class="input"
							type="datetime-local"
							bind:value={custom}
							required
						/></label
					>
				{/if}
			</div>
		{/if}

		{#if shown}
			<div>
				<span class="field-label">The player is shown</span>
				<div
					class="rounded-ctl border border-black bg-ink-950 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed break-words"
				>
					{shown}
				</div>
				<p class="note">
					{policyOn ? `From ${category.label}'s player message.` : `From ${orgName}'s ban message.`}
				</p>
			</div>
		{/if}
		{#if policyOn && policyPreview.problem}<p class="note text-danger">
				{policyPreview.problem}
			</p>{/if}

		<div class="flex justify-end gap-2 pt-2">
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-danger" disabled={busy}>Ban</button>
		</div>
	</form>
</Modal>

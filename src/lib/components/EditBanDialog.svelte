<script lang="ts">
	// Change the reason or the expiry of a ban the panel holds, on the organisation's list or on a
	// server's own. Who placed it and when stay as they are.
	import { untrack } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { toDatetimeLocal } from '$lib/format';
	import { EXPIRY_OPTIONS, expiryIso } from '$lib/lists';
	import { categoryFor, durationText, type BanCaseView } from '$lib/ban-policy';
	import Modal from './Modal.svelte';

	let {
		path,
		who,
		placed,
		reason: reasonNow,
		expiresAt,
		banCase = null,
		onclose,
		ondone
	}: {
		/** the entry's API path: the org's list or the server's own */
		path: string;
		who: string;
		/** one line on where the ban is, who placed it and when */
		placed: string;
		reason: string;
		expiresAt: string | null;
		/** Private policy metadata, supplied only to a ban-list editor. */
		banCase?: BanCaseView | null;
		onclose: () => void;
		ondone: () => unknown;
	} = $props();

	// Initial values only: the dialog is created fresh each time it opens.
	let reason = $state(untrack(() => reasonNow));
	let expiry = $state(untrack(() => (expiresAt ? 'custom' : '0')));
	let custom = $state(untrack(() => toDatetimeLocal(expiresAt)));
	let days = $state(untrack(() => banCase?.days ?? 0));
	let ticketId = $state(untrack(() => banCase?.ticketId ?? ''));
	let notes = $state(untrack(() => banCase?.notes ?? ''));
	let normalizedTicketId = $derived(ticketId.trim().replace(/^t-/i, ''));
	let policyCategory = $derived(banCase ? categoryFor(banCase.categoryId) : undefined);
	// The expiry goes out only when it was touched: the form holds it to the minute, and a ban
	// already past it would be refused as not in the future.
	const expiryWas = untrack(() => [expiry, custom].join());
	let busy = $state(false);

	async function submit() {
		busy = true;
		try {
			await api('PATCH', path, {
				reason: banCase ? reasonNow : reason.trim(),
				...(banCase
					? {
							moderation: {
								categoryId: banCase.categoryId,
								days,
								ticketId: normalizedTicketId,
								notes: notes.trim(),
								originServerId: banCase.originServerId
							}
						}
					: [expiry, custom].join() === expiryWas
						? {}
						: { expiresAt: expiryIso(expiry, custom) })
			});
			toast(`Ban on ${who} changed.`, 'ok');
			await ondone();
			onclose();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<Modal title="Edit ban: {who}" {onclose}>
	<form
		class="space-y-3"
		onsubmit={(e) => {
			e.preventDefault();
			void submit();
		}}
	>
		<p class="note mt-0!">{placed} Who placed it and when stay as they are.</p>
		{#if banCase}
			<div class="rounded-ctl border border-black bg-ink-950 px-3.5 py-3 text-[12.5px]">
				<div class="mb-2 caps text-mist-600">Private case record</div>
				<div><b>{banCase.category}</b> · original duration {durationText(banCase.days)}</div>
			</div>
		{/if}
		{#if !banCase}<label class="block"
				><span class="field-label">Reason</span><input
					class="input"
					type="text"
					maxlength="200"
					bind:value={reason}
				/></label
			>
		{/if}
		{#if banCase && policyCategory}
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="block"
					><span class="field-label">Duration</span><select
						class="input"
						bind:value={days}
						disabled={policyCategory.durations.length === 1}
						>{#each policyCategory.durations as value (value)}<option {value}
								>{durationText(value)}</option
							>{/each}</select
					></label
				>
				<label class="block"
					><span class="field-label"
						>Ticket <span class="text-mist-600 normal-case">optional</span></span
					><span class="flex"
						><span
							class="rounded-l-ctl border border-r-0 border-black bg-ink-950 px-3 py-2 font-mono text-[12.5px] text-mist-400"
							>t-</span
						><input
							class="input rounded-l-none font-mono"
							type="text"
							inputmode="numeric"
							maxlength="7"
							placeholder="XXXXX"
							value={normalizedTicketId}
							oninput={(event) => (ticketId = event.currentTarget.value.replace(/^t-/i, ''))}
						/></span
					></label
				>
			</div>
			<div>
				<span class="field-label">The player is shown</span>
				<div
					class="rounded-ctl border border-black bg-ink-950 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed break-words"
				>
					{banCase.playerMessage}
				</div>
			</div>
			<label class="block"
				><span class="field-label"
					>Internal notes <span class="text-mist-600 normal-case">private</span></span
				><textarea class="min-h-28 input" maxlength="10000" bind:value={notes}></textarea></label
			>
			<p class="note mt-0!">
				Keeping the same duration preserves this ban's current expiry. Choosing another approved
				duration starts that duration from now.
			</p>
		{:else if !banCase}
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
		<div class="flex justify-end gap-2 pt-2">
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
		</div>
	</form>
</Modal>

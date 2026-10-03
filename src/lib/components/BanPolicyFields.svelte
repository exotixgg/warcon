<script lang="ts">
	import { banCaseMessage, durationLabel, type BanPolicyView } from '$lib/exotix/ban-policy';
	let {
		policy,
		categoryId = $bindable(''),
		levelId = $bindable(''),
		ticketId = $bindable(''),
		description = $bindable('')
	}: {
		policy: BanPolicyView;
		categoryId?: string;
		levelId?: string;
		ticketId?: string;
		description?: string;
	} = $props();
	let category = $derived(policy.categories.find((c) => c.id === categoryId));
	let level = $derived(category?.levels.find((l) => l.id === levelId));
	let message = $derived(
		category && level && /^\d{5}$/.test(ticketId)
			? banCaseMessage(
					category.label,
					level.days,
					`t-${ticketId}`,
					policy.appealText,
					policy.messageTemplate
				)
			: 'Choose a reason, severity and five-digit ticket.'
	);
</script>

<label class="block"
	><span class="field-label">Reason</span>
	<select class="input" bind:value={categoryId} required onchange={() => (levelId = '')}>
		<option value="" disabled>Choose a reason…</option>
		{#each policy.categories as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
	</select>
</label>
{#if category}<p class="note">{category.description}</p>{/if}
<label class="block"
	><span class="field-label">Severity and duration</span>
	<select class="input" bind:value={levelId} disabled={!category} required>
		<option value="" disabled>Review the history and choose severity…</option>
		{#each category?.levels ?? [] as l (l.id)}<option value={l.id}
				>{l.label} — {durationLabel(l.days)}</option
			>{/each}
	</select>
</label>
<label class="block"
	><span class="field-label">Discord TicketID</span><input
		class="input font-mono"
		type="text"
		inputmode="numeric"
		pattern={'[0-9]{5}'}
		minlength="5"
		maxlength="5"
		placeholder="12345"
		bind:value={ticketId}
		required
	/></label
>
<label class="block"
	><span class="field-label">Internal description</span><textarea
		class="min-h-24 input"
		maxlength="10000"
		bind:value={description}
		placeholder="Evidence, context and moderator notes. Stored privately; never sent to the player."
		required></textarea></label
>
<div>
	<span class="field-label">Player message</span>
	<div class="rounded-ctl border border-black bg-ink-950 px-3 py-2 font-mono text-sm break-words">
		{message}
	</div>
	<p class="note">
		{category && level && /^\d{5}$/.test(ticketId)
			? `${message.length}/200 characters. `
			: ''}Internal notes are excluded. Duration is fixed by the policy.
	</p>
</div>
<p class="note">
	Use existing history to assess severity. Player review is a permanent restriction pending a human
	review, not a confirmed cheating finding.
</p>

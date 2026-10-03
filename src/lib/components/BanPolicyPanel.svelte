<script lang="ts">
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import {
		DEFAULT_BAN_POLICY,
		DEFAULT_POLICY_MESSAGE,
		EXPIRY_POLICY_MESSAGE,
		POLICY_MESSAGE_VARS,
		banCaseMessage,
		durationLabel,
		validateBanPolicy,
		type BanPolicyView
	} from '$lib/exotix/ban-policy';
	let { orgId, owner = false }: { orgId: string; owner?: boolean } = $props();
	let policy = $state<BanPolicyView | null>(null);
	let problem = $state('');
	let editing = $state(false);
	let busy = $state(false);
	let messageField = $state<HTMLInputElement>();
	function insert(name: string) {
		if (!messageField) return;
		const at = messageField.selectionStart ?? messageField.value.length;
		messageField.setRangeText(`{${name}}`, at, messageField.selectionEnd ?? at, 'end');
		messageField.dispatchEvent(new Event('input', { bubbles: true }));
		messageField.focus();
	}
	let samples = $derived.by(() => {
		if (!policy) return [];
		const reason = policy.categories[0]?.label ?? 'Rule violation';
		return [
			['Manual ticket', 7, 't-12345'],
			['Automated case', 0, 'a-0000001']
		].map(([label, days, reference]) => {
			try {
				const message = banCaseMessage(
					reason,
					Number(days),
					String(reference),
					policy!.appealText,
					policy!.messageTemplate,
					Number(days) ? new Date('2026-10-23T17:30:00Z') : null
				);
				return { label: String(label), message, error: false };
			} catch (e) {
				return { label: String(label), message: errorMessage(e), error: true };
			}
		});
	});
	let path = $derived(`/api/orgs/${encodeURIComponent(orgId)}/ban-policy`);
	async function load() {
		try {
			policy = (await api<{ policy: BanPolicyView }>('GET', path)).policy;
			problem = '';
		} catch (e) {
			problem = errorMessage(e);
		}
	}
	$effect(() => {
		void orgId;
		void load();
	});
	async function save() {
		if (!policy) return;
		busy = true;
		try {
			validateBanPolicy(policy);
			policy = (await api<{ policy: BanPolicyView }>('PATCH', path, policy)).policy;
			editing = false;
			toast('Ban policy saved.', 'ok');
		} catch (e) {
			toast(errorMessage(e), 'err');
		} finally {
			busy = false;
		}
	}
	function addCategory() {
		if (!policy) return;
		let n = 1;
		while (policy.categories.some((c) => c.id === `category-${n}`)) n++;
		policy.categories.push({
			id: `category-${n}`,
			label: 'New category',
			description: 'Describe the conduct and evidence required.',
			action: 'ban',
			levels: [{ id: 'standard', label: 'Standard', days: 7 }]
		});
	}
	let draggedCategoryId = $state<string | null>(null);
	function moveCategory(targetId: string) {
		if (!policy || !draggedCategoryId || draggedCategoryId === targetId) return;
		const categories = [...policy.categories];
		const from = categories.findIndex((category) => category.id === draggedCategoryId);
		const to = categories.findIndex((category) => category.id === targetId);
		if (from < 0 || to < 0) return;
		categories.splice(to, 0, ...categories.splice(from, 1));
		policy.categories = categories;
		draggedCategoryId = null;
	}
</script>

<details class="mb-4 rounded-ctl border border-black bg-ink-950 p-4">
	<summary class="cursor-pointer font-semibold"
		>Ban policy matrix {#if policy}— {policy.enabled ? 'enabled' : 'disabled'}{/if}</summary
	>
	{#if problem}<p class="mt-3 text-danger">{problem}</p>
		<button class="btn" onclick={load}>Retry</button>
	{:else if !policy}<p class="note">Loading policy…</p>
	{:else}
		<p class="note mt-3">
			Suggested community policy. Review durations and evidence standards before enabling. History
			remains in the existing ban records; severity is selected by a moderator.
		</p>
		{#if owner && !editing}<button class="mb-3 btn" onclick={() => (editing = true)}
				>Configure policy</button
			>{/if}
		{#if owner && editing}
			<label class="mb-4 flex gap-2"
				><input type="checkbox" bind:checked={policy.enabled} /> Require policy, TicketID and internal
				description for new manual bans</label
			>
			<label class="mb-4 block"
				><span class="field-label">Standard appeal text</span><input
					class="input"
					maxlength="150"
					bind:value={policy.appealText}
				/></label
			>
			<label class="mb-2 block">
				<span class="field-label">Player message template</span>
				<input
					class="input font-mono"
					maxlength="200"
					bind:this={messageField}
					bind:value={policy.messageTemplate}
				/>
			</label>
			<div class="flex flex-wrap items-center gap-1">
				<span class="note mr-1">Insert</span>
				{#each POLICY_MESSAGE_VARS as name (name)}
					<button
						class="chip cursor-pointer"
						title="Insert {'{' + name + '}'} at the caret"
						onclick={() => insert(name)}>{'{' + name + '}'}</button
					>
				{/each}
				<button
					class="btn btn-sm"
					onclick={() => {
						if (policy) policy.messageTemplate = DEFAULT_POLICY_MESSAGE;
					}}>Reset template</button
				>
				<button
					class="btn btn-sm"
					onclick={() => {
						if (policy) policy.messageTemplate = EXPIRY_POLICY_MESSAGE;
					}}>Use expiry template</button
				>
			</div>
		{/if}
		{#if owner}
			<p class="note mt-3">
				<span class="font-mono">{'{reference}'}</span> is the ticket or automation reference: t-12345
				for manual bans, a-0000001 for automated bans. Reason, duration, reference and appeal are required.
				Internal descriptions are never available as placeholders.
			</p>
			<p class="note">
				<span class="font-mono">{'{unban_at}'}</span> optionally adds the exact expiry, for example 23.10.26
				17:30 UTC, or Permanent for bans without an expiry. The settings preview uses an example date;
				actual bans use their saved expiry.
			</p>
			<div class="my-3 space-y-2 rounded-ctl border border-black bg-ink-950 p-3">
				{#each samples as sample (sample.label)}
					<div>
						<span class="field-label">{sample.label}</span>
						<div class="font-mono text-sm break-words" class:text-danger={sample.error}>
							{sample.message}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<p class="note">
				Policy configuration is managed in Admin settings or by organisation owners in Settings.
			</p>
		{/if}
		<div class="space-y-4">
			{#each policy.categories as c, i (c.id)}
				<div
					class="border-t border-white/10 pt-3"
					role="listitem"
					ondragover={(event) => event.preventDefault()}
					ondrop={(event) => {
						event.preventDefault();
						moveCategory(c.id);
					}}
				>
					{#if owner && editing}
						<span
							class="mb-2 inline-block cursor-grab text-sm"
							draggable="true"
							role="button"
							tabindex="0"
							aria-label="Drag to reorder {c.label}"
							ondragstart={(event) => {
								draggedCategoryId = c.id;
								event.dataTransfer?.setData('text/plain', c.id);
							}}
							ondragend={() => (draggedCategoryId = null)}>↕ Drag to reorder</span
						>
						<label
							><span class="field-label">Reason</span><input
								class="input"
								maxlength="80"
								bind:value={c.label}
							/></label
						>
						<label
							><span class="field-label">Conduct / evidence guidance</span><textarea
								class="input"
								maxlength="600"
								bind:value={c.description}></textarea></label
						>
						<label
							><span class="field-label">Action</span><select
								class="input"
								bind:value={c.action}
								disabled={c.id === 'player-review' || c.id === 'cheating'}
								onchange={() =>
									(c.levels =
										c.action === 'review'
											? [{ id: 'pending', label: 'Pending review', days: 0 }]
											: [{ id: 'standard', label: 'Standard', days: c.id === 'cheating' ? 0 : 7 }])}
								><option value="ban">Ban by severity</option><option value="review"
									>Permanent ban pending review</option
								></select
							></label
						>
						{#each c.levels as l, j (l.id)}
							<div class="mt-2 flex flex-wrap items-end gap-2">
								<label class="flex-1"
									><span class="field-label">Severity</span><input
										class="input"
										maxlength="100"
										bind:value={l.label}
									/></label
								><label
									><span class="field-label">Days (0 = permanent)</span><input
										class="input w-32"
										type="number"
										min="0"
										max="3650"
										step="1"
										bind:value={l.days}
									/></label
								><button
									class="btn"
									disabled={c.levels.length === 1}
									onclick={() => c.levels.splice(j, 1)}>Remove level</button
								>
							</div>
						{/each}
						{#if c.action === 'ban'}<button
								class="mt-2 btn"
								disabled={c.levels.length >= 4}
								onclick={() =>
									c.levels.push({ id: `level-${Date.now()}`, label: 'New severity', days: 7 })}
								>Add severity</button
							>{/if}
						<button
							class="mt-2 btn"
							disabled={policy.categories.length === 1}
							onclick={() => policy?.categories.splice(i, 1)}>Remove category</button
						>
					{:else}
						<div class="font-semibold">{c.label}</div>
						<p class="note">{c.description}</p>
						<div class="flex flex-wrap gap-2">
							{#each c.levels as l (l.id)}<span class="chip"
									>{l.label}: {durationLabel(l.days)}</span
								>{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if owner && editing}<div class="mt-4 flex flex-wrap gap-2">
				<button class="btn" disabled={busy || policy.categories.length >= 12} onclick={addCategory}
					>Add category</button
				><button
					class="btn"
					disabled={busy}
					onclick={() => {
						if (policy) policy.categories = structuredClone(DEFAULT_BAN_POLICY.categories);
					}}>Use suggested matrix</button
				><button
					class="btn"
					disabled={busy}
					onclick={async () => {
						await load();
						editing = false;
					}}>Cancel</button
				><button class="btn btn-primary" disabled={busy} onclick={save}>Save policy</button>
			</div>{/if}
		<p class="note mt-3">
			Existing bans retain their message and enforcement when the module is disabled.
			Legacy/imported bans remain unchanged. Automatic bans receive an a- reference and internal
			rule context.
		</p>
		<p class="note">Player message ends with: {policy.appealText}</p>
	{/if}
</details>

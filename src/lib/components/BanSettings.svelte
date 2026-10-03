<script lang="ts">
	import BanPolicyPanel from './BanPolicyPanel.svelte';
	import BanMessagePanel from '../../routes/(app)/orgs/[id]/BanMessagePanel.svelte';
	let { org }: { org: { id: string; banMessage: string } } = $props();
</script>

<BanPolicyPanel orgId={org.id} owner={true} />
<details class="mt-4">
	<summary class="cursor-pointer text-mist-400">Legacy ban message</summary>
	<p class="my-3 note">
		Used when the policy module is disabled. Policy bans use the player message template above.
		Existing cases keep their saved messages.
	</p>
	<BanMessagePanel {org} banMessage={org.banMessage} owner={true} />
</details>

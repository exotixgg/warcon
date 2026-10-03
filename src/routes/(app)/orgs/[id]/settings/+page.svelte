<script lang="ts">
	import BanSettings from '$lib/components/BanSettings.svelte';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<h2 class="text-lg font-semibold">Ban policy and messages</h2>
<p class="note mb-4">Only organisation owners and the site owner can change these settings.</p>
<BanSettings org={data.banOrganization} />

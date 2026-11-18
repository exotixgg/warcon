<script lang="ts">
	import ChatHistory from '$lib/components/ChatHistory.svelte';
	import { page } from '$app/state';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Chat logs · {data.chatOrg.name} · Warcon</title></svelte:head>
<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
	<h1 class="text-2xl font-semibold">{data.chatOrg.name} · Chat logs</h1>
	<a class="btn btn-sm" target="_blank" rel="noopener" href={page.url.pathname + page.url.search}
		>Open in new window ↗</a
	>
</div>
{#key page.url.pathname + page.url.search}
	<ChatHistory orgId={data.chatOrg.id} initialPlayer={page.url.searchParams.get('player') ?? ''} />
{/key}

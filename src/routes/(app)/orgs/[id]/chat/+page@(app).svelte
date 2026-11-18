<script lang="ts">
	import ChatHistory from '$lib/components/ChatHistory.svelte';
	import { page } from '$app/state';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Chat logs · {data.chatOrg.name} · Warcon</title></svelte:head>
{#key page.url.pathname + page.url.search}
	<ChatHistory orgId={data.chatOrg.id} initialPlayer={page.url.searchParams.get('player') ?? ''} />
{/key}

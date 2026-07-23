import type { MattermostPostList } from "../mattermost/schemas.ts";
import {
	type MattermostSubject,
	mergeRemoteSearchCandidate,
	mergeThreadCandidates,
	type RetrievalProbe,
	type RoutedConversation,
	remoteSearchCandidate,
	type ThreadCandidate,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { deadlineReached } from "../shared/limits.ts";
import type { MattermostStore } from "../store/index.ts";
import { indexedPost, isRecoverableRemoteError } from "./helpers.ts";
import type { ContextClient, RemoteSearchEvidence } from "./types.ts";

const MAX_REMOTE_SEARCH_PROBES = 4;
const MAX_REMOTE_POSTS_PER_PROBE = 20;
const MAX_REMOTE_CANDIDATE_THREADS = 12;

export async function searchRemoteCandidates(
	teamId: string,
	searchTeamPosts: NonNullable<ContextClient["searchTeamPosts"]>,
	probes: readonly RetrievalProbe[],
	conversations: readonly RoutedConversation[],
	options: {
		deadlineAt?: number;
		incomplete?: { value: boolean };
	} = {},
): Promise<{
	candidates: ThreadCandidate[];
	queries: RemoteSearchEvidence["queries"];
	failures: number;
}> {
	const byConversationId = new Map(
		conversations.map((conversation) => [conversation.id, conversation]),
	);
	const byThreadId = new Map<string, ThreadCandidate>();
	const queries: RemoteSearchEvidence["queries"] = [];
	let failures = 0;
	for (const probe of probes.slice(0, MAX_REMOTE_SEARCH_PROBES)) {
		if (deadlineReached(options.deadlineAt)) {
			if (options.incomplete) options.incomplete.value = true;
			break;
		}
		let response: MattermostPostList;
		try {
			response = await searchTeamPosts(teamId, {
				terms: probe.value,
				isOrSearch: false,
				page: 0,
				perPage: MAX_REMOTE_POSTS_PER_PROBE,
			});
		} catch {
			failures += 1;
			queries.push({
				probe: probe.value,
				...(probe.kind ? { probeKind: probe.kind } : {}),
				returnedPosts: 0,
				acceptedPosts: 0,
			});
			continue;
		}
		let acceptedPosts = 0;
		for (const [index, postId] of response.order
			.slice(0, MAX_REMOTE_POSTS_PER_PROBE)
			.entries()) {
			const post = response.posts[postId];
			if (!post || post.delete_at) continue;
			const conversation = byConversationId.get(post.channel_id);
			if (!conversation) continue;
			const indexed = indexedPost(post);
			const existing = byThreadId.get(indexed.threadId);
			acceptedPosts += 1;
			const candidate = remoteSearchCandidate(
				indexed,
				conversation,
				probe.value,
				index + 1,
				probe.kind,
			);
			if (!existing) {
				byThreadId.set(candidate.threadId, candidate);
				continue;
			}
			mergeRemoteSearchCandidate(existing, candidate, conversation);
		}
		queries.push({
			probe: probe.value,
			...(probe.kind ? { probeKind: probe.kind } : {}),
			returnedPosts: response.order.length,
			acceptedPosts,
		});
	}
	return {
		candidates: mergeThreadCandidates([...byThreadId.values()]).slice(
			0,
			MAX_REMOTE_CANDIDATE_THREADS,
		),
		queries,
		failures,
	};
}

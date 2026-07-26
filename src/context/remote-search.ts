import type { MattermostConfig } from "../config/config.ts";
import type { MattermostPostList } from "../mattermost/schemas.ts";
import {
	mergeRemoteSearchCandidate,
	mergeThreadCandidates,
	type RetrievalProbe,
	type RoutedConversation,
	remoteSearchCandidate,
	type ThreadCandidate,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { deadlineReached } from "../shared/limits.ts";
import { indexedPost } from "./helpers.ts";
import type { ContextClient, RemoteSearchEvidence } from "./types.ts";
import { remoteSearchFailureWarning } from "./warnings.ts";

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

/**
 * One bounded remote-search pass with its evidence record, shared by the
 * explicit `--remote-search` call and the automatic stale-index top-up.
 *
 * Both call sites used to inline the same nine-line evidence literal and the
 * same failure warning, which is how they drifted apart on `requested`.
 */
export async function runRemoteSearchPass(input: {
	config: MattermostConfig;
	client: ContextClient;
	probes: readonly RetrievalProbe[];
	conversations: readonly RoutedConversation[];
	deadlineAt: number;
	incomplete: { value: boolean };
	/** `explicit` for a caller-requested pass; otherwise the automatic cause. */
	reason: NonNullable<RemoteSearchEvidence["reason"]>;
	warnings: Warning[];
}): Promise<{
	remoteSearch: RemoteSearchEvidence;
	candidates: ThreadCandidate[];
}> {
	const searchTeamPosts = input.client.searchTeamPosts;
	if (!searchTeamPosts) throw new Error("Remote search client is unavailable.");
	const result = await searchRemoteCandidates(
		input.config.teamId,
		searchTeamPosts.bind(input.client),
		input.probes,
		input.conversations,
		{ deadlineAt: input.deadlineAt, incomplete: input.incomplete },
	);
	if (result.failures) {
		input.warnings.push(remoteSearchFailureWarning(result.failures));
	}
	return {
		remoteSearch: {
			requested: input.reason === "explicit",
			performed: true,
			reason: input.reason,
			queries: result.queries,
			candidateThreads: result.candidates.length,
			failures: result.failures,
		},
		candidates: result.candidates,
	};
}

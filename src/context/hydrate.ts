import type { MattermostConfig } from "../config/config.ts";
import type { EvidencePost } from "../evidence/packing.ts";
import { packThread } from "../evidence/packing.ts";
import { MattermostApiError } from "../mattermost/client.ts";
import type { MattermostPost } from "../mattermost/schemas.ts";
import type {
	MattermostSubject,
	RetrievalProbe,
	RoutedConversation,
	ThreadCandidate,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { mapWithConcurrency } from "../shared/concurrency.ts";
import { ConfigError } from "../shared/errors.ts";
import type { IndexedPost, MattermostStore } from "../store/index.ts";
import {
	assertThreadBoundary,
	evidencePost,
	indexedPost,
	isRecoverableRemoteError,
	localDisplayName,
	localEvidence,
	postLink,
	reevaluateCandidate,
	resolveConversationSurround,
} from "./helpers.ts";
import type { ContextClient, ContextThread } from "./types.ts";

export async function resolveDirectTarget(
	postId: string,
	store: MattermostStore,
	client?: ContextClient,
	allowedConversationIds?: ReadonlySet<string>,
	options: {
		preferLocal?: boolean;
		warnings?: Warning[];
	} = {},
): Promise<IndexedPost> {
	const local = store.getPost(postId);
	if (
		local &&
		allowedConversationIds &&
		!allowedConversationIds.has(local.conversationId)
	) {
		throw new ConfigError(
			"The post is outside configured conversations.",
			"conversation_not_allowed",
		);
	}
	if (!client) {
		if (!local)
			throw new ConfigError(`Post ${postId} is not indexed.`, "post_not_found");
		return local;
	}
	if (options.preferLocal && local) return local;

	try {
		return indexedPost(await client.getPost(postId));
	} catch (error) {
		if (isRecoverableRemoteError(error) && local) {
			options.warnings?.push({
				kind: "remote_resolve_failed",
				message:
					"Mattermost post fetch failed; using the locally indexed post.",
			});
			return local;
		}
		throw error;
	}
}

export async function hydrateThread(
	rootPostId: string,
	conversation: RoutedConversation,
	store: MattermostStore,
	client?: ContextClient,
	requiredPostId?: string,
	options: {
		forceRemote?: boolean;
		freshnessSeconds?: number;
		now?: number;
		warnings?: Warning[];
	} = {},
): Promise<EvidencePost[]> {
	const localPosts = store.getThread(rootPostId);
	const localUsable = (() => {
		if (!localPosts.length) return false;
		if (
			requiredPostId &&
			!localPosts.some((post) => post.id === requiredPostId)
		) {
			return false;
		}
		try {
			assertThreadBoundary(
				localPosts.map((post) => ({
					id: post.id,
					rootId: post.rootId,
					conversationId: post.conversationId,
				})),
				conversation.id,
				rootPostId,
				requiredPostId,
			);
			return true;
		} catch {
			return false;
		}
	})();

	if (!client) {
		if (!localUsable) {
			throw new ConfigError(
				"Mattermost thread root is missing or inaccessible.",
				"thread_not_found",
			);
		}
		return localEvidence(store, localPosts);
	}

	const now = options.now ?? Date.now();
	const freshnessSeconds = options.freshnessSeconds ?? 300;
	const checkpoint = store.getCheckpoint(conversation.id);
	const ageSeconds = checkpoint?.lastSuccessAt
		? Math.max(0, (now - checkpoint.lastSuccessAt) / 1000)
		: null;
	const stale = ageSeconds === null || ageSeconds > freshnessSeconds;
	if (!options.forceRemote && localUsable && !stale) {
		return localEvidence(store, localPosts);
	}

	try {
		const response = await client.getThread(rootPostId);
		const posts = response.order
			.map((id) => response.posts[id])
			.filter((post): post is MattermostPost => post !== undefined);
		assertThreadBoundary(
			posts.map((post) => ({
				id: post.id,
				rootId: post.root_id,
				conversationId: post.channel_id,
			})),
			conversation.id,
			rootPostId,
			requiredPostId,
		);
		const userIds = [...new Set(posts.map(({ user_id }) => user_id))];
		const fileIds = [...new Set(posts.flatMap(({ file_ids }) => file_ids))];
		const knownFiles = new Set(
			store.getFilesForPosts(posts.map(({ id }) => id)).map(({ id }) => id),
		);
		const missingFileIds = fileIds.filter((fileId) => !knownFiles.has(fileId));
		const [users, files] = await Promise.all([
			client.getUsersByIds(userIds),
			mapWithConcurrency(missingFileIds, (fileId) =>
				client.getFileInfo(fileId),
			),
		]);
		store.writePage({ conversation, posts, users, files });
		// Index is the source of truth so known files skipped by missingFileIds stay in evidence.
		return localEvidence(store, store.getThread(rootPostId));
	} catch (error) {
		if (isRecoverableRemoteError(error) && localUsable) {
			options.warnings?.push({
				kind: "remote_hydrate_failed",
				message:
					"Mattermost thread fetch failed; using locally indexed thread evidence.",
			});
			return localEvidence(store, localPosts);
		}
		throw error;
	}
}

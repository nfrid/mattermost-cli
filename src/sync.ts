import { mapWithConcurrency } from "./concurrency.ts";
import type { MattermostConfig } from "./config.ts";
import { AppError, ConfigError } from "./errors.ts";
import type { MattermostClient } from "./mattermost/client.ts";
import type {
	MattermostFileInfo,
	MattermostPost,
	MattermostPostList,
	MattermostUser,
} from "./mattermost/schemas.ts";
import type {
	ConversationRecord,
	MattermostStore,
	SyncCheckpoint,
} from "./storage.ts";

const MATTERMOST_SINCE_RESULT_LIMIT = 1_000;

class DeltaLimitError extends Error {
	constructor() {
		super(
			"Mattermost reached its bounded since-result limit; run a full sync before freshness can advance.",
		);
		this.name = "DeltaLimitError";
	}
}

export class ReconciliationError extends AppError {
	constructor(
		conversation: ConversationRecord,
		checkpoint: SyncCheckpoint | null,
		cause: unknown,
	) {
		super(
			`Synchronization for ${conversation.alias} failed; its previous freshness checkpoint was preserved.`,
			"sync",
			"reconciliation_failed",
			1,
			{ cause },
			{
				alias: conversation.alias,
				conversationId: conversation.id,
				freshnessComplete: false,
				lastSuccessAt: checkpoint?.lastSuccessAt ?? null,
				...(cause instanceof DeltaLimitError
					? { reason: "delta_limit", recommendedAction: "sync_full" }
					: {}),
			},
		);
		this.name = "ReconciliationError";
	}
}

export interface SyncOptions {
	aliases?: readonly string[];
	full?: boolean;
	now?: () => number;
	onProgress?: (message: string) => void;
}

export interface ConversationSyncResult {
	alias: string;
	conversationId: string;
	mode: "initial" | "incremental";
	postsProcessed: number;
	coverageComplete: boolean;
	oldestCoveredAt: number | null;
	lastSuccessAt: number;
}

export interface SyncResult {
	conversations: ConversationSyncResult[];
}

export interface ConversationFreshness {
	alias: string;
	conversationId: string;
	lastSuccessAt: number | null;
	ageSeconds: number | null;
	stale: boolean;
	coverageComplete: boolean;
}

export interface SyncClient {
	getChannelByName(
		teamId: string,
		channelName: string,
	): ReturnType<MattermostClient["getChannelByName"]>;
	getChannel(channelId: string): ReturnType<MattermostClient["getChannel"]>;
	getChannelPosts(
		channelId: string,
		options?: Parameters<MattermostClient["getChannelPosts"]>[1],
	): Promise<MattermostPostList>;
	getUsersByIds(userIds: readonly string[]): Promise<MattermostUser[]>;
	getFileInfo(fileId: string): Promise<MattermostFileInfo>;
}

export async function syncConfiguredConversations(
	config: MattermostConfig,
	client: SyncClient,
	store: MattermostStore,
	options: SyncOptions = {},
): Promise<SyncResult> {
	const conversations = await resolveConversations(
		config,
		client,
		options.aliases,
	);
	const outcomes = await mapWithConcurrency(
		conversations,
		async (conversation) => {
			options.onProgress?.(`Syncing ${conversation.alias}…`);
			try {
				const result = await syncConversation(
					config,
					client,
					store,
					conversation,
					options,
				);
				return { success: true as const, result };
			} catch (error) {
				return { success: false as const, conversation, error };
			}
		},
	);
	const results: ConversationSyncResult[] = [];
	let failure: { conversation: ConversationRecord; error: unknown } | undefined;
	for (const outcome of outcomes) {
		if (outcome.success) results.push(outcome.result);
		else failure ??= outcome;
	}
	if (failure) {
		throw new ReconciliationError(
			failure.conversation,
			store.getCheckpoint(failure.conversation.id),
			failure.error,
		);
	}
	return { conversations: results };
}

export async function resolveConversations(
	config: MattermostConfig,
	client: SyncClient,
	aliases?: readonly string[],
): Promise<ConversationRecord[]> {
	const requested = aliases?.length ? new Set(aliases) : null;
	const configured = new Set([
		...Object.keys(config.channels),
		...Object.keys(config.directMessages),
	]);
	if (requested) {
		const unknown = [...requested].filter((alias) => !configured.has(alias));
		if (unknown.length) {
			throw new ConfigError(
				`Unknown configured conversation alias: ${unknown.join(", ")}.`,
				"unknown_conversation",
			);
		}
	}

	const conversations: ConversationRecord[] = [];
	const channelEntries = Object.entries(config.channels).filter(
		([alias]) => !requested || requested.has(alias),
	);
	const dmEntries = Object.entries(config.directMessages).filter(
		([alias]) => !requested || requested.has(alias),
	);
	const resolvedChannels = await mapWithConcurrency(
		channelEntries,
		async ([alias, configuredChannel]) => {
			const channel = configuredChannel.id
				? await client.getChannel(configuredChannel.id)
				: await client.getChannelByName(config.teamId, configuredChannel.name);
			if (channel.team_id !== config.teamId) {
				throw new ConfigError(
					`Configured channel ${alias} is not in team ${config.teamId}.`,
					"channel_team_mismatch",
				);
			}
			if (
				(channel.type !== "O" && channel.type !== "P") ||
				channel.name !== configuredChannel.name ||
				(configuredChannel.id && channel.id !== configuredChannel.id)
			) {
				throw new ConfigError(
					`Configured channel ${alias} resolved to an unexpected identity or type.`,
					"channel_identity_mismatch",
				);
			}
			return {
				id: channel.id,
				alias,
				kind: "channel" as const,
				name: channel.name,
				description: configuredChannel.description,
			};
		},
	);
	conversations.push(...resolvedChannels);
	const resolvedDirectMessages = await mapWithConcurrency(
		dmEntries,
		async ([alias, directMessage]) => {
			const channel = await client.getChannel(directMessage.channelId);
			if (
				(channel.type !== "D" && channel.type !== "G") ||
				channel.id !== directMessage.channelId
			) {
				throw new ConfigError(
					`Configured direct message ${alias} resolved to an unexpected identity or type.`,
					"direct_message_identity_mismatch",
				);
			}
			return {
				id: channel.id,
				alias,
				kind: "direct_message" as const,
				name: channel.name || alias,
				description: directMessage.description,
			};
		},
	);
	conversations.push(...resolvedDirectMessages);
	return conversations;
}

export function inspectFreshness(
	config: MattermostConfig,
	store: MattermostStore,
	conversations: readonly ConversationRecord[],
	now = Date.now(),
): ConversationFreshness[] {
	return conversations.map((conversation) => {
		const checkpoint = store.getCheckpoint(conversation.id);
		const ageSeconds = checkpoint?.lastSuccessAt
			? Math.max(0, (now - checkpoint.lastSuccessAt) / 1000)
			: null;
		return {
			alias: conversation.alias,
			conversationId: conversation.id,
			lastSuccessAt: checkpoint?.lastSuccessAt ?? null,
			ageSeconds,
			stale: ageSeconds === null || ageSeconds > config.freshnessSeconds,
			coverageComplete: checkpoint?.coverageComplete ?? false,
		};
	});
}

async function syncConversation(
	config: MattermostConfig,
	client: SyncClient,
	store: MattermostStore,
	conversation: ConversationRecord,
	options: SyncOptions,
): Promise<ConversationSyncResult> {
	const now = options.now?.() ?? Date.now();
	const previous = store.getCheckpoint(conversation.id);
	if (previous && !options.full) {
		return incrementalSync(config, client, store, conversation, previous, now);
	}
	return initialSync(
		config,
		client,
		store,
		conversation,
		now,
		Boolean(options.full),
	);
}

async function initialSync(
	config: MattermostConfig,
	client: SyncClient,
	store: MattermostStore,
	conversation: ConversationRecord,
	now: number,
	full: boolean,
): Promise<ConversationSyncResult> {
	const cutoff = full ? 0 : now - config.historyDays * 86_400_000;
	let before: string | undefined;
	const seenCursors = new Set<string>();
	let processed = 0;
	let newest: MattermostPost | undefined;
	let oldestAt: number | null = null;
	let coverageComplete = false;
	const retainedPostIds: string[] = [];

	while (true) {
		const response = await client.getChannelPosts(conversation.id, {
			perPage: config.pageSize,
			...(before ? { before } : {}),
		});
		const ordered = orderedPosts(response);
		if (!ordered.length) {
			coverageComplete = true;
			break;
		}
		const retained = ordered.filter((post) => post.create_at >= cutoff);
		if (retained.length) {
			newest ??= maxPost(retained);
			retainedPostIds.push(...retained.map(({ id }) => id));
			await enrichAndWrite(store, client, conversation, retained);
			processed += retained.length;
			oldestAt = minTimestamp(
				oldestAt,
				...retained.map((post) => post.create_at),
			);
		}
		if (retained.length < ordered.length) break;
		if (ordered.length < config.pageSize) {
			coverageComplete = true;
			break;
		}
		const nextCursor = ordered.at(-1)?.id;
		if (!nextCursor || seenCursors.has(nextCursor)) {
			throw new Error("Mattermost pagination cursor did not advance.");
		}
		seenCursors.add(nextCursor);
		before = nextCursor;
	}

	const checkpoint: SyncCheckpoint = {
		conversationId: conversation.id,
		newestPostId: newest?.id ?? null,
		newestPostAt: newest?.create_at ?? null,
		oldestCoveredAt: oldestAt,
		lastSuccessAt: now,
		coverageComplete,
	};
	if (full) {
		store.finalizeFullSync(conversation, retainedPostIds, checkpoint);
	} else {
		store.writePage({ conversation, posts: [], checkpoint });
	}
	return resultFromCheckpoint(conversation, "initial", processed, checkpoint);
}

async function incrementalSync(
	config: MattermostConfig,
	client: SyncClient,
	store: MattermostStore,
	conversation: ConversationRecord,
	previous: SyncCheckpoint,
	now: number,
): Promise<ConversationSyncResult> {
	const since = Math.max(
		0,
		(previous.lastSuccessAt ?? previous.newestPostAt ?? 0) -
			config.reconciliationOverlapMs,
	);
	const changed = orderedPosts(
		await client.getChannelPosts(conversation.id, { since }),
	);
	if (changed.length >= MATTERMOST_SINCE_RESULT_LIMIT) {
		throw new DeltaLimitError();
	}
	if (changed.length) {
		await enrichAndWrite(store, client, conversation, changed);
	}

	let before: string | undefined;
	const seenCursors = new Set<string>();
	let anchorFound = previous.newestPostId === null;
	const coverageBoundaryAt = previous.oldestCoveredAt;
	let coverageBoundaryReached = coverageBoundaryAt === null;
	let coverageComplete = previous.coverageComplete;
	const scanned: MattermostPost[] = [];
	while (!anchorFound) {
		const response = await client.getChannelPosts(conversation.id, {
			perPage: config.pageSize,
			...(before ? { before } : {}),
		});
		const posts = orderedPosts(response);
		if (!posts.length) {
			coverageComplete = true;
			break;
		}
		scanned.push(...posts);
		await enrichAndWrite(store, client, conversation, posts);
		anchorFound ||= posts.some((post) => post.id === previous.newestPostId);
		coverageBoundaryReached ||=
			coverageBoundaryAt !== null &&
			posts.some((post) => post.create_at <= coverageBoundaryAt);
		if (posts.length < config.pageSize) {
			coverageComplete = true;
			coverageBoundaryReached = true;
		}
		if (anchorFound || coverageBoundaryReached) break;
		const nextCursor = posts.at(-1)?.id;
		if (!nextCursor || seenCursors.has(nextCursor)) {
			throw new Error("Mattermost pagination cursor did not advance.");
		}
		seenCursors.add(nextCursor);
		before = nextCursor;
	}

	const all = deduplicatePosts([...changed, ...scanned]);
	const newest = maxPost(all);
	const advancesAnchor =
		newest !== undefined &&
		(previous.newestPostAt === null ||
			newest.create_at >= previous.newestPostAt);
	const checkpoint: SyncCheckpoint = {
		conversationId: conversation.id,
		newestPostId: advancesAnchor ? newest.id : previous.newestPostId,
		newestPostAt: advancesAnchor ? newest.create_at : previous.newestPostAt,
		oldestCoveredAt: minTimestamp(
			previous.oldestCoveredAt,
			...all.map((post) => post.create_at),
		),
		lastSuccessAt: now,
		coverageComplete,
	};
	store.writePage({ conversation, posts: [], checkpoint });
	return resultFromCheckpoint(
		conversation,
		"incremental",
		all.length,
		checkpoint,
	);
}

async function enrichAndWrite(
	store: MattermostStore,
	client: SyncClient,
	conversation: ConversationRecord,
	posts: readonly MattermostPost[],
): Promise<void> {
	const userIds = [...new Set(posts.map((post) => post.user_id))];
	const fileIds = [...new Set(posts.flatMap((post) => post.file_ids))];
	const [users, files] = await Promise.all([
		client.getUsersByIds(userIds),
		mapWithConcurrency(fileIds, (fileId) => client.getFileInfo(fileId)),
	]);
	store.writePage({ conversation, posts, users, files });
}

function orderedPosts(list: MattermostPostList): MattermostPost[] {
	return list.order
		.map((id) => list.posts[id])
		.filter((post): post is MattermostPost => post !== undefined);
}

function deduplicatePosts(posts: readonly MattermostPost[]): MattermostPost[] {
	return [...new Map(posts.map((post) => [post.id, post])).values()];
}

function maxPost(posts: readonly MattermostPost[]): MattermostPost | undefined {
	return posts.reduce<MattermostPost | undefined>(
		(current, post) =>
			!current || post.create_at > current.create_at ? post : current,
		undefined,
	);
}

function minTimestamp(
	current: number | null,
	...values: number[]
): number | null {
	return values.reduce<number | null>(
		(minimum, value) => (minimum === null || value < minimum ? value : minimum),
		current,
	);
}

function resultFromCheckpoint(
	conversation: ConversationRecord,
	mode: "initial" | "incremental",
	postsProcessed: number,
	checkpoint: SyncCheckpoint,
): ConversationSyncResult {
	return {
		alias: conversation.alias,
		conversationId: conversation.id,
		mode,
		postsProcessed,
		coverageComplete: checkpoint.coverageComplete,
		oldestCoveredAt: checkpoint.oldestCoveredAt,
		lastSuccessAt: checkpoint.lastSuccessAt ?? 0,
	};
}

import type { MattermostConfig } from "../config/config.ts";
import type { EvidencePost } from "../evidence/packing.ts";
import { MattermostApiError } from "../mattermost/client.ts";
import type { MattermostPost } from "../mattermost/schemas.ts";
import { extractTicketKeys } from "../search/extract.ts";
import {
	buildRankingReasons,
	evaluateThreadEvidence,
	type MattermostSubject,
	type RankingReason,
	type RetrievalProbe,
	type RoutedConversation,
	type RoutingResult,
	type StructuredSearchMatch,
	type ThreadCandidate,
} from "../search/index.ts";
import { matchesQueryExpansion } from "../search/query-expansion.ts";
import {
	containsNormalizedExactText,
	containsNormalizedText,
	normalizeSearchText,
	STOP_WORDS,
} from "../search/text.ts";
import type { Warning } from "../shared/command-result.ts";
import { AppError, MattermostDataError } from "../shared/errors.ts";
import type {
	ConversationRecord,
	IndexedFile,
	IndexedPost,
	IndexedUser,
	MattermostStore,
} from "../store/index.ts";
import { inspectFreshness, ReconciliationError } from "../sync/sync.ts";
import type {
	FreshnessEvidence,
	ProbeCoverage,
	SurroundRelevance,
} from "./types.ts";

export function isRecoverableRemoteError(error: unknown): boolean {
	if (error instanceof MattermostApiError) return true;
	if (error instanceof ReconciliationError) return true;
	if (error instanceof AppError) {
		return error.source === "mattermost" || error.source === "sync";
	}
	return false;
}

export function resolveConversationSurround(
	store: MattermostStore,
	conversation: ConversationRecord | RoutedConversation,
	threadEvidence: readonly EvidencePost[],
	shortThreadMaxReplies: number,
	surroundRoots: number,
): EvidencePost[] {
	if (conversation.kind !== "direct_message" || surroundRoots <= 0) return [];
	const root = threadEvidence[0];
	if (!root) return [];
	const replyCount = Math.max(0, threadEvidence.length - 1);
	if (replyCount > shortThreadMaxReplies) return [];
	const preceding = store.getPrecedingRootPosts(
		conversation.id,
		root.createAt,
		root.id,
		surroundRoots,
	);
	if (!preceding.length) return [];
	return localEvidence(store, preceding);
}

/** Below this, a thread root has no topic to compare surround against. */
const MIN_COMPARABLE_ROOT_TOKENS = 2;

/** URLs are addresses, not vocabulary: they must not create or deny overlap. */
const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;

/**
 * Labels DM surround. Callers decide whether to attach it.
 *
 * - `possible` when the subject ticket is missing, or surround looks related
 *   (ticket mention or non-trivial token overlap with the thread root).
 * - `low` when no surround post mentions the subject and there is no shared
 *   non-trivial token overlap with the thread root beyond the ticket key.
 */
export function scoreSurroundRelevance(
	surroundPosts: readonly EvidencePost[],
	subjectTicket: string | undefined,
	threadRootMessage = "",
): SurroundRelevance {
	const subject = subjectTicket?.trim();
	if (!subject) return "possible";

	const subjectKey = subject.toUpperCase();
	if (
		surroundPosts.some((post) =>
			extractTicketKeys(post.message).includes(subjectKey),
		)
	) {
		return "possible";
	}

	const rootTokens = nontrivialOverlapTokens(threadRootMessage, subjectKey);
	// A link-only or administrative root ("завела <ticket url>") carries no
	// vocabulary to compare against, so reporting `low` would be an unearned
	// verdict about surround this scorer cannot actually judge.
	if (rootTokens.size < MIN_COMPARABLE_ROOT_TOKENS) return "possible";

	for (const post of surroundPosts) {
		const surroundTokens = nontrivialOverlapTokens(post.message, subjectKey);
		for (const token of surroundTokens) {
			if (rootTokens.has(token)) return "possible";
		}
	}
	return "low";
}

function nontrivialOverlapTokens(
	message: string,
	subjectTicketKey: string,
): Set<string> {
	const excluded = normalizeSearchText(subjectTicketKey);
	const tokens =
		message.replace(URL_PATTERN, " ").match(/[\p{L}\p{N}_-]+/gu) ?? [];
	return new Set(
		tokens
			.map(normalizeSearchText)
			.filter(
				(token) =>
					token.length > 1 && token !== excluded && !STOP_WORDS.has(token),
			),
	);
}

/**
 * Verifies that a set of posts really is the requested thread. Failures are
 * data faults (a moved, re-rooted, or partially inaccessible thread), never
 * configuration or routing decisions, so callers can recover by falling back to
 * indexed evidence or by dropping the thread.
 */
export function assertThreadBoundary(
	posts: readonly { id: string; rootId: string; conversationId: string }[],
	expectedConversationId: string,
	expectedRootPostId: string,
	requiredPostId?: string,
): void {
	if (!posts.some(({ id }) => id === expectedRootPostId)) {
		throw new MattermostDataError(
			"Mattermost thread root is missing or inaccessible.",
			"thread_not_found",
		);
	}
	if (requiredPostId && !posts.some(({ id }) => id === requiredPostId)) {
		throw new MattermostDataError(
			"The directly requested post is missing from its current thread.",
			"post_not_found",
		);
	}
	if (
		posts.some(
			({ id, rootId, conversationId }) =>
				conversationId !== expectedConversationId ||
				(id !== expectedRootPostId && rootId !== expectedRootPostId),
		)
	) {
		throw new MattermostDataError(
			"Mattermost thread posts do not all share the expected conversation and root; the thread is inconsistent.",
			"thread_boundary_mismatch",
		);
	}
}

export function localEvidence(
	store: MattermostStore,
	posts: readonly IndexedPost[],
): EvidencePost[] {
	const users = new Map(
		store
			.getUsers([...new Set(posts.map(({ userId }) => userId))])
			.map((user) => [user.id, user]),
	);
	const files = store.getFilesForPosts(posts.map(({ id }) => id));
	return posts.map((post) => evidencePost(post, users.get(post.userId), files));
}

export function evidencePost(
	post: IndexedPost,
	user: IndexedUser | undefined,
	files: readonly IndexedFile[],
): EvidencePost {
	return {
		id: post.id,
		rootId: post.rootId,
		userId: post.userId,
		authorUsername: user?.username ?? `unknown:${post.userId}`,
		authorDisplayName: localDisplayName(user),
		createAt: post.createAt,
		updateAt: post.updateAt,
		deleteAt: post.deleteAt,
		message: post.deleteAt ? "" : post.message,
		attachments: files
			.filter((file) => file.postId === post.id)
			.map((file) => ({ ...file })),
	};
}

export function indexedPost(post: MattermostPost): IndexedPost {
	return {
		id: post.id,
		rootId: post.root_id,
		threadId: post.root_id || post.id,
		conversationId: post.channel_id,
		userId: post.user_id,
		createAt: post.create_at,
		updateAt: post.update_at,
		deleteAt: post.delete_at,
		message: post.delete_at ? "" : post.message,
		props: post.props,
		metadata: post.metadata,
	};
}

export function reevaluateCandidate(
	candidate: ThreadCandidate,
	posts: readonly EvidencePost[],
	subject: MattermostSubject,
	probes: readonly RetrievalProbe[],
): { reasons: RankingReason[]; latestActivityAt: number } {
	const root = posts.find(({ id }) => id === candidate.rootPostId);
	const ticketKey = subject.kind === "ticket" ? subject.ticketKey : undefined;
	const rootHasTicket = Boolean(
		ticketKey && root && containsNormalizedExactText(root.message, ticketKey),
	);
	const replyHasTicket = Boolean(
		ticketKey &&
			posts.some(
				(post) =>
					post.id !== candidate.rootPostId &&
					containsNormalizedExactText(post.message, ticketKey),
			),
	);
	const hasStructuredMatch = Boolean(
		candidate.structuredMatches?.some((structured) => {
			const post = posts.find(({ id }) => id === structured.postId);
			return Boolean(
				post &&
					(containsNormalizedText(post.message, structured.value) ||
						post.attachments.some(
							({ name, deleteAt }) =>
								!deleteAt && containsNormalizedText(name, structured.value),
						)),
			);
		}),
	);
	const rankingEvidence = evaluateThreadEvidence(
		posts,
		candidate.rootPostId,
		subject,
		probes,
	);
	const routingReason = candidate.reasons.find((reason) =>
		reason.startsWith("routing_"),
	);
	return {
		reasons: buildRankingReasons({
			preserve: candidate.reasons,
			rootHasTicket,
			replyHasTicket,
			hasStructuredMatch,
			rankingEvidence,
			fusionContributions: candidate.fusionContributions,
			fusionScore: candidate.fusionScore,
			routingReason,
			priority: Boolean(candidate.priority),
		}),
		latestActivityAt: Math.max(
			...posts.map((post) =>
				Math.max(post.createAt, post.updateAt, post.deleteAt),
			),
		),
	};
}

function postMatchesProbeTerm(
	message: string,
	probe: RetrievalProbe,
	term: string,
): boolean {
	return (
		containsNormalizedExactText(message, term) ||
		(probe.expansions ?? []).some(
			(expansion) =>
				expansion.sourceTerm === term &&
				matchesQueryExpansion(message, expansion),
		)
	);
}

export function matchingProbeValues(
	posts: readonly EvidencePost[],
	probes: readonly RetrievalProbe[],
): string[] {
	const live = posts.filter(({ deleteAt }) => !deleteAt);
	return probes
		.filter((probe) =>
			probe.terms.length
				? probe.terms.every((term) =>
						live.some((post) =>
							postMatchesProbeTerm(post.message, probe, term),
						),
					)
				: live.some((post) =>
						containsNormalizedExactText(post.message, probe.value),
					),
		)
		.map(({ value }) => value);
}

export function currentMatches(
	posts: readonly EvidencePost[],
	probes: readonly RetrievalProbe[],
	originalMatches: readonly string[],
	structuredMatches: readonly StructuredSearchMatch[] = [],
): string[] {
	if (!probes.length && !structuredMatches.length) return [...originalMatches];
	const live = posts.filter(({ deleteAt }) => !deleteAt);
	const matches = new Set<string>();
	for (const probe of probes) {
		if (probe.terms.length) {
			const qualifies = probe.terms.every((term) =>
				live.some((post) => postMatchesProbeTerm(post.message, probe, term)),
			);
			if (qualifies) {
				for (const post of live) {
					if (
						probe.terms.some((term) =>
							postMatchesProbeTerm(post.message, probe, term),
						)
					) {
						matches.add(post.id);
					}
				}
			}
		} else {
			for (const post of live) {
				if (containsNormalizedExactText(post.message, probe.value))
					matches.add(post.id);
			}
		}
	}
	for (const structured of structuredMatches) {
		const post = live.find(({ id }) => id === structured.postId);
		if (
			post &&
			(containsNormalizedText(post.message, structured.value) ||
				post.attachments.some(({ name, deleteAt }) =>
					!deleteAt ? containsNormalizedText(name, structured.value) : false,
				))
		) {
			matches.add(post.id);
		}
	}
	return [...matches].sort();
}

export function routingHintWarnings(
	routing: RoutingResult,
	config?: MattermostConfig,
): Warning[] {
	const warnings: Warning[] = [];
	const known = (kind: "repositories" | "scopes") => {
		if (!config) return "";
		const values = [
			...new Set(
				routing.conversations.flatMap((conversation) => {
					const metadata =
						conversation.kind === "channel"
							? config.channels[conversation.alias]
							: config.directMessages[conversation.alias];
					return metadata?.[kind] ?? [];
				}),
			),
		].sort();
		if (!values.length) return " No values of this kind are configured.";
		const shown = values.slice(0, 12);
		return ` Known values on eligible conversations: ${shown.join(", ")}${values.length > shown.length ? ` (+${values.length - shown.length} more)` : ""}.`;
	};
	if (routing.unmatchedHints.repositories.length) {
		warnings.push({
			kind: "unmapped_routing_hint",
			message: `Informational: repository routing hint(s) matched no configured conversation metadata and did not narrow routing: ${routing.unmatchedHints.repositories.join(", ")}.${known("repositories")}`,
		});
	}
	if (routing.unmatchedHints.scopes.length) {
		warnings.push({
			kind: "unmapped_routing_hint",
			message: `Informational: scope routing hint(s) matched no configured conversation metadata and did not narrow routing: ${routing.unmatchedHints.scopes.join(", ")}.${known("scopes")}`,
		});
	}
	return warnings;
}

/** Collapse repeated soft-degrade hydrate/resolve/freshen warnings into one signal. */
export function consolidateLocalFallbackWarnings(
	warnings: readonly Warning[],
): Warning[] {
	const fallbackKinds = new Set([
		"remote_hydrate_failed",
		"remote_resolve_failed",
		"remote_freshen_failed",
	]);
	const fallbacks = warnings.filter(({ kind }) => fallbackKinds.has(kind));
	if (fallbacks.length <= 1) return [...warnings];
	return [
		{
			kind: "local_index_fallback",
			message:
				"Mattermost API/network calls failed; continuing from the local index.",
		},
		...warnings.filter(({ kind }) => !fallbackKinds.has(kind)),
	];
}

/**
 * Per-probe retrieval outcome. A blanket "these probes did not match" warning
 * fired on every request even when the same probes were the only reason
 * `background[]` had entries at all, which left a reader reconciling a warning
 * against pointers that visibly contradicted it.
 */
export function buildProbeCoverage(
	probes: readonly RetrievalProbe[],
	matchedValues: ReadonlySet<string>,
	background: readonly { matchedProbes: readonly string[] }[] = [],
): ProbeCoverage[] {
	return probes.map((probe) => {
		const backgroundThreads = background.filter((thread) =>
			thread.matchedProbes.includes(probe.value),
		).length;
		const selected = matchedValues.has(probe.value);
		return {
			probe: probe.value,
			...(probe.kind ? { kind: probe.kind } : {}),
			matchedSelectedEvidence: selected,
			matchMode: "normalized_terms_or_expansions" as const,
			retrievalCriteria: probe.terms.length
				? [...probe.terms]
				: probe.phrases.length
					? [...probe.phrases]
					: [probe.value],
			backgroundThreads,
			status: selected
				? "matched_selected"
				: backgroundThreads > 0
					? "background_only"
					: "no_match",
		};
	});
}

/**
 * Warn only for probes that matched *nothing* anywhere. `background_only` is a
 * reportable outcome, not a defect: the probe did its job in the conversations
 * ticket routing never reaches.
 */
export function probeWarnings(coverage: readonly ProbeCoverage[]): Warning[] {
	const unmatched = coverage
		.filter(({ status }) => status === "no_match")
		.map(({ probe }) => probe);
	return unmatched.length
		? [
				{
					kind: "unmatched_retrieval_probe",
					message: `Retrieval probe(s) matched no selected evidence and no background pointer, and were not treated as required filters: ${unmatched.join(", ")}.`,
				},
			]
		: [];
}

export function freshnessEvidence(
	config: MattermostConfig,
	store: MattermostStore,
	conversations: readonly RoutedConversation[],
	now: number,
): FreshnessEvidence[] {
	const byId = new Map(
		conversations.map((conversation) => [conversation.id, conversation]),
	);
	return inspectFreshness(config, store, conversations, now).map(
		(freshness) => ({
			...freshness,
			kind: byId.get(freshness.conversationId)?.kind ?? "channel",
			observedAt: now,
		}),
	);
}

export function localDisplayName(user: IndexedUser | undefined): string {
	if (!user) return "Unknown user";
	return (
		[user.firstName, user.lastName].filter(Boolean).join(" ") ||
		user.nickname ||
		user.username
	);
}

export function postLink(config: MattermostConfig, postId: string): string {
	return `${config.url}/_redirect/pl/${encodeURIComponent(postId)}`;
}

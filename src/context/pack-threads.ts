import type { MattermostConfig } from "../config/config.ts";
import {
	type EvidencePost,
	hasInternalBudgetSkipInCore,
	type PackThreadOptions,
	packThread,
	ticketCorePostIds,
} from "../evidence/packing.ts";
import {
	isHistoricalNeighborThread,
	segmentThreadByTicketProximity,
} from "../evidence/ticket-segments.ts";
import type {
	MattermostSubject,
	RetrievalProbe,
	RoutedConversation,
	ThreadCandidate,
} from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { AppError } from "../shared/errors.ts";
import { deadlineReached } from "../shared/limits.ts";
import type { MattermostStore, ThreadSearchFilters } from "../store/index.ts";
import { evidenceMatchesFilters } from "./filters.ts";
import {
	currentMatches,
	isRecoverableRemoteError,
	localEvidence,
	matchingProbeValues,
	postLink,
	reevaluateCandidate,
	resolveConversationSurround,
} from "./helpers.ts";
import { hydrateThread } from "./hydrate.ts";
import { pickPrimaryThreadIndex } from "./selection.ts";
import type {
	ContextClient,
	ContextThread,
	SelectionEvidence,
} from "./types.ts";

/**
 * Ceiling on candidate threads fetched from Mattermost in one context call.
 * Selection keeps at most `defaultMaxThreads`, so this is generous headroom for
 * candidates that turn out unselectable; beyond it, local evidence is used and
 * the packet reports itself as possibly stale rather than stalling.
 */
const MAX_CANDIDATE_HYDRATIONS = 12;
/** Soft cap for short mode; root-anchored single threads may use more. */
const SHORT_MAX_CHARACTERS = 6_000;
const SHORT_PER_THREAD_CHARACTERS = 2_500;
/** Short packing budget for one root-anchored primary support thread. */
const SHORT_ROOT_ANCHORED_PER_THREAD = 4_500;
/**
 * Hard cap for brief-mode historical/related secondaries — decision mentions of
 * the subject plus a stub, not the neighbor ticket's war-room transcript.
 */
const HISTORICAL_BRIEF_SECONDARY_CHARACTERS = 1_200;

export interface ThreadPackerInput {
	config: MattermostConfig;
	store: MattermostStore;
	client: ContextClient | undefined;
	subject: MattermostSubject;
	probes: readonly RetrievalProbe[];
	filters: ThreadSearchFilters;
	/** Every conversation the request may draw evidence from. */
	conversations: readonly RoutedConversation[];
	/** Conversations already fresh before this request touched the network. */
	initiallyFreshIds: ReadonlySet<string>;
	fresh: boolean;
	/** Use the small evidence-card packing budget. */
	short: boolean;
	/**
	 * Lean navigate stubs: reserve a fair per-thread share of the default budget
	 * so one fat candidate cannot silently crowd out the rest of selection.
	 */
	navigate: boolean;
	/** Decision-only projection — shrink historical secondaries after primary pick. */
	brief: boolean;
	observedAt: number;
	deadlineAt: number;
	/** Collects soft-degrade warnings raised while hydrating. */
	warnings: Warning[];
	/**
	 * Candidates known when packing starts. Only sizes the per-thread share —
	 * later passes (widening, remote search) reuse the same share.
	 */
	candidateCount: number;
}

interface RepackInput {
	posts: EvidencePost[];
	options: Omit<PackThreadOptions, "limit">;
}

/**
 * Turns ranked candidates into packed context threads under one shared
 * character and thread budget.
 *
 * A request packs in several passes — initial candidates, then optionally
 * widened routing and remote-search candidates — and every pass shares the same
 * budget, hydration ceiling, and selection bookkeeping. Holding that state in
 * one object keeps the passes honest about what has already been spent.
 */
export class ThreadPacker {
	readonly budgets: {
		maxCharacters: number;
		perThreadCharacters: number;
		maxThreads: number;
	};
	readonly threads: ContextThread[] = [];
	readonly selection: SelectionEvidence;
	readonly matchedProbeValues = new Set<string>();
	readonly noMatchIds = new Set<string>();
	/**
	 * Candidates the budget stopped before they were examined at all. Recorded
	 * here rather than re-derived from ranking reasons later: `budget` is the
	 * fallback drop reason, so re-deriving also swept up filter rejections and
	 * mislabeled unexamined thin stubs.
	 */
	readonly budgetDroppedIds = new Set<string>();
	readonly seenCandidates = new Map<string, ThreadCandidate>();
	readonly hydrationFailures: string[] = [];
	readonly networkHydratedThreadIds = new Set<string>();

	/** True once a candidate wanted the network past the hydration ceiling. */
	hydrationBudgetSpent = false;

	private remainingCharacters: number;
	private readonly perThreadCharacters: number;
	/**
	 * Characters held back for truncated `--permalink` / direct_post threads so
	 * later ranked packing cannot spend the floor those threads under-used.
	 */
	private permalinkReserve = 0;
	private readonly repackInputs = new Map<string, RepackInput>();

	constructor(private readonly input: ThreadPackerInput) {
		const { budgets } = input.config;
		this.budgets = {
			maxCharacters: input.short
				? Math.min(budgets.defaultMaxCharacters, SHORT_MAX_CHARACTERS)
				: budgets.defaultMaxCharacters,
			perThreadCharacters: input.short
				? Math.min(
						budgets.defaultPerThreadCharacters,
						SHORT_PER_THREAD_CHARACTERS,
					)
				: budgets.defaultPerThreadCharacters,
			maxThreads: budgets.defaultMaxThreads,
		};
		// When only one or two strong threads fit, give each a larger share so
		// long decision middles are less likely to collapse into a single skip.
		// Navigate always reserves a fair share of maxThreads so a fat first
		// candidate cannot spend the whole budget before siblings pack.
		const expectedThreadCount = Math.min(
			Math.max(1, input.candidateCount),
			this.budgets.maxThreads,
		);
		if (input.navigate) {
			this.perThreadCharacters = Math.max(
				1,
				Math.floor(this.budgets.maxCharacters / this.budgets.maxThreads),
			);
		} else if (!input.short && expectedThreadCount <= 2) {
			this.perThreadCharacters = Math.max(
				this.budgets.perThreadCharacters,
				Math.floor(this.budgets.maxCharacters / expectedThreadCount),
			);
		} else {
			this.perThreadCharacters = this.budgets.perThreadCharacters;
		}
		this.remainingCharacters = this.budgets.maxCharacters;
		this.selection = {
			candidateThreads: input.candidateCount,
			returnedThreads: 0,
			droppedThin: 0,
			droppedByBudget: 0,
			droppedByBudgetSubjectMatched: 0,
			droppedNoMatch: 0,
			droppedCandidates: [],
		};
	}

	get remaining(): number {
		return this.remainingCharacters;
	}

	/** True while another candidate could still be packed. */
	get hasRoom(): boolean {
		return (
			this.threads.length < this.budgets.maxThreads &&
			this.remainingCharacters - this.permalinkReserve > 0
		);
	}

	async pack(candidates: readonly ThreadCandidate[]): Promise<void> {
		for (const candidate of candidates) {
			await this.packCandidate(candidate);
		}
	}

	private async packCandidate(candidate: ThreadCandidate): Promise<void> {
		const { config, store, subject, probes, filters, client } = this.input;
		this.seenCandidates.set(candidate.threadId, candidate);
		if (!this.hasRoom) {
			this.selection.droppedByBudget += 1;
			this.budgetDroppedIds.add(candidate.threadId);
			return;
		}
		const conversation = this.input.conversations.find(
			({ id }) => id === candidate.conversationId,
		);
		if (!conversation) return;
		// Candidates come from the local index, so a candidate whose match and
		// filters already fail locally cannot become selectable by being fetched.
		// Deciding that before hydration keeps discovery noise from costing one
		// thread fetch (plus its users, files, and reindex) each.
		const localGate = this.localMatchGate(candidate);
		if (localGate) {
			for (const value of localGate.probeValues)
				this.matchedProbeValues.add(value);
			if (!localGate.matchesFilters) return;
			if (!localGate.matches) {
				this.dropAsNoMatch(candidate.threadId);
				return;
			}
		}

		const forceRemote =
			this.input.fresh ||
			!this.input.initiallyFreshIds.has(candidate.conversationId);
		const wantsNetwork = Boolean(client) && forceRemote;
		// Past the hydration budget, keep going on local evidence only:
		// `selectedEvidenceCurrent` then reports the packet as possibly stale
		// instead of the request stalling on per-candidate fetches.
		const withinHydrationBudget =
			this.networkHydratedThreadIds.size < MAX_CANDIDATE_HYDRATIONS &&
			!deadlineReached(this.input.deadlineAt);
		if (wantsNetwork && !withinHydrationBudget)
			this.hydrationBudgetSpent = true;

		// The subject post is required only of the thread that is supposed to
		// contain it. A `--permalink` candidate lives in a different thread, and
		// demanding the subject post there fails the whole request over a link
		// that was never claimed to be in that conversation.
		const subjectPostRequired =
			subject.kind === "post" &&
			candidate.matchingPostIds.includes(subject.postId);

		let hydrated: Awaited<ReturnType<typeof hydrateThread>>;
		try {
			hydrated = await hydrateThread(
				candidate.rootPostId,
				conversation,
				store,
				wantsNetwork && !withinHydrationBudget ? undefined : client,
				subjectPostRequired ? subject.postId : undefined,
				{
					forceRemote,
					freshnessSeconds: config.freshnessSeconds,
					now: this.input.observedAt,
					warnings: this.input.warnings,
				},
			);
		} catch (error) {
			// One inconsistent or unavailable candidate must not fail a
			// multi-candidate request; it is dropped and reported instead.
			// The subject's own thread still fails loudly: it has no alternative.
			// An extra `--permalink` thread does have one — the rest of the packet.
			if (subjectPostRequired || !droppableCandidateError(error)) throw error;
			this.hydrationFailures.push(candidate.threadId);
			return;
		}

		const evidence = hydrated.posts;
		if (hydrated.source === "network") {
			this.networkHydratedThreadIds.add(candidate.threadId);
		}
		for (const value of matchingProbeValues(evidence, probes)) {
			this.matchedProbeValues.add(value);
		}
		if (!evidenceMatchesFilters(evidence, filters)) return;

		const liveMatchingPostIds = currentMatches(
			evidence,
			probes,
			candidate.matchingPostIds,
			candidate.structuredMatches,
		);
		const isPermalink = candidate.reasons.includes("direct_post");
		// `--permalink` / direct_post anchors are caller-chosen evidence. Probe
		// re-evaluation only keeps posts that mention the subject ticket, which
		// drops the linked post when that thread never names the ticket — and
		// packing then collapses to the root under ticket-window preference.
		const currentMatchingPostIds = isPermalink
			? [
					...new Set([
						...liveMatchingPostIds,
						...candidate.matchingPostIds.filter((id) =>
							evidence.some((post) => post.id === id && !post.deleteAt),
						),
					]),
				].sort()
			: liveMatchingPostIds;
		for (const structured of candidate.structuredMatches ?? []) {
			if (currentMatchingPostIds.includes(structured.postId)) {
				this.matchedProbeValues.add(structured.probe);
			}
		}
		if (
			subject.kind !== "post" &&
			!currentMatchingPostIds.length &&
			!candidate.reasons.includes("explicit_ticket_relationship") &&
			!isPermalink
		) {
			this.dropAsNoMatch(candidate.threadId);
			return;
		}

		const currentRanking = reevaluateCandidate(
			candidate,
			evidence,
			subject,
			probes,
		);
		const subjectTicketKey =
			subject.kind === "ticket" ? subject.ticketKey : undefined;
		const ticketMetrics = subjectTicketKey
			? segmentThreadByTicketProximity(evidence, {
					subjectTicket: subjectTicketKey,
					matchingPostIds: currentMatchingPostIds,
					ticketRadius: config.budgets.ticketNeighborhoodRadius,
					matchRadius: config.budgets.matchNeighborhoodRadius,
					clusterMergeGap: config.budgets.clusterMergeGap,
				})
			: undefined;
		const permalinkAnchor = isPermalink
			? candidate.matchingPostIds.find((id) =>
					evidence.some((post) => post.id === id && !post.deleteAt),
				)
			: undefined;
		// Permalink threads pack around the linked post under the character
		// budget. Subject-ticket window bias is for discovery threads; applying
		// it here starves a caller-requested thread that never names the ticket
		// (then brief mode crushes the "historical neighbor" down to 1/N).
		const packOptions: Omit<PackThreadOptions, "limit"> = {
			matchingPostIds: currentMatchingPostIds,
			neighborhoodRadius: config.budgets.matchNeighborhoodRadius,
			ticketNeighborhoodRadius: config.budgets.ticketNeighborhoodRadius,
			clusterMergeGap: config.budgets.clusterMergeGap,
			mode: this.input.short ? "short" : "default",
			gapFill: !this.input.short,
			...(isPermalink
				? {
						...(permalinkAnchor
							? {
									aroundPostId: permalinkAnchor,
									beforePosts: config.budgets.ticketNeighborhoodRadius,
									afterPosts: config.budgets.ticketNeighborhoodRadius,
								}
							: {}),
					}
				: {
						subjectTicketKey,
						...(ticketMetrics ? { ticketMetrics } : {}),
					}),
		};
		const permalinkFloor = isPermalink ? this.permalinkCharacterFloor() : 0;
		const availableForCandidate = isPermalink
			? this.remainingCharacters
			: Math.max(0, this.remainingCharacters - this.permalinkReserve);
		const packed = packThread(candidate.threadId, evidence, {
			...packOptions,
			limit: Math.min(
				Math.max(
					isPermalink ? permalinkFloor : 0,
					this.input.short && ticketMetrics?.rootAnchoredFocused
						? Math.max(this.perThreadCharacters, SHORT_ROOT_ANCHORED_PER_THREAD)
						: this.perThreadCharacters,
				),
				availableForCandidate,
			),
		});
		this.repackInputs.set(candidate.threadId, {
			posts: evidence,
			options: packOptions,
		});
		this.remainingCharacters -= packed.budget.used;
		if (isPermalink && permalinkFloor > packed.budget.used) {
			// Hold the unused floor so ranked peers cannot spend it before reclaim.
			this.permalinkReserve += permalinkFloor - packed.budget.used;
		}
		const surround = resolveConversationSurround(
			store,
			conversation,
			evidence,
			config.budgets.shortThreadMaxReplies,
			config.budgets.conversationSurroundRoots,
		);
		this.threads.push({
			...packed,
			conversationId: candidate.conversationId,
			conversationAlias: candidate.conversationAlias,
			conversationKind: candidate.conversationKind,
			reasons: currentRanking.reasons,
			matchingPostIds: currentMatchingPostIds,
			latestActivityAt: currentRanking.latestActivityAt,
			link: postLink(config, candidate.rootPostId),
			...(surround.length ? { surround } : {}),
			...(ticketMetrics
				? {
						ticketDensity: ticketMetrics.ticketDensity,
						nearestTicketDistance: ticketMetrics.nearestTicketDistance,
						rootAnchoredFocused: ticketMetrics.rootAnchoredFocused,
						exclusiveSubjectKey: ticketMetrics.exclusiveSubjectKey,
						otherTicketDominated: ticketMetrics.otherTicketDominated,
						// Explicit permalinks are never "historical neighbors" for brief
						// shrinking — the caller already asked for this thread's history.
						...(isPermalink
							? {}
							: isHistoricalNeighborThread(ticketMetrics)
								? {
										historicalNeighbor: true as const,
										...(ticketMetrics.dominantOtherTicketKey
											? {
													relatedTicketKey:
														ticketMetrics.dominantOtherTicketKey,
												}
											: {}),
									}
								: {}),
						segments: ticketMetrics.segments,
					}
				: {}),
		});
	}

	private dropAsNoMatch(threadId: string): void {
		this.selection.droppedNoMatch += 1;
		this.noMatchIds.add(threadId);
	}

	/**
	 * Local verdict for a candidate before any fetch: whether its indexed thread
	 * still carries a current match and passes the filters. Returns `undefined`
	 * when the thread is not indexed (remote-search candidates), where only a
	 * fetch can decide.
	 */
	private localMatchGate(candidate: ThreadCandidate):
		| {
				matches: boolean;
				matchesFilters: boolean;
				probeValues: readonly string[];
		  }
		| undefined {
		const { store, subject, probes, filters } = this.input;
		if (subject.kind === "post") return undefined;
		if (candidate.reasons.includes("explicit_ticket_relationship"))
			return undefined;
		// A `--permalink` target is evidence the caller already chose. Dropping it
		// for not mentioning the subject would silently answer a different request
		// than the one made.
		if (candidate.reasons.includes("direct_post")) return undefined;
		const indexed = store.getThread(candidate.rootPostId);
		if (!indexed.length) return undefined;
		const evidence = localEvidence(store, indexed);
		return {
			matches:
				currentMatches(
					evidence,
					probes,
					candidate.matchingPostIds,
					candidate.structuredMatches,
				).length > 0,
			matchesFilters: evidenceMatchesFilters(evidence, filters),
			probeValues: matchingProbeValues(evidence, probes),
		};
	}

	/**
	 * Spends leftover characters on threads that were truncated, then repairs an
	 * internal hole inside the primary thread's subject-ticket core. Short mode
	 * opts out: its small budget is the point. Brief mode then shrinks historical
	 * secondaries so a related-ticket war room cannot dominate the packet.
	 */
	finalizeBudget(): void {
		if (this.input.short) return;
		if (this.remainingCharacters > 0) this.reclaimUnusedBudget();
		if (this.input.subject.kind === "ticket") this.repackPrimaryTicketCore();
		if (this.input.brief && this.input.subject.kind === "ticket") {
			this.repackHistoricalBriefSecondaries();
		}
	}

	private reclaimUnusedBudget(): void {
		const primaryIndex = pickPrimaryThreadIndex(this.threads);
		// Explicit `--permalink` threads won their slots by caller instruction;
		// reclaim leftover characters into them before ordinary secondaries so a
		// thin permalink is not left at 1/N while reclaim fattens a ranked peer.
		const permalinkIndexes = this.threads
			.map((thread, index) => ({ thread, index }))
			.filter(({ thread }) => thread.reasons.includes("direct_post"))
			.map(({ index }) => index);
		// Release the held permalink floor into the shared leftover pool first.
		this.remainingCharacters += this.permalinkReserve;
		this.permalinkReserve = 0;
		const order = [
			...permalinkIndexes,
			primaryIndex,
			...this.threads
				.map((_, index) => index)
				.filter(
					(index) =>
						index !== primaryIndex && !permalinkIndexes.includes(index),
				),
		];
		const seen = new Set<number>();
		for (const index of order) {
			if (seen.has(index)) continue;
			seen.add(index);
			if (this.remainingCharacters <= 0) break;
			const thread = this.threads[index];
			if (!thread || thread.omittedPosts <= 0) continue;
			const input = this.repackInputs.get(thread.threadId);
			if (!input) continue;
			// Permalink threads get a protected floor (full per-thread share) so
			// reclaim cannot leave them token-starved after ranked packing.
			const permalinkFloor = thread.reasons.includes("direct_post")
				? Math.min(
						this.budgets.perThreadCharacters,
						Math.max(thread.budget.limit, this.permalinkCharacterFloor()),
					)
				: thread.budget.limit;
			const repacked = packThread(thread.threadId, input.posts, {
				...input.options,
				limit: Math.max(
					permalinkFloor,
					thread.budget.limit + this.remainingCharacters,
				),
			});
			const added = repacked.budget.used - thread.budget.used;
			if (added <= 0) continue;
			this.threads[index] = { ...thread, ...repacked };
			this.remainingCharacters -= added;
		}
	}

	/** Fair character floor for an explicit `--permalink` / direct_post thread. */
	private permalinkCharacterFloor(): number {
		return Math.min(
			this.perThreadCharacters,
			Math.max(
				Math.floor(this.budgets.perThreadCharacters * 0.75),
				Math.floor(
					this.budgets.maxCharacters / Math.max(2, this.budgets.maxThreads),
				),
			),
		);
	}

	/**
	 * After reclaim, if the primary ticket thread still has an internal budget
	 * hole inside its subject-ticket core, repack with contiguous-core selection
	 * at the same thread limit (no global budget increase).
	 */
	private repackPrimaryTicketCore(): void {
		const primaryIndex = pickPrimaryThreadIndex(this.threads);
		const thread = this.threads[primaryIndex];
		if (!thread || thread.omittedPosts <= 0) return;
		const input = this.repackInputs.get(thread.threadId);
		if (!input?.options.subjectTicketKey) return;

		const chronological = [...input.posts].sort(
			(left, right) =>
				left.createAt - right.createAt || left.id.localeCompare(right.id),
		);
		const ticketMetrics =
			input.options.ticketMetrics ??
			segmentThreadByTicketProximity(chronological, {
				subjectTicket: input.options.subjectTicketKey,
				matchingPostIds: input.options.matchingPostIds,
				ticketRadius: input.options.ticketNeighborhoodRadius,
				matchRadius: input.options.neighborhoodRadius,
				clusterMergeGap: input.options.clusterMergeGap,
			});
		if (!ticketMetrics.ticketHitPostIds.length) return;

		const coreIds = ticketCorePostIds(
			chronological,
			ticketMetrics.ticketHitPostIds,
			ticketMetrics.rootAnchoredFocused,
		);
		if (!hasInternalBudgetSkipInCore(thread.timeline, coreIds)) return;

		const maxAllowedUsed =
			thread.budget.used + Math.max(0, this.remainingCharacters);
		const repacked = packThread(thread.threadId, input.posts, {
			...input.options,
			ticketMetrics,
			contiguousTicketCore: true,
			limit: Math.min(thread.budget.limit, maxAllowedUsed),
		});
		if (repacked.budget.used > maxAllowedUsed) return;
		this.remainingCharacters -= repacked.budget.used - thread.budget.used;
		this.threads[primaryIndex] = { ...thread, ...repacked };
	}

	/**
	 * Under `--brief` / ticket brief default, collapse secondary threads that are
	 * historical or related-ticket neighbors down to subject mentions + stubs.
	 * Primary keeps its packed depth.
	 */
	private repackHistoricalBriefSecondaries(): void {
		if (this.threads.length <= 1) return;
		const primaryIndex = pickPrimaryThreadIndex(this.threads);
		for (const [index, thread] of this.threads.entries()) {
			if (index === primaryIndex) continue;
			if (!thread.historicalNeighbor) continue;
			// Caller-requested `--permalink` threads must keep their packed depth
			// even when ticket metrics would label them historical.
			if (thread.reasons.includes("direct_post")) continue;
			const input = this.repackInputs.get(thread.threadId);
			if (!input) continue;
			const leanLimit = Math.min(
				HISTORICAL_BRIEF_SECONDARY_CHARACTERS,
				thread.budget.used,
			);
			const repacked = packThread(thread.threadId, input.posts, {
				...input.options,
				historicalNeighborBrief: true,
				gapFill: false,
				structuralAnchors: false,
				limit: leanLimit,
			});
			if (repacked.budget.used >= thread.budget.used) continue;
			const freed = thread.budget.used - repacked.budget.used;
			this.remainingCharacters += freed;
			this.threads[index] = {
				...thread,
				...repacked,
				historicalNeighbor: true,
				...(thread.relatedTicketKey
					? { relatedTicketKey: thread.relatedTicketKey }
					: {}),
			};
			this.repackInputs.set(thread.threadId, {
				posts: input.posts,
				options: {
					...input.options,
					historicalNeighborBrief: true,
					gapFill: false,
					structuralAnchors: false,
				},
			});
		}
	}
}

/**
 * Whether one candidate's hydration failure may be absorbed by dropping that
 * candidate: a remote/sync fault, an inconsistent thread, or a thread the local
 * index cannot serve once the hydration budget is spent.
 */
function droppableCandidateError(error: unknown): boolean {
	if (isRecoverableRemoteError(error)) return true;
	return (
		error instanceof AppError &&
		(error.kind === "thread_not_found" || error.kind === "post_not_found")
	);
}

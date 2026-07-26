import { extractTicketKeys } from "../text/index.ts";
import {
	budgetAwareAroundSidePosts,
	estimateAveragePostUnits,
	isMediaOnlyPost,
	largestTimelineSkip,
	MAX_AROUND_SIDE_POSTS,
} from "./packing.ts";
import {
	isActionableDroppedCandidate,
	isSubjectMatchedBudgetDrop,
	pickPrimaryThreadIndex,
	shouldRecommendInspectDropped,
} from "./selection-policy.ts";
import { buildThreadBrief } from "./signals.ts";
import type {
	ContextThread,
	DroppedCandidate,
	EvidenceAdequacy,
	EvidenceCurrency,
	EvidenceDiscoveryCurrency,
	EvidenceHistory,
	EvidenceIndexHistory,
	EvidenceMayHaveMissedReason,
	EvidenceNextImpact,
	EvidenceNextPriority,
	EvidenceNextStep,
	EvidenceSelectionCompleteness,
	EvidenceStatus,
	EvidenceThreadCompleteness,
	FreshnessEvidence,
	RemoteSearchEvidence,
	SelectionEvidence,
} from "./types.ts";

/**
 * The types this module produces live in `./types.ts` (see the note there).
 * Re-exported so `evidence/evidence.ts` stays the documented import site.
 */
export type * from "./types.ts";

/** Below this, unexamined candidates are ranking tail, not a visible gap. */
const SELECTION_REVIEW_MIN_DROPPED_BY_BUDGET = 3;
const RECOMMEND_FULL_MIN_OMITTED_RATIO = 0.25;
const RECOMMEND_FULL_MIN_LARGEST_SKIP = 5;

/** Deterministic evidence status for agents reading a context packet. */
export function buildEvidence(input: {
	searchCoverageComplete: boolean;
	selectedThreadsComplete: boolean;
	/** Selection stopped before judging every candidate (room or hydration). */
	selectionBudgetBounded?: boolean;
	freshnessMode: "local" | "network" | "forced";
	freshness: readonly FreshnessEvidence[];
	searchedConversations: readonly { id: string }[];
	threads: readonly ContextThread[];
	remoteSearch: RemoteSearchEvidence;
	selection: SelectionEvidence;
	warnings: readonly { kind: string }[];
	freshenedConversationCount?: number;
	/** Selected threads are fresh locally or were hydrated during this request. */
	selectedEvidenceCurrent?: boolean;
	/** Subject string for follow-up argv (ticket key, post id, or text). */
	subject?: string;
	/** Subject ticket key, when the subject is a ticket. */
	subjectTicket?: string;
	/**
	 * Attachment file ids already interpreted via `--inspect` / follow
	 * (`preview` or `text_extracted`). Clears pending mediaOnly answerability
	 * blocks so OCR / workbook preview can complete a recommended step.
	 */
	resolvedAttachmentFileIds?: readonly string[];
}): EvidenceStatus {
	const warningKinds = new Set(input.warnings.map(({ kind }) => kind));
	const cutoffBoundedConversations = input.freshness.filter(
		({ coverageComplete }) => !coverageComplete,
	).length;
	const staleRouted = input.freshness.filter(({ stale }) => stale).length;
	const localFallback =
		warningKinds.has("local_index_fallback") ||
		warningKinds.has("remote_hydrate_failed") ||
		warningKinds.has("remote_resolve_failed") ||
		warningKinds.has("remote_freshen_failed");

	const omittedPosts = input.threads.reduce(
		(sum, thread) => sum + thread.omittedPosts,
		0,
	);
	const largestSkip = input.threads.reduce(
		(max, thread) => Math.max(max, largestTimelineSkip(thread.timeline)),
		0,
	);
	const truncatedThreads = input.threads.filter((thread) =>
		shouldRecommendFull(thread),
	);
	const recommendFullThreadIds = truncatedThreads.map(
		({ threadId }) => threadId,
	);
	const rankedTruncated = rankTruncatedThreads(
		truncatedThreads,
		input.threads[pickPrimaryThreadIndex(input.threads)]?.threadId,
	);

	const onlyThinThreads =
		input.threads.length > 0 &&
		input.threads.every((thread) => thread.reasons.includes("thin_thread"));

	const adequacy: EvidenceAdequacy = !input.threads.length
		? "insufficient"
		: onlyThinThreads
			? "thin"
			: "usable";

	const selectedEvidenceCurrent =
		input.selectedEvidenceCurrent ?? staleRouted === 0;
	const currency: EvidenceCurrency =
		input.freshnessMode === "local"
			? "local_only"
			: localFallback ||
					input.remoteSearch.failures > 0 ||
					!selectedEvidenceCurrent
				? "possibly_stale"
				: "current";
	const discovery: EvidenceDiscoveryCurrency =
		input.freshnessMode === "local"
			? "local_only"
			: staleRouted === 0 ||
					(input.remoteSearch.performed && input.remoteSearch.failures === 0)
				? "current"
				: "possibly_stale";

	const selectedThreads: EvidenceThreadCompleteness = !input.threads.length
		? "not_applicable"
		: !input.selectedThreadsComplete || recommendFullThreadIds.length > 0
			? "truncated"
			: "complete";
	const selectionCompleteness: EvidenceSelectionCompleteness =
		input.selectionBudgetBounded || input.selection.droppedByBudget > 0
			? "budget_bounded"
			: "complete";
	const indexHistory: EvidenceIndexHistory =
		cutoffBoundedConversations > 0 ? "cutoff_bounded" : "full";

	const history = buildHistory(input.freshness, input.threads);
	const selectedMessages = input.threads.flatMap((thread) =>
		thread.posts.map(({ message }) => message),
	);
	const resolvedAttachmentIds = new Set(input.resolvedAttachmentFileIds ?? []);
	const unreadOutcomeAttachment = findUnreadOutcomeAttachment(
		input.threads,
		input.subjectTicket,
		resolvedAttachmentIds,
	);
	const decisionDataAttachment = findDecisionDataAttachment(
		input.threads,
		input.subjectTicket,
		unreadOutcomeAttachment?.postId,
		resolvedAttachmentIds,
	);
	const decisionImageAttachment = findDecisionImageAttachment(
		input.threads,
		input.subjectTicket,
		unreadOutcomeAttachment?.postId ?? decisionDataAttachment?.postId,
		resolvedAttachmentIds,
	);
	// A media-only outcome (or external-reader decision attachment) still pending
	// means the packet's text may omit the root cause — do not claim answerable.
	const pendingMaterialAttachment = Boolean(
		unreadOutcomeAttachment ||
			(decisionDataAttachment &&
				requiresExternalReader(decisionDataAttachment.fileName)) ||
			decisionImageAttachment,
	);
	const canAnswerFromSelectedEvidence =
		adequacy === "usable" &&
		selectedThreads === "complete" &&
		!pendingMaterialAttachment;
	// One rule, one place: `next` and `verdict` both ask whether the packet is
	// trustworthy on its own, and two spellings of that would drift apart.
	const packetTrusted = canAnswerFromSelectedEvidence && currency === "current";
	const mayHaveMissedReason = resolveMayHaveMissedReason({
		discovery,
		indexHistory,
		packetTrusted,
		droppedByBudgetSubjectMatched:
			input.selection.droppedByBudgetSubjectMatched,
	});
	const mayHaveMissedOtherThreads = mayHaveMissedReason !== undefined;
	const next = collectNextActions({
		packetTrusted,
		rankedTruncated,
		cutoffBoundedConversations,
		staleRouted,
		localFallback,
		localMode: input.freshnessMode === "local",
		remoteFailures: input.remoteSearch.failures,
		remoteSearchSuccessful:
			input.remoteSearch.performed && input.remoteSearch.failures === 0,
		selectedEvidenceCurrent,
		adequacy,
		currency,
		selectedThreadsComplete: selectedThreads === "complete",
		selectionCompleteness,
		selectionCounts: input.selection,
		selectedMessages,
		droppedCandidates: input.selection.droppedCandidates,
		freshness: input.freshness,
		warningKinds,
		subject: input.subject,
		unreadOutcomeAttachment,
		decisionDataAttachment,
		decisionImageAttachment,
	});
	const selectedEvidenceMayBeStale = currency !== "current";
	const recommendedActionRequired = next.some(
		({ priority }) => priority === "recommended",
	);
	const verdictNoAction = resolveVerdictNoAction({
		mayHaveMissedOtherThreads,
		mayHaveMissedReason,
		selectedEvidenceMayBeStale,
		canAnswerFromSelectedEvidence,
		next,
	});
	// `noActionAvailable` means an uncovered verdict axis has no safe follow-up.
	// When recommended next already exists, suppress the flag so agents are not
	// told both "you must act" and "no action available".
	const safeNoAction =
		verdictNoAction && !recommendedActionRequired ? verdictNoAction : undefined;

	return {
		adequacy,
		currency,
		verdict: {
			canAnswerFromSelectedEvidence,
			mayHaveMissedOtherThreads,
			...(mayHaveMissedReason ? { mayHaveMissedReason } : {}),
			selectedEvidenceMayBeStale,
			recommendedActionRequired,
			...safeNoAction,
		},
		completeness: {
			selectedThreads,
			selection: selectionCompleteness,
			indexHistory,
			discovery,
		},
		next,
		selection: {
			candidateThreads: input.selection.candidateThreads,
			returnedThreads: input.selection.returnedThreads,
			droppedThin: input.selection.droppedThin,
			droppedByBudget: input.selection.droppedByBudget,
			droppedByBudgetSubjectMatched:
				input.selection.droppedByBudgetSubjectMatched,
			droppedNoMatch: input.selection.droppedNoMatch,
			droppedCandidates: input.selection.droppedCandidates,
		},
		packing: {
			omittedPosts,
			largestSkip,
			recommendedHydrationThreadIds: recommendFullThreadIds,
			recommendFullThreadIds,
		},
		...(history ? { history } : {}),
	};
}

/** Prefer the most actionable cause when several axes would set the flag. */
function resolveMayHaveMissedReason(input: {
	discovery: EvidenceDiscoveryCurrency;
	indexHistory: EvidenceIndexHistory;
	packetTrusted: boolean;
	droppedByBudgetSubjectMatched: number;
}): EvidenceMayHaveMissedReason | undefined {
	if (input.droppedByBudgetSubjectMatched > 0) {
		return "subject_matched_budget_drops";
	}
	if (input.discovery === "local_only") return "local_discovery";
	if (input.discovery === "possibly_stale") return "stale_discovery";
	if (input.indexHistory === "cutoff_bounded" && !input.packetTrusted) {
		return "index_cutoff";
	}
	return undefined;
}

/**
 * Every `true` verdict flag must either point at a `next` step or declare that
 * no safe follow-up exists. Without this, agents stall on a lit flag with an
 * empty `next[]`.
 */
function resolveVerdictNoAction(input: {
	mayHaveMissedOtherThreads: boolean;
	mayHaveMissedReason: EvidenceMayHaveMissedReason | undefined;
	selectedEvidenceMayBeStale: boolean;
	canAnswerFromSelectedEvidence: boolean;
	next: readonly EvidenceNextStep[];
}): { noActionAvailable: true; noActionReason: string } | undefined {
	const actions = new Set(input.next.map(({ action }) => action));
	if (input.mayHaveMissedOtherThreads) {
		const covered =
			actions.has("inspect_dropped") ||
			actions.has("review_candidates") ||
			actions.has("sync") ||
			actions.has("fresh_or_remote");
		if (!covered) {
			return {
				noActionAvailable: true,
				noActionReason: mayHaveMissedNoActionReason(input.mayHaveMissedReason),
			};
		}
	}
	if (input.selectedEvidenceMayBeStale && !actions.has("fresh_or_remote")) {
		return {
			noActionAvailable: true,
			noActionReason:
				"selected evidence may be stale but no refresh step is available for this packet",
		};
	}
	if (
		!input.canAnswerFromSelectedEvidence &&
		!actions.has("thread_around") &&
		!actions.has("thread_full") &&
		!actions.has("read_attachments")
	) {
		// Empty / thin packets and complete-but-unusable selections already
		// expose adequacy; only flag when nothing explains the gap.
		if (input.next.length === 0) {
			return {
				noActionAvailable: true,
				noActionReason:
					"selected evidence is not answerable and no follow-up command is available",
			};
		}
	}
	return undefined;
}

function mayHaveMissedNoActionReason(
	reason: EvidenceMayHaveMissedReason | undefined,
): string {
	switch (reason) {
		case "index_cutoff":
			return "index history is cutoff-bounded; no channel-scoped sync step is available";
		case "stale_discovery":
			return "discovery may be stale; no refresh step is available for this packet";
		case "local_discovery":
			return "discovery used the local index only; no refresh step is available for this packet";
		case "subject_matched_budget_drops":
			return "subject-matched candidates were dropped by budget but no review_candidates or inspect_dropped step is available";
		default:
			return "mayHaveMissedOtherThreads is set but no follow-up command is available";
	}
}

/** Cutoff-bounded conversations reported per packet. */
const CUTOFF_BOUNDED_REPORT_CAP = 8;

/**
 * Selected-thread conversations first, then alias order: a bounded channel that
 * actually carried returned evidence is the one worth acting on.
 */
function buildHistory(
	freshness: readonly FreshnessEvidence[],
	threads: readonly ContextThread[],
): EvidenceHistory | undefined {
	const bounded = freshness.filter(({ coverageComplete }) => !coverageComplete);
	if (!bounded.length) return undefined;
	const selectedIds = new Set(
		threads.map(({ conversationId }) => conversationId),
	);
	const entries = bounded
		.map((item) => ({
			alias: item.alias,
			conversationId: item.conversationId,
			...(item.oldestCoveredAt
				? { oldestIndexedAt: new Date(item.oldestCoveredAt).toISOString() }
				: {}),
			inSelectedThreads: selectedIds.has(item.conversationId),
		}))
		.sort(
			(left, right) =>
				Number(right.inSelectedThreads) - Number(left.inSelectedThreads) ||
				left.alias.localeCompare(right.alias),
		);
	const additional = entries.length - CUTOFF_BOUNDED_REPORT_CAP;
	return {
		cutoffBounded: entries.slice(0, CUTOFF_BOUNDED_REPORT_CAP),
		...(additional > 0 ? { additional } : {}),
	};
}

/** One media-only post whose file is the thread's unread last word. */
interface UnreadOutcomeAttachment {
	threadId: string;
	postId: string;
	fileId: string;
	fileName: string;
	files: number;
}

/**
 * Media-only posts that land on the outcome side of the thread: after the last
 * packed mention of the subject ticket, or — with no subject ticket — as the
 * very last packed post. Such a post reads as empty in the timeline while
 * carrying the evidence that may contradict the surrounding text, so it is
 * worth one recommended download. Earlier media-only posts stay silent: they
 * are already visible as `mediaOnly` messages and in `attachments[]`.
 */
function findUnreadOutcomeAttachment(
	threads: readonly ContextThread[],
	subjectTicket?: string,
	resolvedFileIds: ReadonlySet<string> = new Set(),
): UnreadOutcomeAttachment | undefined {
	const subject = subjectTicket?.toUpperCase();
	let best: (UnreadOutcomeAttachment & { createAt: number }) | undefined;
	for (const thread of threads) {
		const posts = [...thread.posts].sort(
			(left, right) =>
				left.createAt - right.createAt || left.id.localeCompare(right.id),
		);
		let anchorIndex = -1;
		if (subject) {
			for (const [index, post] of posts.entries()) {
				if (extractTicketKeys(post.message).includes(subject))
					anchorIndex = index;
			}
			if (anchorIndex < 0) continue;
		} else {
			anchorIndex = posts.length - 2;
		}
		for (const post of posts.slice(anchorIndex + 1)) {
			if (!isMediaOnlyPost(post)) continue;
			const live = post.attachments.filter(
				({ deleteAt, id }) => !deleteAt && !resolvedFileIds.has(id),
			);
			const first = live[0];
			if (!first) continue;
			const candidate = {
				threadId: thread.threadId,
				postId: post.id,
				fileId: first.id,
				fileName: first.name,
				files: live.length,
				createAt: post.createAt,
			};
			if (
				!best ||
				candidate.createAt > best.createAt ||
				(candidate.createAt === best.createAt && candidate.postId < best.postId)
			) {
				best = candidate;
			}
		}
	}
	if (!best) return undefined;
	const { createAt: _createAt, ...found } = best;
	return found;
}

/**
 * Extensions whose content is the claim rather than an illustration of it. A
 * spreadsheet of duplicates or a log excerpt cannot be summarized from the post
 * text that links to it — "вот дубли" plus an XLSX is one sentence and several
 * hundred rows of evidence.
 */
const DATA_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
	"csv",
	"tsv",
	"xlsx",
	"xls",
	"ods",
	"json",
	"ndjson",
	"log",
	"sql",
	"txt",
]);

/** Workbook formats mm never parses as a bounded preview (OLE / ODF). */
const UNPREVIEWABLE_SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set([
	"xls",
	"ods",
]);

/**
 * A data file hanging off a decision-layer post (a decision, its refinements,
 * an open question, or the outcome window).
 *
 * `read_attachments` used to fire only for media-only posts, so a post that
 * *had* text — "вот дубли, посмотри" with the spreadsheet attached — was never
 * recommended, even though the file carried the quantitative claim the text only
 * gestured at. Deliberately narrow: only the decision layer, only data
 * extensions, and never a post already covered by the media-only rule.
 */
function findDecisionDataAttachment(
	threads: readonly ContextThread[],
	subjectTicket: string | undefined,
	excludePostId: string | undefined,
	resolvedFileIds: ReadonlySet<string> = new Set(),
): UnreadOutcomeAttachment | undefined {
	let best: (UnreadOutcomeAttachment & { createAt: number }) | undefined;
	for (const thread of threads) {
		const brief = buildThreadBrief(thread.posts, {
			...(subjectTicket ? { subjectTicket } : {}),
			omittedPosts: thread.omittedPosts,
		});
		// Built explicitly rather than via `briefRetainedPostIds`, whose fallback
		// keeps the last packed post when a thread yielded no brief at all — that
		// would make every thread's tail a "decision-layer" post.
		// `outcomeWindow` is deliberately excluded: it is every packed post after
		// the last ticket mention, which on a short thread is most of the thread.
		// Only posts the brief actually flagged qualify.
		const decisionLayer = new Set<string>([
			...brief.decisionPostIds,
			...(brief.decisions ?? []).flatMap((decision) => [
				decision.postId,
				...(decision.refinements ?? []).map(({ postId }) => postId),
			]),
			...(brief.openQuestions ?? []).map(({ postId }) => postId),
		]);
		for (const post of thread.posts) {
			if (post.id === excludePostId) continue;
			if (!decisionLayer.has(post.id)) continue;
			const live = post.attachments.filter(
				({ deleteAt, name, id }) =>
					!deleteAt && isDataFileName(name) && !resolvedFileIds.has(id),
			);
			const first = live[0];
			if (!first) continue;
			const candidate = {
				threadId: thread.threadId,
				postId: post.id,
				fileId: first.id,
				fileName: first.name,
				files: live.length,
				createAt: post.createAt,
			};
			if (
				!best ||
				candidate.createAt > best.createAt ||
				(candidate.createAt === best.createAt && candidate.postId < best.postId)
			) {
				best = candidate;
			}
		}
	}
	if (!best) return undefined;
	const { createAt: _createAt, ...found } = best;
	return found;
}

/**
 * An image on a decision-layer post that still has caption text (so the
 * media-only rule never fired). Screenshots next to option lists / bug reports
 * are frequently the actual evidence; recommend bounded OCR/inspect.
 */
function findDecisionImageAttachment(
	threads: readonly ContextThread[],
	subjectTicket: string | undefined,
	excludePostId: string | undefined,
	resolvedFileIds: ReadonlySet<string> = new Set(),
): UnreadOutcomeAttachment | undefined {
	let best: (UnreadOutcomeAttachment & { createAt: number }) | undefined;
	for (const thread of threads) {
		const brief = buildThreadBrief(thread.posts, {
			...(subjectTicket ? { subjectTicket } : {}),
			omittedPosts: thread.omittedPosts,
		});
		const decisionLayer = new Set<string>([
			...brief.decisionPostIds,
			...(brief.decisions ?? []).flatMap((decision) => [
				decision.postId,
				...(decision.refinements ?? []).map(({ postId }) => postId),
			]),
			...(brief.openQuestions ?? []).map(({ postId }) => postId),
		]);
		for (const post of thread.posts) {
			if (post.id === excludePostId) continue;
			if (!decisionLayer.has(post.id)) continue;
			// Media-only posts are already covered by findUnreadOutcomeAttachment.
			if (!post.message.trim()) continue;
			const live = post.attachments.filter(
				({ deleteAt, name, id }) =>
					!deleteAt && isImageFileName(name) && !resolvedFileIds.has(id),
			);
			const first = live[0];
			if (!first) continue;
			const candidate = {
				threadId: thread.threadId,
				postId: post.id,
				fileId: first.id,
				fileName: first.name,
				files: live.length,
				createAt: post.createAt,
			};
			if (
				!best ||
				candidate.createAt > best.createAt ||
				(candidate.createAt === best.createAt && candidate.postId < best.postId)
			) {
				best = candidate;
			}
		}
	}
	if (!best) return undefined;
	const { createAt: _createAt, ...found } = best;
	return found;
}

const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"svg",
]);

function isDataFileName(name: string): boolean {
	const extension = name.split(".").pop()?.toLowerCase();
	return Boolean(extension && DATA_FILE_EXTENSIONS.has(extension));
}

function isImageFileName(name: string): boolean {
	const extension = name.split(".").pop()?.toLowerCase();
	return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}

function isSpreadsheetDataFileName(name: string): boolean {
	const extension = name.split(".").pop()?.toLowerCase();
	return Boolean(
		extension &&
			(extension === "xlsx" ||
				UNPREVIEWABLE_SPREADSHEET_EXTENSIONS.has(extension)),
	);
}

/** Formats `file --inspect` downloads but cannot interpret as primary evidence. */
function requiresExternalReader(fileName: string): boolean {
	const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
	return (
		IMAGE_FILE_EXTENSIONS.has(extension) ||
		UNPREVIEWABLE_SPREADSHEET_EXTENSIONS.has(extension)
	);
}

function attachmentCommand(attachment: UnreadOutcomeAttachment): string[] {
	return ["mm", "file", attachment.fileId, "--inspect", "--agent"];
}

function attachmentNextStep(
	attachment: UnreadOutcomeAttachment,
	input: {
		reason: string;
		/** Priority when the file is directly interpretable via `--inspect`. */
		interpretablePriority: EvidenceNextPriority;
		interpretableImpact: EvidenceNextImpact;
		/**
		 * Keep `interpretablePriority` even when an external reader / OCR is
		 * required. Media-only outcome screenshots stay recommended so agents
		 * (and `--follow-recommended`) attempt them before claiming answerable.
		 */
		keepRecommendedWhenExternal?: boolean;
	},
): EvidenceNextStep {
	const external = requiresExternalReader(attachment.fileName);
	const demoteExternal = external && !input.keepRecommendedWhenExternal;
	return {
		action: "read_attachments",
		reason: input.reason,
		priority: demoteExternal ? "optional" : input.interpretablePriority,
		impact: external ? "requires_external_reader" : input.interpretableImpact,
		command: attachmentCommand(attachment),
		threadId: attachment.threadId,
		postId: attachment.postId,
	};
}

export function shouldRecommendFull(thread: {
	omittedPosts: number;
	totalPosts: number;
	timeline: ContextThread["timeline"];
}): boolean {
	if (thread.omittedPosts <= 0) return false;
	const largestSkip = largestTimelineSkip(thread.timeline);
	const omittedRatio =
		thread.totalPosts > 0 ? thread.omittedPosts / thread.totalPosts : 0;
	return (
		omittedRatio >= RECOMMEND_FULL_MIN_OMITTED_RATIO ||
		largestSkip >= RECOMMEND_FULL_MIN_LARGEST_SKIP
	);
}

/**
 * Truncated threads ordered so the single recommended `thread_full` is the most
 * valuable one: primary thread first, then the widest skip, then the largest
 * omitted ratio, then thread id for determinism.
 */
function rankTruncatedThreads(
	threads: readonly ContextThread[],
	primaryThreadId: string | undefined,
): ContextThread[] {
	return [...threads].sort((left, right) => {
		const leftPrimary = left.threadId === primaryThreadId ? 0 : 1;
		const rightPrimary = right.threadId === primaryThreadId ? 0 : 1;
		const leftRatio =
			left.totalPosts > 0 ? left.omittedPosts / left.totalPosts : 0;
		const rightRatio =
			right.totalPosts > 0 ? right.omittedPosts / right.totalPosts : 0;
		return (
			leftPrimary - rightPrimary ||
			largestTimelineSkip(right.timeline) -
				largestTimelineSkip(left.timeline) ||
			rightRatio - leftRatio ||
			left.threadId.localeCompare(right.threadId)
		);
	});
}

const MAX_TARGETED_AROUND_POSTS = MAX_AROUND_SIDE_POSTS;

/**
 * Prefer one bounded omitted range over replaying the complete thread. The kept
 * post before an internal/trailing skip is the preferred `--around` anchor, so
 * normal chronological selection starts with the nearest omitted posts. A
 * leading skip uses the kept post after it. Side-post counts are capped by both
 * {@link MAX_TARGETED_AROUND_POSTS} and the thread's character budget so the
 * recommended argv is expected to fit; fall back to `--full` only when no
 * usable boundary exists.
 *
 * Skip choice prefers gaps that recover truncated decision/open-question text
 * or `responseExcerpts` anchors over merely the largest skip.
 */
function targetedHydrationStep(
	thread: ContextThread,
	recommended: boolean,
): EvidenceNextStep {
	const brief = buildThreadBrief(thread.posts, {
		omittedPosts: thread.omittedPosts,
		reasons: thread.reasons,
	});
	const highValuePostIds = highValueGapAnchorIds(brief);
	const skips = thread.timeline
		.filter((item) => item.kind === "skip")
		.map(({ skip }) => skip)
		.sort((left, right) => {
			const leftValue = skipGapValue(left, highValuePostIds);
			const rightValue = skipGapValue(right, highValuePostIds);
			return rightValue - leftValue || right.posts - left.posts;
		});
	const skip = skips[0];
	const priority = recommended ? "recommended" : "optional";
	const averagePostUnits = estimateAveragePostUnits(thread.posts);
	const characterBudget = thread.budget.limit;
	const sidePosts = (requested: number) =>
		budgetAwareAroundSidePosts({
			requestedSidePosts: Math.min(requested, MAX_TARGETED_AROUND_POSTS),
			characterBudget,
			averagePostUnits,
		});
	if (skip?.after) {
		const afterPosts = sidePosts(skip.posts);
		return {
			action: "thread_around",
			reason: "packing_incomplete_range",
			priority,
			impact: "may_recover_omitted_core",
			command: [
				"mm",
				"thread",
				thread.threadId,
				"--around",
				skip.after,
				"--before-posts",
				"0",
				"--after-posts",
				String(afterPosts),
				"--window-only",
				"--agent",
			],
			threadId: thread.threadId,
		};
	}
	if (skip?.before) {
		const beforePosts = sidePosts(skip.posts);
		return {
			action: "thread_around",
			reason: "packing_incomplete_range",
			priority,
			impact: "may_recover_omitted_core",
			command: [
				"mm",
				"thread",
				thread.threadId,
				"--around",
				skip.before,
				"--before-posts",
				String(beforePosts),
				"--after-posts",
				"0",
				"--window-only",
				"--agent",
			],
			threadId: thread.threadId,
		};
	}
	return {
		action: "thread_full",
		reason: "packing_incomplete",
		priority,
		impact: "may_recover_omitted_core",
		command: ["mm", "thread", thread.threadId, "--full", "--agent"],
		threadId: thread.threadId,
	};
}

/** Post ids whose neighboring skip is more valuable than raw size. */
function highValueGapAnchorIds(brief: ReturnType<typeof buildThreadBrief>): {
	truncatedDecisionOrQuestion: ReadonlySet<string>;
	responseAnchors: ReadonlySet<string>;
} {
	const truncatedDecisionOrQuestion = new Set<string>();
	const responseAnchors = new Set<string>();
	for (const decision of brief.decisions ?? []) {
		if (decision.excerptTruncated)
			truncatedDecisionOrQuestion.add(decision.postId);
	}
	for (const question of brief.openQuestions ?? []) {
		if (question.excerptTruncated)
			truncatedDecisionOrQuestion.add(question.postId);
		for (const id of question.responsePostIds ?? []) responseAnchors.add(id);
	}
	return { truncatedDecisionOrQuestion, responseAnchors };
}

function skipGapValue(
	skip: { after?: string; before?: string; posts: number },
	anchors: {
		truncatedDecisionOrQuestion: ReadonlySet<string>;
		responseAnchors: ReadonlySet<string>;
	},
): number {
	const neighbors = [skip.after, skip.before].filter((id): id is string =>
		Boolean(id),
	);
	let value = 0;
	for (const id of neighbors) {
		if (anchors.truncatedDecisionOrQuestion.has(id)) value += 100;
		if (anchors.responseAnchors.has(id)) value += 50;
	}
	return value;
}

function collectNextActions(input: {
	/** Truncated threads, best first; only the first is `recommended`. */
	rankedTruncated: readonly ContextThread[];
	/** Usable, complete inside the selected threads, and current. */
	packetTrusted: boolean;
	cutoffBoundedConversations: number;
	staleRouted: number;
	localFallback: boolean;
	localMode: boolean;
	remoteFailures: number;
	remoteSearchSuccessful: boolean;
	selectedEvidenceCurrent: boolean;
	adequacy: EvidenceAdequacy;
	currency: EvidenceCurrency;
	selectedThreadsComplete: boolean;
	selectionCompleteness: EvidenceSelectionCompleteness;
	selectionCounts: SelectionEvidence;
	selectedMessages: readonly string[];
	droppedCandidates: readonly DroppedCandidate[];
	freshness: readonly FreshnessEvidence[];
	warningKinds: ReadonlySet<string>;
	subject?: string;
	unreadOutcomeAttachment?: UnreadOutcomeAttachment;
	decisionDataAttachment?: UnreadOutcomeAttachment;
	decisionImageAttachment?: UnreadOutcomeAttachment;
}): EvidenceNextStep[] {
	const next: EvidenceNextStep[] = [];
	const attachment = input.unreadOutcomeAttachment;
	if (attachment) {
		next.push(
			attachmentNextStep(attachment, {
				reason:
					attachment.files > 1
						? "media_only_outcome_post_multiple_files"
						: "media_only_outcome_post",
				interpretablePriority: "recommended",
				interpretableImpact: "may_contradict_visible_text",
				keepRecommendedWhenExternal: true,
			}),
		);
	}
	const dataFile = input.decisionDataAttachment;
	if (dataFile) {
		next.push(
			attachmentNextStep(dataFile, {
				reason: "data_file_on_decision_post",
				// A media-only post is unreadable without its file; this post has text,
				// so it is the second call to make, not the first.
				interpretablePriority: attachment ? "optional" : "recommended",
				interpretableImpact: isSpreadsheetDataFileName(dataFile.fileName)
					? "cannot_verify_quantities"
					: "may_verify_quantitative_claim",
			}),
		);
	}
	const decisionImage = input.decisionImageAttachment;
	if (decisionImage) {
		next.push(
			attachmentNextStep(decisionImage, {
				reason: "image_on_decision_post",
				interpretablePriority:
					attachment || dataFile ? "optional" : "recommended",
				interpretableImpact: "may_contradict_visible_text",
				keepRecommendedWhenExternal: true,
			}),
		);
	}
	for (const [index, thread] of input.rankedTruncated.entries()) {
		next.push(targetedHydrationStep(thread, index === 0));
	}
	const historyIncomplete =
		input.cutoffBoundedConversations > 0 ||
		input.warningKinds.has("incomplete_history");
	if (historyIncomplete && !input.packetTrusted) {
		const incomplete = input.freshness.filter(
			({ coverageComplete }) => !coverageComplete,
		);
		const conversationId = incomplete[0]?.conversationId;
		const uniqueChannelAlias =
			incomplete.length === 1 ? incomplete[0]?.alias : undefined;
		next.push({
			action: "sync",
			reason: "incomplete_history",
			priority: "optional",
			impact: "older_discovery_only",
			command: uniqueChannelAlias
				? ["mm", "sync", "--channel", uniqueChannelAlias, "--agent"]
				: ["mm", "sync", "--agent"],
			...(conversationId ? { conversationId } : {}),
		});
	}
	const actionableDropped = input.droppedCandidates.find(
		(candidate) =>
			isActionableDroppedCandidate(candidate) &&
			shouldRecommendInspectDropped(candidate, input.selectedMessages),
	);
	// When subject-matched budget drops set mayHaveMissedOtherThreads but no
	// thin/ticket inspect fired, point at the best budget drop that still adds
	// an unseen excerpt. Promote to recommended — the flag already says real
	// subject evidence may be missing.
	const subjectMatchedBudgetDrop =
		!actionableDropped &&
		input.selectionCounts.droppedByBudgetSubjectMatched > 0
			? input.droppedCandidates.find(
					(candidate) =>
						isSubjectMatchedBudgetDrop(candidate) &&
						shouldRecommendInspectDropped(candidate, input.selectedMessages),
				)
			: undefined;
	const inspectDropped = actionableDropped ?? subjectMatchedBudgetDrop;
	if (inspectDropped) {
		const droppedThreadId = inspectDropped.threadId;
		const subjectMatchedOnly =
			!actionableDropped && subjectMatchedBudgetDrop !== undefined;
		next.push({
			action: "inspect_dropped",
			reason: subjectMatchedOnly
				? "subject_matched_budget_drops"
				: "selection_dropped",
			priority: subjectMatchedOnly ? "recommended" : "optional",
			impact: "may_add_dropped_pointer",
			...(droppedThreadId
				? {
						command: ["mm", "thread", droppedThreadId, "--agent"],
						threadId: droppedThreadId,
					}
				: {}),
		});
	}
	// Always recommend a higher --max-threads re-run when subject-matched
	// candidates were budget-dropped — even if inspect_dropped was withheld for
	// a thin bulletin — so --follow-recommended can bump the selection cap.
	if (
		input.selectionCounts.droppedByBudgetSubjectMatched > 0 &&
		input.subject
	) {
		const bumpedMaxThreads = Math.min(
			20,
			Math.max(
				5,
				input.selectionCounts.returnedThreads +
					input.selectionCounts.droppedByBudgetSubjectMatched,
			),
		);
		next.push({
			action: "review_candidates",
			reason: "subject_matched_budget_drops",
			priority: "recommended",
			impact: "may_add_dropped_pointer",
			command: [
				"mm",
				"context",
				input.subject,
				"--max-threads",
				String(bumpedMaxThreads),
				"--agent",
			],
		});
	}
	if (
		input.selectionCompleteness === "budget_bounded" &&
		input.selectionCounts.droppedByBudget >=
			SELECTION_REVIEW_MIN_DROPPED_BY_BUDGET &&
		input.selectionCounts.droppedByBudget >
			input.selectionCounts.returnedThreads
	) {
		// The packet cannot speak for candidates it never examined; `search` lists
		// them without spending this request's packing budget.
		next.push({
			action: "review_candidates",
			reason: "selection_budget_bounded",
			priority: "optional",
			impact: "may_add_dropped_pointer",
			...(input.subject
				? { command: ["mm", "search", input.subject, "--agent"] }
				: {}),
		});
	}
	if (
		input.localFallback ||
		input.remoteFailures > 0 ||
		(input.staleRouted > 0 &&
			(input.localMode ||
				(!input.remoteSearchSuccessful &&
					(!input.selectedEvidenceCurrent || input.adequacy !== "usable"))))
	) {
		next.push({
			action: "fresh_or_remote",
			reason: input.localFallback
				? "local_index_fallback"
				: input.remoteFailures > 0
					? "remote_search_failed"
					: "stale_local_index",
			priority: "optional",
			impact: "may_refresh_selected_or_discovery",
			...(input.subject
				? {
						command: ["mm", "context", input.subject, "--fresh", "--agent"],
					}
				: {}),
		});
	}
	return next;
}

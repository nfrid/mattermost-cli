/**
 * Finding the attachments an evidence reader must not miss: unread files on a
 * decision or outcome post, data workbooks whose numbers the packet cannot
 * verify, and images that need an external reader.
 *
 * Split out of `evidence.ts`, where roughly 300 lines of file-extension policy
 * sat between the verdict logic and the next-step builder.
 */
import { extractTicketKeys } from "../../text/index.ts";
import { isMediaOnlyPost } from "../packing.ts";
import { buildThreadBrief } from "../signals.ts";
import type {
	ContextThread,
	EvidenceNextImpact,
	EvidenceNextPriority,
	EvidenceNextStep,
} from "../types.ts";

/**
 * The types this module produces live in `./types.ts` (see the note there).
 * Re-exported so `evidence/evidence.ts` stays the documented import site.
 */
export type * from "../types.ts";

/** One media-only post whose file is the thread's unread last word. */
export interface UnreadOutcomeAttachment {
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
export function findUnreadOutcomeAttachment(
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
export const DATA_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
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
export const UNPREVIEWABLE_SPREADSHEET_EXTENSIONS: ReadonlySet<string> =
	new Set(["xls", "ods"]);

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
export function findDecisionDataAttachment(
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
export function findDecisionImageAttachment(
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

export const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"svg",
]);

export function isDataFileName(name: string): boolean {
	const extension = name.split(".").pop()?.toLowerCase();
	return Boolean(extension && DATA_FILE_EXTENSIONS.has(extension));
}

export function isImageFileName(name: string): boolean {
	const extension = name.split(".").pop()?.toLowerCase();
	return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}

export function isSpreadsheetDataFileName(name: string): boolean {
	const extension = name.split(".").pop()?.toLowerCase();
	return Boolean(
		extension &&
			(extension === "xlsx" ||
				UNPREVIEWABLE_SPREADSHEET_EXTENSIONS.has(extension)),
	);
}

/** Formats `file --inspect` downloads but cannot interpret as primary evidence. */
export function requiresExternalReader(fileName: string): boolean {
	const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
	return (
		IMAGE_FILE_EXTENSIONS.has(extension) ||
		UNPREVIEWABLE_SPREADSHEET_EXTENSIONS.has(extension)
	);
}

export function attachmentCommand(
	attachment: UnreadOutcomeAttachment,
): string[] {
	return ["mm", "file", attachment.fileId, "--inspect", "--agent"];
}

export function attachmentNextStep(
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

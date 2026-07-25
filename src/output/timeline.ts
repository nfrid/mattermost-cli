import type { ContextThread } from "../context/index.ts";
import { isMediaOnlyPost, type PackedPost } from "../evidence/packing.ts";
import { briefRetainedPostIds, buildThreadBrief } from "../evidence/signals.ts";
import { fileDownloadCommand } from "./agent/messages.ts";
import type { AgentFile } from "./agent/types.ts";
import { isoTimestamp } from "./shared.ts";

/**
 * One event in the merged cross-thread chronology. Threads are ranked, not
 * ordered in time, so a packet read thread-by-thread routinely presents a
 * rollout announcement after the report that it broke. Every event carries its
 * conversation, so merging never costs attribution.
 */
export interface AgentTimelineEvent {
	at: string;
	conversation: string;
	threadId: string;
	author: string;
	postId: string;
	text: string;
	editedAt?: string;
	deleted?: true;
	/** The post this request resolved to (post id or permalink subject). */
	anchor?: true;
	/** The post has no text — its attachment is the whole message. */
	mediaOnly?: true;
	files?: AgentFile[];
}

/**
 * A packing skip, placed where it belongs in the merged order. `at` is the
 * timestamp of the last post before the gap, so the marker never claims a time
 * of its own.
 */
export interface AgentTimelineGap {
	at: string;
	conversation: string;
	threadId: string;
	skip: {
		posts: number;
		after?: string;
		before?: string;
		reason?: string;
		files?: number;
	};
}

export type AgentTimelineEntry = AgentTimelineEvent | AgentTimelineGap;

/**
 * Merge selected threads into one chronology. With `brief`, only the posts the
 * decision layer retains take part, so `--timeline --brief` stays a decision
 * timeline rather than a full transcript in another order.
 */
export function buildCrossThreadTimeline(
	threads: readonly ContextThread[],
	options: {
		brief?: boolean;
		subjectTicket?: string;
		/** Requested post id; kept and marked wherever it lands. */
		anchorPostId?: string;
	} = {},
): AgentTimelineEntry[] {
	const entries: Array<{ entry: AgentTimelineEntry; at: number }> = [];
	for (const thread of threads) {
		const retained = options.brief
			? briefRetainedPostIds(
					buildThreadBrief(thread.posts, {
						subjectTicket: options.subjectTicket,
						reasons: thread.reasons,
						omittedPosts: thread.omittedPosts,
					}),
					thread.posts,
					options.anchorPostId,
				)
			: undefined;
		let lastAt: number | undefined;
		for (const [itemIndex, item] of thread.timeline.entries()) {
			if (item.kind === "skip") {
				// A leading skip has no post before it: borrow the time of the post it
				// precedes, or the whole gap sorts to the epoch and leads the packet.
				const at = lastAt ?? nextPostTime(thread.timeline, itemIndex) ?? 0;
				entries.push({
					at,
					entry: {
						at: isoTimestamp(at),
						conversation: thread.conversationAlias,
						threadId: thread.threadId,
						skip: item.skip,
					},
				});
				continue;
			}
			lastAt = item.post.createAt;
			if (retained && !retained.has(item.post.id)) continue;
			entries.push({
				at: item.post.createAt,
				entry: eventFromPost(
					item.post,
					thread.conversationAlias,
					thread.threadId,
					options.anchorPostId,
				),
			});
		}
	}
	// Stable sort: entries are pushed thread-then-item, so equal timestamps keep
	// their in-thread order without a synthetic tiebreaker.
	return entries
		.sort((left, right) => left.at - right.at)
		.map(({ entry }) => entry);
}

function nextPostTime(
	timeline: ContextThread["timeline"],
	from: number,
): number | undefined {
	for (const item of timeline.slice(from + 1)) {
		if (item.kind !== "skip") return item.post.createAt;
	}
	return undefined;
}

function eventFromPost(
	post: PackedPost,
	conversation: string,
	threadId: string,
	anchorPostId?: string,
): AgentTimelineEvent {
	const files = post.attachments.filter(({ deleteAt }) => !deleteAt);
	return {
		at: isoTimestamp(post.createAt),
		conversation,
		threadId,
		author: post.authorUsername,
		postId: post.id,
		text: post.message,
		...(post.updateAt > post.createAt
			? { editedAt: isoTimestamp(post.updateAt) }
			: {}),
		...(post.deleteAt ? { deleted: true as const } : {}),
		...(post.id === anchorPostId ? { anchor: true as const } : {}),
		...(isMediaOnlyPost(post) ? { mediaOnly: true as const } : {}),
		...(files.length
			? {
					files: files.map(
						(file): AgentFile => ({
							id: file.id,
							name: file.name,
							...(file.mimeType ? { mimeType: file.mimeType } : {}),
							...(Number.isFinite(file.size) ? { size: file.size } : {}),
							downloadCommand: fileDownloadCommand(file.id),
						}),
					),
				}
			: {}),
	};
}

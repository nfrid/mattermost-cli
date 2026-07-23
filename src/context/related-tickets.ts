import type { MattermostConfig } from "../config/config.ts";
import { segmentThreadByTicketProximity } from "../evidence/ticket-segments.ts";
import {
	extractTicketKeys,
	MULTI_TICKET_BULLETIN_MIN_KEYS,
} from "../search/extract.ts";
import {
	POINTER_EXCERPT_LIMIT,
	truncateExcerpt,
} from "../search/match-utils.ts";
import type { MattermostStore } from "../store/index.ts";
import { postLink } from "./helpers.ts";
import type { ContextThread, RelatedTicketPointer } from "./types.ts";

const RELATED_TICKET_HOP_LIMIT = 3;

export function resolveRelatedTicketPointers(input: {
	config: MattermostConfig;
	store: MattermostStore;
	threads: readonly ContextThread[];
	subjectTicket?: string;
	allowlist: ReadonlySet<string>;
}): RelatedTicketPointer[] {
	const subject = input.subjectTicket?.toUpperCase();
	type Mention = {
		key: string;
		postId: string;
		threadId: string;
		threadRank: number;
		conversationId: string;
		conversationAlias: string;
		createAt: number;
		excerpt: string;
		inWindow: boolean;
		multiTicketBulletin: boolean;
	};
	const mentions: Mention[] = [];
	for (const [threadRank, thread] of input.threads.entries()) {
		const rootKeys = extractTicketKeys(thread.posts[0]?.message ?? "");
		const windowIds = new Set(
			(thread.segments ?? [])
				.filter(
					(segment) =>
						segment.reason === "ticket_window" ||
						segment.reason === "match_window",
				)
				.flatMap((segment) => {
					const ids: string[] = [];
					let inside = false;
					for (const post of thread.posts) {
						if (post.id === segment.startPostId) inside = true;
						if (inside) ids.push(post.id);
						if (post.id === segment.endPostId) inside = false;
					}
					return ids;
				}),
		);
		for (const post of thread.posts) {
			const postKeys = extractTicketKeys(post.message);
			const multiTicketBulletin =
				postKeys.length >= MULTI_TICKET_BULLETIN_MIN_KEYS ||
				(post.id === thread.threadId &&
					rootKeys.length >= MULTI_TICKET_BULLETIN_MIN_KEYS);
			for (const key of postKeys) {
				if (key === subject) continue;
				mentions.push({
					key,
					postId: post.id,
					threadId: thread.threadId,
					threadRank,
					conversationId: thread.conversationId,
					conversationAlias: thread.conversationAlias,
					createAt: post.createAt,
					excerpt: truncateExcerpt(post.message, POINTER_EXCERPT_LIMIT),
					inWindow:
						windowIds.has(post.id) || thread.matchingPostIds.includes(post.id),
					multiTicketBulletin,
				});
			}
		}
	}
	if (!mentions.length) return [];

	const byKey = new Map<string, Mention[]>();
	for (const mention of mentions) {
		const list = byKey.get(mention.key) ?? [];
		list.push(mention);
		byKey.set(mention.key, list);
	}

	const rankedKeys = [...byKey.entries()]
		.map(([key, list]) => {
			const inWindow = list.filter((item) => item.inWindow).length;
			const bulletinOnly = list.every((item) => item.multiTicketBulletin);
			const bestThreadRank = Math.min(...list.map((item) => item.threadRank));
			const fromPrimary = bestThreadRank === 0;
			const latestAt = Math.max(...list.map((item) => item.createAt));
			const ordered = [...list].sort(
				(left, right) =>
					Number(left.multiTicketBulletin) -
						Number(right.multiTicketBulletin) ||
					left.threadRank - right.threadRank ||
					Number(right.inWindow) - Number(left.inWindow) ||
					left.createAt - right.createAt,
			);
			const first = ordered[0];
			if (!first) return null;
			return {
				key,
				mentions: list.length,
				inWindow,
				bulletinOnly,
				fromPrimary,
				bestThreadRank,
				latestAt,
				first,
			};
		})
		.filter(
			(
				entry,
			): entry is {
				key: string;
				mentions: number;
				inWindow: number;
				bulletinOnly: boolean;
				fromPrimary: boolean;
				bestThreadRank: number;
				latestAt: number;
				first: Mention;
			} => entry !== null,
		)
		.sort(
			(left, right) =>
				Number(left.bulletinOnly) - Number(right.bulletinOnly) ||
				Number(right.fromPrimary) - Number(left.fromPrimary) ||
				left.bestThreadRank - right.bestThreadRank ||
				right.inWindow - left.inWindow ||
				right.mentions - left.mentions ||
				right.latestAt - left.latestAt ||
				left.key.localeCompare(right.key),
		);
	const focused = rankedKeys.filter((entry) => !entry.bulletinOnly);
	const hopKeys =
		focused.length >= 2
			? focused.slice(0, RELATED_TICKET_HOP_LIMIT)
			: [
					...focused,
					...rankedKeys
						.filter((entry) => entry.bulletinOnly)
						.slice(0, RELATED_TICKET_HOP_LIMIT - focused.length),
				];

	const pointers: RelatedTicketPointer[] = [];
	for (const entry of hopKeys) {
		const relationships = input.store.getTicketRelationships(entry.key);
		const allowlisted = relationships.filter((relationship) => {
			const thread = input.store.getThread(relationship.threadId);
			const conversationId = thread[0]?.conversationId;
			return conversationId ? input.allowlist.has(conversationId) : false;
		});
		const bestThreadId =
			allowlisted[0]?.threadId ??
			(input.allowlist.has(entry.first.conversationId)
				? entry.first.threadId
				: undefined);
		if (!bestThreadId) {
			pointers.push({
				key: entry.key,
				mentions: entry.mentions,
				sourceThreadId: entry.first.threadId,
				hydrated: false,
				excerpt: entry.first.excerpt,
			});
			continue;
		}
		const posts = input.store.getThread(bestThreadId);
		const root = posts.find((post) => post.id === bestThreadId) ?? posts[0];
		const hit =
			posts.find((post) =>
				extractTicketKeys(post.message).includes(entry.key),
			) ?? root;
		const conversationId = root?.conversationId;
		const conversation = conversationId
			? input.store.listConversations().find(({ id }) => id === conversationId)
			: undefined;
		const latestAt = posts.reduce(
			(max, post) => Math.max(max, post.createAt, post.updateAt),
			0,
		);
		pointers.push({
			key: entry.key,
			mentions: entry.mentions,
			threadId: bestThreadId,
			url: postLink(input.config, bestThreadId),
			...(conversation ? { conversation: conversation.alias } : {}),
			...(latestAt ? { latestAt } : {}),
			excerpt: truncateExcerpt(
				hit?.message ?? entry.first.excerpt,
				POINTER_EXCERPT_LIMIT,
			),
			sourceThreadId: entry.first.threadId,
			hydrated: false,
		});
	}
	return pointers;
}

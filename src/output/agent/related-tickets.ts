import type { RelatedTicketPointer } from "../../context/types.ts";
import type { EvidencePost } from "../../evidence/packing.ts";
import { extractTicketKeys } from "../../search/extract.ts";
import { isoTimestamp } from "../shared.ts";
import type { AgentRelatedTicket } from "./types.ts";

export function projectRelatedTickets(
	pointers: readonly RelatedTicketPointer[] | undefined,
): AgentRelatedTicket[] {
	if (!pointers?.length) return [];
	return pointers.map((pointer) => ({
		key: pointer.key,
		mentions: pointer.mentions,
		...(pointer.threadId ? { threadId: pointer.threadId } : {}),
		...(pointer.url ? { url: pointer.url } : {}),
		...(pointer.trackerUrl ? { trackerUrl: pointer.trackerUrl } : {}),
		...(pointer.conversation ? { conversation: pointer.conversation } : {}),
		...(pointer.latestAt !== undefined
			? { latestAt: isoTimestamp(pointer.latestAt) }
			: {}),
		...(pointer.excerpt ? { excerpt: pointer.excerpt } : {}),
		...(pointer.sourceThreadId
			? { sourceThreadId: pointer.sourceThreadId }
			: {}),
		...(pointer.alreadyInPacket ? { alreadyInPacket: true as const } : {}),
		...(pointer.unresolvableTracker
			? { unresolvableTracker: true as const }
			: {}),
	}));
}

export function relatedTicketsFromPosts(
	posts: readonly EvidencePost[],
	subjectTicket?: string,
): AgentRelatedTicket[] {
	const keys = finalizeRelatedTicketKeys(
		new Set(posts.flatMap((post) => extractTicketKeys(post.message))),
		subjectTicket,
	);
	return keys.map((key) => ({ key, mentions: 1 }));
}

export function finalizeRelatedTicketKeys(
	keys: ReadonlySet<string>,
	subjectTicket?: string,
): string[] {
	const subject = subjectTicket?.toUpperCase();
	return [...keys]
		.filter((key) => key !== subject)
		.sort((left, right) => left.localeCompare(right));
}

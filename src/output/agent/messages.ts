import type {
	EvidencePost,
	PackedPost,
	PackTimelineItem,
} from "../../evidence/packing.ts";
import { isMediaOnlyPost } from "../../evidence/packing.ts";
import { isoTimestamp } from "../shared.ts";
import type {
	AgentFile,
	AgentMessage,
	AgentMessageGroup,
	AgentSkip,
	AgentTimelineItem,
} from "./types.ts";

/** Packed threads a `--short` packet draws its flat message list from. */
interface ShortMessageThread {
	timeline: readonly PackTimelineItem[];
}

export function fileDownloadCommand(id: string): string[] {
	return ["mm", "file", id, "--agent"];
}

export function fileInspectCommand(id: string): string[] {
	return ["mm", "file", id, "--inspect", "--agent"];
}

export function shortMessagesFromThreads(
	threads: readonly ShortMessageThread[],
	primaryIndex: number,
	limit: number,
): AgentMessage[] {
	const messages: AgentMessage[] = [];
	const order = [
		primaryIndex,
		...threads
			.map((_, index) => index)
			.filter((index) => index !== primaryIndex),
	];
	for (const index of order) {
		const thread = threads[index];
		if (!thread) continue;
		for (const item of thread.timeline) {
			if (item.kind !== "post") continue;
			messages.push(projectMessage(item.post));
			if (messages.length >= limit) return messages;
		}
	}
	return messages;
}

export function projectTimeline(
	timeline: readonly PackTimelineItem[],
	anchorPostId?: string,
): AgentTimelineItem[] {
	const items: AgentTimelineItem[] = [];
	let openGroup: AgentMessageGroup | undefined;

	const flushGroup = () => {
		if (openGroup) {
			items.push(openGroup);
			openGroup = undefined;
		}
	};

	for (const item of timeline) {
		if (item.kind === "skip") {
			flushGroup();
			items.push({ skip: item.skip });
			continue;
		}
		const message = projectMessage(item.post, anchorPostId);
		if (openGroup && openGroup.author === item.post.authorUsername) {
			openGroup.messages.push(message);
			continue;
		}
		flushGroup();
		openGroup = {
			author: item.post.authorUsername,
			messages: [message],
		};
	}
	flushGroup();
	return items;
}

export function groupEvidencePosts(
	posts: readonly EvidencePost[],
): AgentMessageGroup[] {
	return groupPosts(
		posts.map((post) => ({
			id: post.id,
			author: post.authorUsername,
			createAt: post.createAt,
			updateAt: post.updateAt,
			deleteAt: post.deleteAt,
			message: post.message,
			attachments: post.attachments,
		})),
	);
}

export function groupPosts(
	posts: readonly {
		id: string;
		author: string;
		createAt: number;
		updateAt: number;
		deleteAt: number;
		message: string;
		attachments: PackedPost["attachments"];
	}[],
): AgentMessageGroup[] {
	const groups: AgentMessageGroup[] = [];
	for (const post of posts) {
		const message = projectMessage(post);
		const previous = groups[groups.length - 1];
		if (previous && previous.author === post.author) {
			previous.messages.push(message);
			continue;
		}
		groups.push({
			author: post.author,
			messages: [message],
		});
	}
	return groups;
}

export function projectMessage(
	post: {
		id: string;
		createAt: number;
		updateAt: number;
		deleteAt: number;
		message: string;
		attachments: PackedPost["attachments"];
	},
	anchorPostId?: string,
): AgentMessage {
	const files = post.attachments.map((attachment) => projectFile(attachment));
	return {
		id: post.id,
		text: post.message,
		at: isoTimestamp(post.createAt),
		...(post.updateAt > post.createAt
			? { editedAt: isoTimestamp(post.updateAt) }
			: {}),
		...(post.deleteAt ? { deleted: true as const } : {}),
		...(isMediaOnlyPost(post) ? { mediaOnly: true as const } : {}),
		...(anchorPostId && post.id === anchorPostId
			? { anchor: true as const }
			: {}),
		...(files.length ? { files } : {}),
	};
}

export function projectFile(attachment: {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
}): AgentFile {
	return {
		id: attachment.id,
		name: attachment.name,
		...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
		...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
		downloadCommand: fileDownloadCommand(attachment.id),
		inspectCommand: fileInspectCommand(attachment.id),
	};
}

export function timelineSkips(
	timeline: readonly PackTimelineItem[],
): AgentSkip["skip"][] {
	return timeline
		.filter(
			(item): item is Extract<PackTimelineItem, { kind: "skip" }> =>
				item.kind === "skip",
		)
		.map((item) => item.skip);
}

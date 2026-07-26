import { isMediaOnlyPost, type PackedPost } from "../../evidence/packing.ts";
import { conversationLabel, isoTimestamp } from "../shared.ts";
import { styles } from "../styles.ts";

export function joinParts(parts: string[]): string {
	return parts.join(styles.hint(" · "));
}

export function formatField(label: string, value: string): string {
	return `${styles.hint(`${label}:`)} ${value}`;
}

export function formatHealth(
	healthy: boolean,
	success: string,
	failure: string,
): string {
	return healthy ? styles.success(success) : styles.error(failure);
}

export function formatCompleteness(
	complete: boolean,
	success = "complete",
	failure = "incomplete",
): string {
	return complete ? styles.success(success) : styles.warning(failure);
}

export function formatConversation(kind: string, alias: string): string {
	return styles.channel(conversationLabel(kind, alias));
}

export function formatPost(post: PackedPost): string[] {
	const body = post.deleteAt
		? styles.warning("[deleted]")
		: isMediaOnlyPost(post)
			? styles.warning("[no text — the attachment is the whole message]")
			: post.message;
	return [
		`${styles.timestamp(`[${isoTimestamp(post.createAt)}]`)} ${styles.username(`@${post.authorUsername}`)}: ${body}`,
		...post.attachments.map((attachment) =>
			joinParts([
				`${styles.warning("Attachment:")} ${styles.label(attachment.name)}`,
				styles.hint(attachment.mimeType),
				`${styles.accent(String(attachment.size))} bytes`,
				styles.identifier(attachment.id),
				styles.hint(`mm file ${attachment.id}`),
			]),
		),
	];
}

export function formatFilters(filters: {
	from?: string;
	after?: string;
	before?: string;
	hasFile?: boolean;
	file?: string;
}): string {
	const values = [
		filters.from ? `from=${filters.from}` : "",
		filters.after ? `after=${filters.after}` : "",
		filters.before ? `before=${filters.before}` : "",
		filters.hasFile ? "has-file" : "",
		filters.file ? `file=${filters.file}` : "",
	].filter(Boolean);
	return values.length
		? formatField(
				"Filters",
				values.map((value) => styles.accent(value)).join(", "),
			)
		: "";
}

export function formatOmittedAttachment(attachment: {
	name: string;
	mimeType: string;
	size: number;
	postId: string;
}): string {
	return joinParts([
		`${styles.warning("Omitted attachment:")} ${styles.label(attachment.name)}`,
		styles.hint(attachment.mimeType),
		`${styles.accent(String(attachment.size))} bytes`,
		`post ${styles.identifier(attachment.postId)}`,
	]);
}

/**
 * Marks a decision-layer text the packet had to cut. Without it the only sign
 * of loss is a trailing `…`, which an author may equally have typed themselves.
 */
export function truncatedTextHint(): string {
	return styles.warning("[text truncated — read the post]");
}

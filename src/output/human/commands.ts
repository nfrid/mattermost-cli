import type { SearchContextResult, ThreadResult } from "../../context/index.ts";
import type { PeopleResult } from "../../context/people.ts";
import { buildThreadBrief } from "../../evidence/signals.ts";
import type { FileBatchDownloadResult } from "../../sync/file-batch-download.ts";
import type { FileDownloadResult } from "../../sync/file-download.ts";
import type {
	ChannelValidationResult,
	ConfiguredConversationsResult,
	DoctorResult,
} from "../../sync/setup.ts";
import type { SyncResult } from "../../sync/sync.ts";
import { formatSubject, isoTimestamp } from "../shared.ts";
import { styles } from "../styles.ts";
import {
	formatBriefTimeline,
	formatDecisions,
	formatOpenQuestions,
	formatPurposeHints,
	formatSelectionStrategy,
	formatTimeline,
} from "./brief.ts";
import {
	formatCompleteness,
	formatConversation,
	formatField,
	formatFilters,
	formatHealth,
	formatOmittedAttachment,
	joinParts,
} from "./fields.ts";

export interface WhoamiResult {
	id: string;
	username: string;
	displayName: string;
}

export function formatWhoami(data: WhoamiResult): string {
	return joinParts([
		`${styles.label(data.displayName)} ${styles.username(`(@${data.username})`)}`,
		styles.identifier(data.id),
	]);
}

export function formatChannels(data: ConfiguredConversationsResult): string {
	const channels = data.channels.map((channel) =>
		joinParts([
			formatConversation("channel", channel.alias),
			channel.name,
			channel.id ? styles.identifier(channel.id) : styles.warning("unresolved"),
		]),
	);
	const directMessages = data.directMessages.map((directMessage) =>
		joinParts(
			[
				formatConversation("direct", directMessage.alias),
				directMessage.channelId
					? styles.identifier(directMessage.channelId)
					: undefined,
				directMessage.participants
					?.map((participant) => styles.username(participant))
					.join(", "),
			].filter((part): part is string => Boolean(part)),
		),
	);
	return [
		styles.label(`Channels (${styles.accent(String(channels.length))})`),
		...(channels.length ? channels : [styles.hint("(none)")]),
		styles.label(
			`Direct messages (${styles.accent(String(directMessages.length))})`,
		),
		...(directMessages.length ? directMessages : [styles.hint("(none)")]),
	].join("\n");
}

export function formatValidation(data: ChannelValidationResult): string {
	return [
		`${styles.label("Configured conversations:")} ${formatHealth(data.valid, "valid", "invalid")}`,
		...data.items.map((item) =>
			joinParts([
				formatHealth(item.valid, "OK", "FAIL"),
				styles.hint(item.kind),
				styles.channel(item.alias),
				item.resolvedId || item.configuredId
					? styles.identifier(item.resolvedId ?? item.configuredId ?? "")
					: styles.warning("unresolved"),
				...(item.error ? [styles.error(item.error)] : []),
			]),
		),
	].join("\n");
}

export function formatDoctor(data: DoctorResult): string {
	return [
		`${styles.label("Mattermost doctor:")} ${formatHealth(data.healthy, "healthy", "unhealthy")}`,
		...data.checks.map((check) =>
			joinParts([
				formatHealth(check.ok, "OK", "FAIL"),
				styles.label(check.name),
				check.message,
			]),
		),
	].join("\n");
}

export function formatSync(data: SyncResult): string {
	return [
		styles.success(
			`Synchronized ${data.conversations.length} conversation(s).`,
		),
		...data.conversations.map((conversation) =>
			joinParts([
				styles.channel(conversation.alias),
				styles.hint(conversation.mode),
				`${styles.accent(String(conversation.postsProcessed))} posts`,
				conversation.coverageComplete
					? styles.success("complete")
					: styles.warning("cutoff-bounded"),
			]),
		),
	].join("\n");
}

/** Aliases named inline before the scope line switches to a count. */
const SCOPE_ALIAS_LIMIT = 6;

export function formatPeople(data: PeopleResult): string {
	// A full alias roster is dozens of DMs long; name them only when the scope is
	// narrow enough that naming them is the point.
	const scope =
		data.conversations.length <= SCOPE_ALIAS_LIMIT
			? data.conversations.join(", ")
			: `${data.conversations.length} configured conversation(s)`;
	return [
		joinParts([
			styles.label("Mattermost people"),
			styles.accent(
				data.people.length < data.total
					? `${data.people.length}/${data.total}`
					: `${data.total}`,
			),
			styles.hint(scope),
		]),
		...(data.people.length
			? data.people.map((person) =>
					joinParts([
						styles.username(`@${person.username}`),
						person.displayName ?? "",
						person.role
							? `${styles.accent(person.role)} ${styles.hint(person.roleSource ?? "")}`
							: styles.hint("role unknown"),
						`${styles.accent(String(person.messages))} message(s)`,
						styles.timestamp(isoTimestamp(person.latestAt)),
						...(person.isBot ? [styles.warning("bot")] : []),
					]),
				)
			: [styles.hint("(none indexed)")]),
	].join("\n");
}

export function formatSearch(data: SearchContextResult): string {
	return [
		joinParts([
			styles.label("Mattermost search"),
			styles.accent(formatSubject(data.subject)),
			`${styles.accent(String(data.candidates.length))} thread(s)`,
			styles.hint("local"),
		]),
		joinParts([
			formatField("Routing", styles.accent(data.routing.reason)),
			formatField(
				"widened",
				data.widened ? styles.warning("yes") : styles.hint("no"),
			),
			formatField(
				"search coverage",
				formatCompleteness(data.searchCoverageComplete),
			),
		]),
		joinParts([
			formatField(
				"Probes",
				data.probes.map(({ value }) => styles.accent(value)).join(", ") ||
					styles.hint("none"),
			),
			styles.hint("ranking signals, not required filters"),
		]),
		...(formatFilters(data.filters) ? [formatFilters(data.filters)] : []),
		...data.candidates.map((candidate) =>
			joinParts([
				formatConversation(
					candidate.conversationKind,
					candidate.conversationAlias,
				),
				styles.link(candidate.link),
				candidate.reasons.map((reason) => styles.accent(reason)).join(", "),
				candidate.matches.map(({ excerpt }) => excerpt).join(" | ") ||
					styles.hint("no text probe match; selected by other evidence"),
			]),
		),
	].join("\n");
}

export function formatThread(data: ThreadResult): string {
	const brief = buildThreadBrief(data.thread.posts, {
		subjectTicket:
			data.subject.kind === "ticket" ? data.subject.ticketKey : undefined,
		omittedPosts: data.thread.omittedPosts,
	});
	return [
		joinParts([
			styles.label("Mattermost thread"),
			formatConversation(data.conversation.kind, data.conversation.alias),
			styles.link(data.link),
		]),
		joinParts([
			formatField("Freshness", styles.hint(data.freshnessMode)),
			formatField("complete", formatCompleteness(data.complete, "yes", "no")),
			`observed ${styles.timestamp(isoTimestamp(data.freshness.observedAt))}`,
		]),
		joinParts([
			formatField(
				"Posts",
				styles.accent(`${data.thread.returnedPosts}/${data.thread.totalPosts}`),
			),
			`omitted ${styles.warning(String(data.thread.omittedPosts))}`,
			`attachments ${styles.accent(String(data.thread.returnedAttachments))} returned/${styles.warning(String(data.thread.totalOmittedAttachments))} omitted`,
		]),
		joinParts([
			formatField(
				"Budget",
				`${styles.accent(`${data.thread.budget.used}/${data.thread.budget.limit}`)} ${styles.hint(data.thread.budget.measurement)}`,
			),
			`strategy ${formatSelectionStrategy(data.thread.selectionStrategy)}`,
		]),
		...formatPurposeHints(brief),
		...data.thread.omittedAttachments.map(formatOmittedAttachment),
		...(data.thread.unreportedOmittedAttachments
			? [
					`${styles.warning("Unreported omitted attachments:")} ${styles.warning(String(data.thread.unreportedOmittedAttachments))}`,
				]
			: []),
		...(data.brief ? [] : formatDecisions(brief)),
		...(data.brief ? [] : formatOpenQuestions(brief)),
		...(data.brief
			? formatBriefTimeline(data.thread.timeline, data.thread.posts, brief)
			: formatTimeline(data.thread.timeline)),
	].join("\n");
}

export function formatFile(data: FileDownloadResult): string {
	const downloaded = joinParts([
		styles.success("Downloaded"),
		styles.label(data.name),
		styles.identifier(data.id),
		styles.hint(data.mimeType),
		`${styles.accent(String(data.size))} bytes`,
		styles.link(data.path),
	]);
	if (!data.inspection) return downloaded;
	if (data.inspection.status === "not_interpreted") {
		return [
			downloaded,
			`${styles.warning("Not interpreted:")} ${data.inspection.reason}`,
			styles.hint(data.inspection.recommendedAction),
		].join("\n");
	}
	if (data.inspection.status === "text_extracted") {
		return [
			downloaded,
			joinParts([
				styles.warning("OCR text (low trust)"),
				data.inspection.engine ? styles.hint(data.inspection.engine) : "",
				data.inspection.truncated ? styles.warning("truncated") : "",
			]),
			data.inspection.text,
		].join("\n");
	}
	return [
		downloaded,
		joinParts([
			styles.success("Decoded preview"),
			styles.hint(data.inspection.format),
			data.inspection.truncated ? styles.warning("truncated") : "",
		]),
		data.inspection.preview,
	].join("\n");
}

export function formatFiles(data: FileBatchDownloadResult): string {
	const summary = joinParts([
		styles.success(`Downloaded ${data.downloaded}`),
		styles.hint(`${data.failed} failed`),
		styles.hint(`${data.skipped} skipped`),
		`${styles.accent(String(data.totalBytes))} bytes`,
		styles.link(data.outDir),
	]);
	const lines = data.files.map((item) => {
		if (item.status === "downloaded") {
			return joinParts([
				styles.success("ok"),
				styles.label(item.name),
				styles.identifier(item.id),
				styles.link(item.path),
			]);
		}
		return joinParts(
			[
				styles.warning(item.status),
				item.name ? styles.label(item.name) : undefined,
				item.id ? styles.identifier(item.id) : undefined,
				styles.hint(`${item.error.kind}: ${item.error.message}`),
			].filter((part): part is string => Boolean(part)),
		);
	});
	return [summary, ...lines].join("\n");
}

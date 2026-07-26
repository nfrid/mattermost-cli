import type { SurroundRelevance } from "../../context/types.ts";
import type { ThreadBrief, ThreadSignals } from "../../evidence/signals.ts";
import type { TicketSegment } from "../../evidence/ticket-segments.ts";
import type { EngineeringEntityKind } from "../../search/extract.ts";
import type {
	CommandResult,
	SCHEMA_VERSION,
	Warning,
} from "../../shared/command-result.ts";

/** Fixed head of every agent projection; each command adds its own fields. */
export interface AgentEnvelope {
	command: string;
	schemaVersion: typeof SCHEMA_VERSION;
	success: true;
}

export type {
	CandidateSpan,
	CandidateSpanKind,
	OutcomeWindow,
	PurposeHint,
	PurposeHintLabel,
	RoleHint,
	RoleHintLabel,
	ThreadBrief,
	ThreadSignals,
} from "../../evidence/signals.ts";

export interface AgentFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
	/** Argv segments only — copy; never auto-exec or join into a shell string. */
	downloadCommand: string[];
}

/**
 * One attachment reachable from the thread, including attachments carried by
 * posts inside skip spans (`inPacket: false`) so a decision to download is
 * informed rather than a lottery.
 */
export interface AgentThreadAttachment {
	id: string;
	name: string;
	postId: string;
	mimeType?: string;
	size?: number;
	/** False when the carrying post was omitted from the returned timeline. */
	inPacket: boolean;
	/**
	 * The carrying post has no text — this file is its entire content. Only
	 * computed for packed posts; absent on attachments recovered from skips.
	 */
	mediaOnly?: true;
	/** Argv segments only — copy; never auto-exec or join into a shell string. */
	downloadCommand: string[];
}

/**
 * Mechanical shape of the last returned post. Emitted only for untruncated
 * threads — a truncated packet cannot know how the thread ended.
 */
export interface AgentThreadTail {
	kind: "question" | "error";
	postId: string;
	at: string;
}

/**
 * Decision candidate with its text inlined, so a first read does not have to
 * scan the whole timeline to resolve a post id.
 */
export interface AgentBriefDecision {
	id: string;
	author: string;
	at: string;
	/**
	 * How settled this is: `approved_decision` (approval/agreement phrasing, or a
	 * personal commitment another author affirmed), `discussion_outcome` (someone
	 * reports where a discussion landed — «обсудили…», «итого…» — which is not a
	 * go-ahead), `implementation_intent` (one author says what they will do),
	 * `proposal` (hedged — an option, not a course). Entries are ordered
	 * strongest first, and only `approved_decision` may be reported as something
	 * the team settled.
	 */
	kind:
		| "approved_decision"
		| "discussion_outcome"
		| "implementation_intent"
		| "proposal";
	/** Verbatim excerpt from the packed post; bounded, never a summary. */
	text: string;
	/**
	 * The post carries more text than `text` shows. The cut tail is where a
	 * decision's conditions usually sit, so read post `id` before sizing anything
	 * against this decision — in `posts[]` here, or via `mm thread` in the
	 * projections that carry no transcript (`--navigate`).
	 */
	textTruncated?: true;
	/** Short acknowledgement from a different author, when paired. */
	ackPostId?: string;
	/**
	 * Later posts narrowing what the decision covers. Read them before sizing an
	 * implementation: the decision text alone is routinely wider than the scope
	 * that was settled a few messages later.
	 */
	refinements?: AgentBriefRefinement[];
}

export interface AgentBriefRefinement {
	id: string;
	author: string;
	at: string;
	text: string;
	/** The post carries more text than `text` shows. */
	textTruncated?: true;
}

/**
 * Unresolved-looking question, symmetric to {@link AgentBriefDecision}.
 * `repliesAfter: 0` means nobody spoke after it inside this packet, and
 * `isThreadTail` means the thread stopped there — neither verifies that the
 * question is still open, only that the packet contains no answer.
 */
export interface AgentBriefOpenQuestion {
	id: string;
	author: string;
	at: string;
	/**
	 * `question` is being asked; `follow_up` is deferred work stated as a fact.
	 * Both are unfinished business, but only a `question` is waiting on someone.
	 */
	kind: "question" | "follow_up";
	text: string;
	/** The post carries more text than `text` shows. */
	textTruncated?: true;
	repliesAfter: number;
	isThreadTail?: true;
}

/** Lean brief with agent-facing timestamps and inlined decision text. */
export interface AgentThreadBrief
	extends Omit<ThreadBrief, "decisions" | "openQuestions"> {
	decisions?: AgentBriefDecision[];
	openQuestions?: AgentBriefOpenQuestion[];
}

export interface AgentTechnicalEntity {
	kind: EngineeringEntityKind;
	value: string;
	sourcePostIds: string[];
}

export interface AgentMessage {
	id: string;
	text: string;
	at?: string;
	editedAt?: string;
	deleted?: true;
	/**
	 * The post has no text at all and its whole content is the attachment.
	 * Concluding from the timeline text alone skips this evidence entirely.
	 */
	mediaOnly?: true;
	/** The post this request resolved to (post id or permalink subject). */
	anchor?: true;
	files?: AgentFile[];
}

/** Consecutive posts from one author, collapsed to reduce envelope noise. */
export interface AgentMessageGroup {
	author: string;
	messages: AgentMessage[];
}

/** Omitted chronological span between returned posts. */
export interface AgentSkip {
	skip: {
		posts: number;
		after?: string;
		before?: string;
		reason?: string;
		/** Live attachments carried by the omitted posts; absent when none. */
		files?: number;
	};
}

export type AgentTimelineItem = AgentMessageGroup | AgentSkip;

export interface AgentStatus {
	freshness: "local" | "network";
}

/**
 * What a post-id / permalink subject resolved to. `threadId` is the thread the
 * post belongs to, which is normally *not* the requested id — without this the
 * answer looks like a different thread was substituted.
 */
export interface AgentResolvedSubject {
	postId: string;
	from: "permalink" | "id";
	threadId: string;
	/** False when packing dropped the requested post from the returned timeline. */
	inPacket: boolean;
}

export interface AgentOmission {
	posts: number;
	attachments: number;
	files?: string[];
	/** Omitted attachments that did not fit the reporting budget. */
	unreportedAttachments?: number;
}

export interface AgentRelatedTicket {
	key: string;
	mentions: number;
	threadId?: string;
	url?: string;
	conversation?: string;
	latestAt?: string;
	excerpt?: string;
	sourceThreadId?: string;
	/** True when the related target is already visible in the selected packet. */
	alreadyInPacket?: true;
}

export type AgentAnchorKind =
	| "root"
	| "ticket_mention"
	| "match_hit"
	| "file"
	| "multi_ticket"
	| "codeish"
	| "latest";

/**
 * One navigable post. A post that is several things at once (root that mentions
 * the subject ticket and carries code, say) is one entry with several `kinds`,
 * not one entry per kind repeating the same excerpt.
 */
export interface AgentAnchor {
	kinds: AgentAnchorKind[];
	postId: string;
	at: string;
	text?: string;
	matched?: string[];
	files?: AgentFile[];
}

export interface AgentCluster {
	startPostId: string;
	endPostId: string;
	posts: number;
	reason: TicketSegment["reason"];
	recommendHydrate?: boolean;
}

export interface AgentThread {
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	omitted: AgentOmission;
	/**
	 * Packed messages in this thread. `posts[]` entries are author blocks, not
	 * messages, so `posts.length` is always smaller — compare truncation against
	 * this number.
	 */
	messageCount: number;
	/**
	 * 1-based retrieval rank. Threads keep ranking order, so `rank: 1` is not
	 * necessarily `role: "primary"` — `role` is picked for substance.
	 */
	rank?: number;
	/** True when omit/skip is large enough that `mm thread --full` is warranted. */
	recommendFull?: boolean;
	largestSkip?: number;
	omittedRatio?: number;
	role?: "primary" | "secondary";
	/**
	 * Narrow consumption hint. `announce` marks secondary multi-ticket bulletin
	 * roots (`multi_ticket_root`); never replaces `role`.
	 */
	presentation?: "announce";
	span?: { firstAt: string; lastAt: string; totalPosts: number };
	anchors?: AgentAnchor[];
	clusters?: AgentCluster[];
	relatedTicketsInThread?: string[];
	ticketDensity?: number;
	nearestTicketDistance?: number | null;
	/**
	 * Dense timeline. Each entry is either an author block
	 * (`{ author, messages[] }`) or a skip marker (`{ skip: {...} }`) — never a
	 * single message. Omitted for `--navigate` (use anchors / clusters / skips
	 * instead).
	 */
	posts?: AgentTimelineItem[];
	/** Skip markers extracted for lean `--navigate` projection. */
	skips?: AgentSkip["skip"][];
	/** Engineering entities from packed posts only (capped). */
	technicalEntities?: AgentTechnicalEntity[];
	/**
	 * Advisory candidate spans / roleHints / mechanical outcome window from
	 * packed posts only. Never authoritative decisions or ranking input.
	 */
	signals?: ThreadSignals;
	/**
	 * Lean default-agent briefing from packed posts. Present for both default
	 * `--agent` and `--signals` (alongside full signals when requested).
	 * Omitted when empty.
	 */
	brief?: AgentThreadBrief;
	/** True when any packed post carries attachments (even with empty text). */
	filesPresent?: true;
	/**
	 * Flat attachment index covering returned and omitted posts, so attachments
	 * hidden inside skip spans are visible without hydrating the thread.
	 */
	attachments?: AgentThreadAttachment[];
	/** True when the attachment index hit its cap and lists only a prefix. */
	attachmentsTruncated?: true;
	/** Last returned post timestamp; present in every mode. */
	latestAt?: string;
	/** Mechanical tail shape; only for untruncated threads. */
	tail?: AgentThreadTail;
	/** Prior DM root posts for short threads (not replies of this thread). */
	surround?: AgentMessageGroup[];
	/** Skip guidance for attached surround; only when surround is present. */
	surroundRelevance?: SurroundRelevance;
}

/**
 * Thematically close thread outside ticket routing — typically the discussion
 * that predates the ticket. A pointer only: nothing is hydrated, and the packet
 * is unchanged whether or not this list is acted on.
 */
export interface AgentBackgroundThread {
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	latestAt: string;
	/** Probe values that matched, so the pointer is attributable. */
	matchedProbes: string[];
	excerpts: string[];
	/** Argv segments only — copy; never auto-exec or join into a shell string. */
	command: string[];
}

export interface AgentCandidate {
	/** 1-based position in the ranking; the order is the ranking. */
	rank: number;
	threadId: string;
	conversation: string;
	kind: "channel" | "direct_message";
	url: string;
	latestAt: string;
	/** Why this thread ranked: content matches first, then ordering artifacts. */
	reasons: string[];
	excerpts: string[];
	/** Excerpts beyond `--excerpts`; the full set stays in `--json`. */
	omittedExcerpts?: number;
}

export type AgentCommandResult =
	| {
			command: string;
			schemaVersion: typeof SCHEMA_VERSION;
			success: true;
			warnings: Warning[];
			[key: string]: unknown;
	  }
	| Extract<CommandResult<never>, { success: false }>;

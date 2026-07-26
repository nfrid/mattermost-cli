import type { MattermostConfig } from "../config/config.ts";
import { buildEvidence, type EvidenceNextStep } from "../evidence/evidence.ts";
import { type EvidencePost, packThread } from "../evidence/packing.ts";
import type { Warning } from "../shared/command-result.ts";
import { MattermostStore } from "../store/index.ts";
import {
	downloadMattermostFile,
	type FileDownloadResult,
} from "../sync/file-download.ts";
import { resolveContextConversations } from "./freshen.ts";
import { postLink } from "./helpers.ts";
import { hydrateThread, resolveDirectTarget } from "./hydrate.ts";
import type {
	ContextClient,
	ContextDependencies,
	ContextResult,
	ContextThread,
} from "./types.ts";

/** Client capable of both thread hydrate and file download for follow-ups. */
type FollowClient = ContextClient & {
	downloadFile(fileId: string): Promise<Uint8Array>;
	getFileInfo(fileId: string): Promise<{
		id: string;
		post_id: string;
		name: string;
		extension: string;
		size: number;
		mime_type: string;
		delete_at: number;
	}>;
};

export type FollowLogStatus =
	| "ok"
	| "error"
	| "skipped_external_reader"
	| "skipped_disallowed"
	| "skipped_no_command";

export interface FollowLogEntry {
	/** Argv segments copied from `evidence.next` (never a shell string). */
	command: string[];
	action: EvidenceNextStep["action"];
	status: FollowLogStatus;
	/** Present when status is `error`. */
	error?: string;
	/** File inspect summary when a read_attachments step ran. */
	inspectionStatus?: string;
}

export interface FollowRecommendedResult {
	context: ContextResult;
	followLog: FollowLogEntry[];
}

const DISALLOWED_ACTIONS = new Set<EvidenceNextStep["action"]>([
	"sync",
	"fresh_or_remote",
	"review_candidates",
]);

/**
 * Execute `priority: "recommended"` next steps once and merge their evidence
 * back into the context packet. Read-only, allowlist-bound, no broad sync, and
 * no persistent session. External-reader / OCR steps are logged and skipped so
 * later recommended steps (gap recovery, etc.) still run. Always sets
 * `followLog` (possibly empty) so agents can see the flag took effect.
 */
export async function followRecommendedSteps(input: {
	context: ContextResult;
	config: MattermostConfig;
	client?: FollowClient;
	local?: boolean;
	dependencies?: ContextDependencies;
	/** Test/injection hook; defaults to {@link downloadMattermostFile}. */
	downloadAttachment?: typeof downloadMattermostFile;
}): Promise<FollowRecommendedResult> {
	const followLog: FollowLogEntry[] = [];
	let context = input.context;
	const recommended = (context.evidence.next ?? []).filter(
		(step) => step.priority === "recommended",
	);
	if (!recommended.length) {
		context = {
			...context,
			followLog,
			followExhausted: true,
			evidence: rebuildEvidence(context),
		};
		return { context, followLog };
	}

	const store =
		input.dependencies?.store ??
		(await MattermostStore.open(input.config.databasePath, {
			concepts: input.config.concepts,
		}));
	const ownsStore = !input.dependencies?.store;
	try {
		for (const step of recommended) {
			if (DISALLOWED_ACTIONS.has(step.action)) {
				followLog.push({
					command: step.command ?? [],
					action: step.action,
					status: "skipped_disallowed",
				});
				continue;
			}
			if (!step.command?.length) {
				followLog.push({
					command: [],
					action: step.action,
					status: "skipped_no_command",
				});
				continue;
			}

			try {
				if (
					step.action === "thread_around" ||
					step.action === "thread_full" ||
					step.action === "inspect_dropped"
				) {
					const merged = await followThreadStep({
						step,
						context,
						config: input.config,
						store,
						client: input.local ? undefined : input.client,
					});
					context = merged;
					followLog.push({
						command: step.command,
						action: step.action,
						status: "ok",
					});
					continue;
				}
				if (step.action === "read_attachments") {
					const fileId = step.command[2];
					if (!fileId) {
						followLog.push({
							command: step.command,
							action: step.action,
							status: "skipped_no_command",
						});
						continue;
					}
					const downloaded = await (
						input.downloadAttachment ?? downloadMattermostFile
					)(
						{
							fileId,
							inspect: step.command.includes("--inspect"),
							local: input.local,
							agent: true,
						},
						{
							config: input.config,
							store,
							client: input.local ? undefined : input.client,
						},
					);
					if (requiresExternalAfterInspect(downloaded)) {
						followLog.push({
							command: step.command,
							action: step.action,
							status: "skipped_external_reader",
							inspectionStatus: downloaded.inspection?.status,
						});
						context = attachFollowArtifact(context, downloaded);
						continue;
					}
					context = attachFollowArtifact(context, downloaded);
					followLog.push({
						command: step.command,
						action: step.action,
						status: "ok",
						inspectionStatus: downloaded.inspection?.status,
					});
					continue;
				}
				followLog.push({
					command: step.command,
					action: step.action,
					status: "skipped_disallowed",
				});
			} catch (error) {
				followLog.push({
					command: step.command,
					action: step.action,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const networkFollowOk = followLog.some(
			(entry) =>
				entry.status === "ok" &&
				(entry.action === "thread_around" ||
					entry.action === "thread_full" ||
					entry.action === "inspect_dropped"),
		);
		const evidence = rebuildEvidence(context, { networkFollowOk });
		context = {
			...context,
			evidence,
			followLog,
			...(!evidence.next.some(({ priority }) => priority === "recommended")
				? { followExhausted: true as const }
				: {}),
			warnings: [...context.warnings, ...followWarnings(followLog)],
		};
		return { context, followLog };
	} finally {
		if (ownsStore) store.close();
	}
}

function requiresExternalAfterInspect(result: FileDownloadResult): boolean {
	return result.inspection?.status === "not_interpreted";
}

function attachFollowArtifact(
	context: ContextResult,
	file: FileDownloadResult,
): ContextResult {
	const artifacts = [...(context.followedAttachments ?? []), file];
	return { ...context, followedAttachments: artifacts };
}

async function followThreadStep(input: {
	step: EvidenceNextStep;
	context: ContextResult;
	config: MattermostConfig;
	store: MattermostStore;
	client?: FollowClient;
}): Promise<ContextResult> {
	const parsed = parseThreadArgv(input.step.command ?? []);
	if (!parsed) {
		throw new Error("Recommended thread command is missing a target.");
	}
	const all = resolveContextConversations(input.config, input.store);
	const allowlist = new Set(all.map(({ id }) => id));
	const warnings: Warning[] = [];
	const target = await resolveDirectTarget(
		parsed.target,
		input.store,
		input.client,
		allowlist,
		{ preferLocal: Boolean(!input.client), warnings },
	);
	const conversation = all.find(({ id }) => id === target.conversationId);
	if (!conversation) {
		throw new Error("Follow-up thread is outside configured conversations.");
	}
	const rootPostId = target.rootId || target.id;
	const hydrated = await hydrateThread(
		rootPostId,
		conversation,
		input.store,
		input.client,
		undefined,
		{
			forceRemote: Boolean(input.client),
			freshnessSeconds: input.config.freshnessSeconds,
			now: Date.now(),
			warnings,
		},
	);
	const existing = input.context.threads.find(
		(thread) => thread.threadId === rootPostId,
	);
	const keepIds = new Set(existing?.posts.map(({ id }) => id) ?? []);
	if (parsed.around) keepIds.add(parsed.around);
	if (parsed.full) {
		for (const post of hydrated.posts) keepIds.add(post.id);
	} else if (parsed.around) {
		addAroundIds(keepIds, hydrated.posts, parsed);
	} else {
		// inspect_dropped / bare thread: keep structural pack of the whole thread.
		for (const post of hydrated.posts) keepIds.add(post.id);
	}

	const packed = packThread(rootPostId, hydrated.posts, {
		matchingPostIds: [...keepIds],
		aroundPostId: parsed.around,
		beforePosts: parsed.beforePosts,
		afterPosts: parsed.afterPosts,
		neighborhoodRadius: input.config.budgets.matchNeighborhoodRadius,
		clusterMergeGap: input.config.budgets.clusterMergeGap,
		limit: Math.max(
			existing?.budget.limit ?? 0,
			input.config.budgets.defaultPerThreadCharacters,
			estimateKeepBudget(hydrated.posts, keepIds),
		),
		full: parsed.full,
		// Merge into the packet: never return a bare window delta as the thread.
		windowOnly: false,
		subjectTicketKey:
			input.context.subject.kind === "ticket"
				? input.context.subject.ticketKey
				: undefined,
	});

	const nextThread: ContextThread = {
		...(existing ?? {
			conversationId: conversation.id,
			conversationAlias: conversation.alias,
			conversationKind: conversation.kind,
			reasons: ["direct_post"] as ContextThread["reasons"],
			matchingPostIds: [...keepIds],
			latestActivityAt: Math.max(
				0,
				...hydrated.posts.map(({ createAt }) => createAt),
			),
			link: postLink(input.config, rootPostId),
		}),
		...packed,
		conversationId: conversation.id,
		conversationAlias: conversation.alias,
		conversationKind: conversation.kind,
		reasons: existing?.reasons ?? (["direct_post"] as ContextThread["reasons"]),
		matchingPostIds: existing
			? [...new Set([...existing.matchingPostIds, ...keepIds])]
			: [...keepIds],
		latestActivityAt:
			existing?.latestActivityAt ??
			Math.max(0, ...hydrated.posts.map(({ createAt }) => createAt)),
		link: existing?.link ?? postLink(input.config, rootPostId),
	};

	const threads = existing
		? input.context.threads.map((thread) =>
				thread.threadId === rootPostId ? nextThread : thread,
			)
		: [...input.context.threads, nextThread];

	return {
		...input.context,
		threads,
		selectedThreadsComplete: threads.every(
			(thread) =>
				thread.omittedPosts === 0 && thread.totalOmittedAttachments === 0,
		),
		warnings: [...input.context.warnings, ...warnings],
		budget: {
			...input.context.budget,
			used: threads.reduce((sum, thread) => sum + thread.budget.used, 0),
		},
	};
}

function addAroundIds(
	keepIds: Set<string>,
	posts: readonly EvidencePost[],
	parsed: ParsedThreadArgv,
): void {
	const chronological = [...posts].sort(
		(left, right) =>
			left.createAt - right.createAt || left.id.localeCompare(right.id),
	);
	const aroundIndex = chronological.findIndex(({ id }) => id === parsed.around);
	if (aroundIndex < 0) return;
	const before = parsed.beforePosts ?? 0;
	const after = parsed.afterPosts ?? 0;
	for (const post of chronological.slice(
		Math.max(0, aroundIndex - before),
		aroundIndex + 1 + after,
	)) {
		keepIds.add(post.id);
	}
}

function estimateKeepBudget(
	posts: readonly EvidencePost[],
	keepIds: ReadonlySet<string>,
): number {
	let units = 0;
	for (const post of posts) {
		if (!keepIds.has(post.id)) continue;
		units += Math.max(32, post.message.length + 24);
	}
	return Math.max(units, 1);
}

interface ParsedThreadArgv {
	target: string;
	around?: string;
	beforePosts?: number;
	afterPosts?: number;
	full?: boolean;
}

function parseThreadArgv(
	command: readonly string[],
): ParsedThreadArgv | undefined {
	// ["mm", "thread", "<target>", ...]
	if (command[0] !== "mm" || command[1] !== "thread" || !command[2]) {
		return undefined;
	}
	const target = command[2];
	let around: string | undefined;
	let beforePosts: number | undefined;
	let afterPosts: number | undefined;
	let full = false;
	for (let index = 3; index < command.length; index += 1) {
		const flag = command[index];
		const value = command[index + 1];
		if (flag === "--full") {
			full = true;
			continue;
		}
		if (flag === "--around" && value) {
			around = value;
			index += 1;
			continue;
		}
		if (flag === "--before-posts" && value) {
			beforePosts = Number(value);
			index += 1;
			continue;
		}
		if (flag === "--after-posts" && value) {
			afterPosts = Number(value);
			index += 1;
		}
	}
	return { target, around, beforePosts, afterPosts, full };
}

function rebuildEvidence(
	context: ContextResult,
	options: { networkFollowOk?: boolean } = {},
) {
	const resolvedAttachmentFileIds = (context.followedAttachments ?? [])
		.filter((file) => {
			const status = file.inspection?.status;
			return status === "preview" || status === "text_extracted";
		})
		.map(({ id }) => id);
	return buildEvidence({
		searchCoverageComplete: context.searchCoverageComplete,
		selectedThreadsComplete: context.selectedThreadsComplete,
		freshnessMode: context.freshnessMode,
		freshness: context.freshness,
		searchedConversations: context.searchedConversations,
		threads: context.threads,
		remoteSearch: context.remoteSearch,
		selection: context.selection,
		warnings: context.warnings,
		subject:
			context.subject.kind === "ticket"
				? context.subject.ticketKey
				: context.subject.kind === "post"
					? context.subject.postId
					: context.subject.text,
		...(context.subject.kind === "ticket"
			? { subjectTicket: context.subject.ticketKey }
			: {}),
		resolvedAttachmentFileIds,
		// A successful network gap recovery means selected threads were just
		// re-hydrated; do not keep a pre-follow soft-stale flag as the headline.
		...(options.networkFollowOk ? { selectedEvidenceCurrent: true } : {}),
	});
}

function followWarnings(followLog: readonly FollowLogEntry[]): Warning[] {
	const warnings: Warning[] = [];
	if (followLog.some(({ status }) => status === "skipped_external_reader")) {
		warnings.push({
			kind: "follow_skipped_external_reader",
			severity: "informational",
			message:
				"--follow-recommended skipped a step that requires an external reader or OCR and continued with remaining recommended steps; downloaded artifacts remain for an external tool.",
		});
	}
	if (followLog.some(({ status }) => status === "error")) {
		warnings.push({
			kind: "follow_step_failed",
			severity: "material",
			message:
				"One or more --follow-recommended steps failed; see followLog[] for argv and errors.",
		});
	}
	return warnings;
}

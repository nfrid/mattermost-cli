import type { RoutedConversation, ThreadCandidate } from "../search/index.ts";
import { classifySubject, directCandidate } from "../search/index.ts";
import type { Warning } from "../shared/command-result.ts";
import { AppError, conversationNotAllowedDetails } from "../shared/errors.ts";
import type { MattermostStore } from "../store/index.ts";
import { resolveDirectTarget } from "./hydrate.ts";
import type { ContextClient, PermalinkResolution } from "./types.ts";

/**
 * Resolve extra `--permalink` targets into forced candidates.
 *
 * A ticket description routinely links two or three posts, and reading them
 * used to cost one process each plus manual reconciliation against the ticket
 * packet. Failures are reported per link rather than thrown: one link outside
 * the allowlist must not cost the caller the other three and the whole packet.
 */
export async function resolvePermalinkTargets(input: {
	permalinks: readonly string[];
	store: MattermostStore;
	client?: ContextClient;
	/** This request's allowlist, already narrowed by `--channel`. */
	conversations: readonly RoutedConversation[];
	/** Every configured conversation, so a restriction is distinguishable. */
	configured: readonly RoutedConversation[];
	/** Aliases the caller restricted to, when `--channel` was passed. */
	restrictedTo?: readonly string[];
	fresh?: boolean;
	warnings: Warning[];
}): Promise<{
	candidates: ThreadCandidate[];
	resolutions: PermalinkResolution[];
}> {
	// Resolved against every configured conversation, then checked against this
	// request's narrower set: otherwise a conversation the caller's own
	// `--channel` excluded is reported as missing from the config, and the
	// remediation points at a config owner instead of at the flag.
	const configuredIds = new Set(input.configured.map(({ id }) => id));
	const candidates: ThreadCandidate[] = [];
	const resolutions: PermalinkResolution[] = [];
	const seenThreadIds = new Set<string>();
	const seenInputs = new Set<string>();

	for (const raw of input.permalinks) {
		const value = raw.trim();
		if (!value) {
			resolutions.push({
				input: raw,
				status: "invalid",
				reason: "empty_permalink",
			});
			continue;
		}
		if (seenInputs.has(value)) {
			resolutions.push({
				input: raw,
				status: "duplicate",
				reason: "duplicate_input",
			});
			continue;
		}
		seenInputs.add(value);

		const subject = classifySubject(value);
		if (subject.kind !== "post") {
			resolutions.push({
				input: raw,
				status: "invalid",
				reason: "not_a_permalink_or_post_id",
			});
			continue;
		}

		let target: Awaited<ReturnType<typeof resolveDirectTarget>>;
		try {
			target = await resolveDirectTarget(
				subject.postId,
				input.store,
				input.client,
				configuredIds,
				{ preferLocal: !input.fresh, warnings: input.warnings },
			);
		} catch (error) {
			const refused =
				error instanceof AppError && error.kind === "conversation_not_allowed";
			resolutions.push({
				input: raw,
				postId: subject.postId,
				status: refused ? "not_allowed" : "unresolved",
				reason:
					error instanceof AppError ? error.kind : "permalink_resolve_failed",
				// Only the allowlist refusal has a reviewed detail shape; any other
				// error's `details` are for its own reporting path, not this one.
				...(refused && error instanceof AppError && error.details
					? { details: error.details }
					: {}),
			});
			continue;
		}

		const conversation = input.conversations.find(
			({ id }) => id === target.conversationId,
		);
		if (!conversation) {
			const configuredConversation = input.configured.find(
				({ id }) => id === target.conversationId,
			);
			// Configured, but outside this request's `--channel` restriction: the
			// allowlist is never widened to serve an explicit link. The id is safe
			// to name here — the caller can already see it in `mm channels`.
			resolutions.push({
				input: raw,
				postId: subject.postId,
				conversationId: target.conversationId,
				status: "not_allowed",
				reason: "conversation_not_allowed",
				details: conversationNotAllowedDetails({
					reason: "channel_restriction",
					postId: subject.postId,
					conversationId: target.conversationId,
					...(configuredConversation
						? { conversationAlias: configuredConversation.alias }
						: {}),
					restrictionSource: "cli",
					restrictedTo: input.restrictedTo ?? [],
				}),
			});
			continue;
		}

		const threadId = target.rootId || target.id;
		resolutions.push({
			input: raw,
			postId: target.id,
			threadId,
			conversationId: conversation.id,
			status: seenThreadIds.has(threadId) ? "duplicate" : "resolved",
		});
		if (seenThreadIds.has(threadId)) continue;
		seenThreadIds.add(threadId);
		candidates.push(directCandidate(target, conversation));
	}

	return { candidates, resolutions };
}

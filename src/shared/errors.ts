export type ErrorSource =
	| "cli"
	| "config"
	| "database"
	| "mattermost"
	| "routing"
	| "sync";

export class AppError extends Error {
	constructor(
		message: string,
		readonly source: ErrorSource,
		readonly kind: string,
		readonly exitCode = 1,
		options?: ErrorOptions,
		readonly details?: Readonly<Record<string, unknown>>,
	) {
		super(message, options);
		this.name = "AppError";
	}
}

export class DatabaseError extends AppError {
	constructor(
		message: string,
		kind = "database_unavailable",
		options?: ErrorOptions,
	) {
		super(message, "database", kind, 1, options, {
			recommendedAction: recommendedActionFor(kind),
		});
		this.name = "DatabaseError";
	}
}

/** True when SQLite (or a wrapped DatabaseError) reports a busy/locked database. */
export function isSqliteBusyError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current; depth += 1) {
		if (current instanceof DatabaseError && current.kind === "database_busy") {
			return true;
		}
		if (
			current &&
			typeof current === "object" &&
			"code" in current &&
			(current as { code: unknown }).code === "SQLITE_BUSY"
		) {
			return true;
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

function recommendedActionFor(kind: string): string {
	if (kind === "database_busy") {
		return "wait for other mm processes to finish and retry";
	}
	return "remove the disposable database and run mm sync";
}

export class ConfigError extends AppError {
	constructor(
		message: string,
		kind = "invalid_config",
		options?: ErrorOptions,
		details?: Readonly<Record<string, unknown>>,
	) {
		super(message, "config", kind, 2, options, details);
		this.name = "ConfigError";
	}
}

/**
 * Why a requested conversation is off-limits, and what would change that.
 *
 * The bare `conversation_not_allowed` was correct but unactionable: a caller
 * holding a permalink could not tell whether the conversation is simply absent
 * from the config or was excluded by their own `--channel`, and had nothing to
 * ask an operator for. The post id is echoed because the caller supplied it or
 * read it off the permalink; content never is. A `conversationId` travels only
 * with `channel_restriction`, where the conversation is configured and the
 * caller can already list it — naming the channel behind a *not configured*
 * refusal would turn refusals into an existence oracle over everything the
 * token can read.
 */
export function conversationNotAllowedDetails(input: {
	reason: "not_configured" | "channel_restriction";
	postId?: string;
	conversationId?: string;
	/** Safe only for an already-configured conversation. */
	conversationAlias?: string;
	/** Display name when the conversation is already configured. */
	conversationName?: string;
	/** Channel vs DM when the conversation is already configured. */
	conversationKind?: "channel" | "direct_message";
	/** The only current narrow-request source; explicit for agent consumers. */
	restrictionSource?: "cli";
	/** Aliases the caller restricted to, when that is what excluded it. */
	restrictedTo?: readonly string[];
}): Readonly<Record<string, unknown>> {
	return {
		reason: input.reason,
		...(input.postId ? { postId: input.postId } : {}),
		...(input.conversationId && input.reason === "channel_restriction"
			? { conversationId: input.conversationId }
			: {}),
		...(input.conversationAlias && input.reason === "channel_restriction"
			? { conversationAlias: input.conversationAlias }
			: {}),
		...(input.conversationName && input.reason === "channel_restriction"
			? { conversationName: input.conversationName }
			: {}),
		...(input.conversationKind && input.reason === "channel_restriction"
			? { conversationKind: input.conversationKind }
			: {}),
		...(input.restrictionSource && input.reason === "channel_restriction"
			? { restrictionSource: input.restrictionSource }
			: {}),
		...(input.restrictedTo?.length
			? { restrictedTo: [...input.restrictedTo] }
			: {}),
		recommendedAction:
			input.reason === "channel_restriction"
				? "drop or widen --channel; the conversation is configured but excluded by this request"
				: "ask a config owner to add this conversation to .mattermost/config.json; mm never widens the allowlist on its own",
	};
}

/** Known aliases listed inline before the message defers to `mm channels`. */
const LISTED_ALIASES = 12;
/** Max edit distance for a "did you mean" suggestion (short aliases: typos). */
const SUGGESTION_MAX_DISTANCE = 3;
/** Below this length an alias is too generic to suggest anything from. */
const MIN_SUGGESTION_LENGTH = 3;

/**
 * The alias exists in configuration but carries no local index yet, so it can
 * be searched only after a sync. Reporting it as unknown sends the caller
 * hunting for a typo that is not there.
 */
export function unindexedConversationError(
	aliases: readonly string[],
): ConfigError {
	const command =
		aliases.length === 1 && aliases[0]
			? `\`mm sync --channel ${aliases[0]}\``
			: "`mm sync`";
	return new ConfigError(
		`Configured but not indexed yet: ${aliases.join(", ")}. Run ${command} first.`,
		"unknown_conversation",
	);
}

/**
 * One `unknown_conversation` error for every caller, so a mistyped `--channel`
 * always answers the only question worth asking next: which aliases exist.
 */
export function unknownConversationError(
	unknown: readonly string[],
	known: readonly KnownConversation[],
	context = "configured conversation alias",
): ConfigError {
	// Channels first: a per-person DM roster is long and rarely the alias a
	// mistyped `--channel` was reaching for.
	const normalized: Array<{
		alias: string;
		kind?: "channel" | "direct_message";
	}> = known.map((entry) =>
		typeof entry === "string" ? { alias: entry } : entry,
	);
	const sorted = [
		...new Map(normalized.map((entry) => [entry.alias, entry])).values(),
	].sort(
		(left, right) =>
			Number(left.kind === "direct_message") -
				Number(right.kind === "direct_message") ||
			left.alias.localeCompare(right.alias),
	);
	const aliases = sorted.map(({ alias }) => alias);
	const suggestions = [
		...new Set(
			unknown.flatMap((alias) => {
				const match = closestAlias(alias, aliases);
				return match ? [match] : [];
			}),
		),
	];
	const listed = aliases.slice(0, LISTED_ALIASES);
	const remaining = aliases.length - listed.length;
	const parts = [`Unknown ${context}: ${unknown.join(", ")}.`];
	if (suggestions.length)
		parts.push(`Did you mean: ${suggestions.join(", ")}?`);
	parts.push(
		listed.length
			? `Known aliases: ${listed.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""} — see \`mm channels\`.`
			: "No conversations are configured — see `mm channels`.",
	);
	return new ConfigError(parts.join(" "), "unknown_conversation");
}

/** An alias, optionally with its kind so channels can be listed first. */
export type KnownConversation =
	| string
	| { alias: string; kind?: "channel" | "direct_message" };

/**
 * Nearest known alias by containment, then bounded edit distance. Containment
 * needs a substantial needle: every alias contains `""` and most contain any
 * single letter, and a fabricated suggestion is worse than none.
 */
function closestAlias(
	alias: string,
	known: readonly string[],
): string | undefined {
	const needle = alias.trim().toLowerCase();
	if (needle.length < MIN_SUGGESTION_LENGTH) return undefined;
	const contained = known.find(
		(candidate) =>
			candidate.toLowerCase().includes(needle) ||
			needle.includes(candidate.toLowerCase()),
	);
	if (contained) return contained;
	let best: { alias: string; distance: number } | undefined;
	for (const candidate of known) {
		const distance = editDistance(needle, candidate.toLowerCase());
		if (
			distance <= SUGGESTION_MAX_DISTANCE &&
			(!best || distance < best.distance)
		) {
			best = { alias: candidate, distance };
		}
	}
	return best?.alias;
}

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		const current = [row];
		for (let column = 1; column <= right.length; column += 1) {
			current[column] = Math.min(
				(previous[column] ?? 0) + 1,
				(current[column - 1] ?? 0) + 1,
				(previous[column - 1] ?? 0) +
					(left[row - 1] === right[column - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[right.length] ?? right.length;
}

/**
 * Mattermost returned structurally inconsistent data (a thread that does not
 * hang together, a post that moved). Not a configuration or routing decision,
 * so it must not be reported as one, and it is recoverable: callers may fall
 * back to local evidence or drop the affected candidate.
 */
export class MattermostDataError extends AppError {
	constructor(message: string, kind: string, options?: ErrorOptions) {
		super(message, "mattermost", kind, 1, options);
		this.name = "MattermostDataError";
	}
}

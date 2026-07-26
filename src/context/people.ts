import type { MattermostConfig } from "../config/config.ts";
import type { MattermostStore } from "../store/index.ts";
import { resolveContextConversations } from "./freshen.ts";
import { withResources } from "./resources.ts";
import type {
	ContextDependencies,
	ContextThread,
	PersonActivity,
	PersonRef,
} from "./types.ts";

export type { PersonActivity, PersonRef } from "./types.ts";

/** Roster for the authors of the packed posts, in first-appearance order. */
export function peopleInThreads(
	config: MattermostConfig,
	store: MattermostStore,
	threads: readonly ContextThread[],
): PersonRef[] {
	const userIds: string[] = [];
	const seen = new Set<string>();
	for (const thread of threads) {
		for (const post of thread.posts) {
			if (seen.has(post.userId)) continue;
			seen.add(post.userId);
			userIds.push(post.userId);
		}
	}
	if (!userIds.length) return [];
	const byId = new Map(
		store.getUsers(userIds).map((user) => [user.id, user] as const),
	);
	const people: PersonRef[] = [];
	for (const userId of userIds) {
		const user = byId.get(userId);
		if (!user) continue;
		people.push(personRef(config, user));
	}
	return people;
}

export interface PeopleResult {
	people: PersonActivity[];
	/** Authors in scope before `--limit`, so a truncated list says so. */
	total: number;
	/** Conversation aliases the listing covered. */
	conversations: string[];
}

/**
 * `mm people`: who appears in the index, with the role Mattermost knows. Runs
 * against the local index only — this answers "whose statement is this", not
 * "who exists in the workspace".
 */
export async function getMattermostPeople(
	input: { channels?: readonly string[]; limit?: number } = {},
	dependencies: ContextDependencies = {},
): Promise<PeopleResult> {
	return withResources(dependencies, async (config, store) => {
		// Always scope to the configured allowlist, including the no-`--channel`
		// case: the index can still hold conversations that were configured once
		// and are not any more, and this listing must not reach them.
		const scoped = resolveContextConversations(config, store, input.channels);
		const all = listPeople(config, store, {
			conversationIds: scoped.map(({ id }) => id),
		});
		return {
			people: applyLimit(all, input.limit),
			total: all.length,
			conversations: scoped.map(({ alias }) => alias),
		};
	});
}

/** Every indexed author, busiest first; the `mm people` listing. */
export function listPeople(
	config: MattermostConfig,
	store: MattermostStore,
	options: { conversationIds?: readonly string[]; limit?: number } = {},
): PersonActivity[] {
	const activity = store.authorActivity(options.conversationIds);
	const byId = new Map(
		store
			.getUsers(activity.map(({ userId }) => userId))
			.map((user) => [user.id, user] as const),
	);
	const people = activity.flatMap((entry) => {
		const user = byId.get(entry.userId);
		if (!user) return [];
		return [
			{
				...personRef(config, user),
				messages: entry.messages,
				latestAt: entry.latestAt,
			},
		];
	});
	return applyLimit(people, options.limit);
}

/** A non-numeric or absent `--limit` must not silently mean "nothing". */
function applyLimit<Item>(items: Item[], limit?: number): Item[] {
	if (limit === undefined || !Number.isFinite(limit)) return items;
	return items.slice(0, Math.max(1, Math.floor(limit)));
}

function personRef(
	config: MattermostConfig,
	user: {
		username: string;
		firstName: string;
		lastName: string;
		nickname: string;
		position: string;
		isBot: boolean;
	},
): PersonRef {
	// Profile first: it is maintained in Mattermost itself, so a local override
	// cannot silently outrank what the person says about themselves.
	const configured = config.people?.[user.username];
	const role = user.position.trim() || configured?.trim();
	const displayName =
		[user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
		user.nickname.trim();
	return {
		username: user.username,
		...(displayName ? { displayName } : {}),
		...(role ? { role } : {}),
		...(role
			? { roleSource: user.position.trim() ? "profile" : ("config" as const) }
			: {}),
		...(user.isBot ? { isBot: true as const } : {}),
	};
}

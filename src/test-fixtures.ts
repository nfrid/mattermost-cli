import type { MattermostConfig } from "./config.ts";
import type { MattermostPost, MattermostUser } from "./mattermost/schemas.ts";
import type { ConversationRecord } from "./storage.ts";

export function configFixture(
	overrides: Partial<MattermostConfig> = {},
): MattermostConfig {
	return {
		schemaVersion: 1,
		url: "https://chat.example.test",
		teamId: "team-id",
		token: "synthetic-token",
		databasePath: ":memory:",
		configPath: "/tmp/config.json",
		projectRoot: "/tmp",
		freshnessSeconds: 300,
		reconciliationOverlapMs: 30_000,
		historyDays: 365,
		pageSize: 100,
		synonyms: {},
		budgets: {
			defaultMaxCharacters: 1_000,
			defaultPerThreadCharacters: 500,
			defaultMaxThreads: 3,
			moreMaxCharacters: 2_000,
			morePerThreadCharacters: 1_000,
			moreMaxThreads: 6,
			matchNeighborhoodRadius: 8,
			conversationSurroundRoots: 5,
			shortThreadMaxReplies: 2,
		},
		suppressAuthors: [],
		channels: {
			payments: {
				id: "channel-payments",
				name: "payments",
				description: "Payments",
				tags: ["billing"],
				repositories: ["payment"],
				scopes: ["payments"],
				priority: 100,
			},
			platform: {
				id: "channel-platform",
				name: "platform",
				description: "Platform",
				tags: ["infra"],
				repositories: ["api"],
				scopes: ["platform"],
				priority: 50,
			},
		},
		directMessages: {
			leads: {
				channelId: "dm-leads",
				description: "Leads",
				participants: ["alice", "bob"],
				tags: [],
				repositories: [],
				scopes: ["leadership"],
				priority: 10,
			},
		},
		...overrides,
	};
}

export function conversationFixture(
	alias = "payments",
	id = "channel-payments",
): ConversationRecord {
	return {
		id,
		alias,
		kind: "channel",
		name: alias,
		description: alias,
	};
}

export function userFixture(
	overrides: Partial<MattermostUser> = {},
): MattermostUser {
	return {
		id: "user-1",
		username: "alice",
		first_name: "Alice",
		last_name: "Example",
		nickname: "",
		delete_at: 0,
		is_bot: false,
		...overrides,
	};
}

export function postFixture(
	overrides: Partial<MattermostPost> = {},
): MattermostPost {
	return {
		id: "postabcdefghijklmnopqrstuv",
		create_at: 1,
		update_at: 1,
		delete_at: 0,
		user_id: "user-1",
		channel_id: "channel-payments",
		root_id: "",
		message: "message",
		type: "",
		props: {},
		file_ids: [],
		...overrides,
	};
}

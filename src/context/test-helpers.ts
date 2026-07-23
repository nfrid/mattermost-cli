import type {
	MattermostChannel,
	MattermostFileInfo,
	MattermostPost,
	MattermostPostList,
	MattermostUser,
} from "../mattermost/schemas.ts";
import { MattermostStore } from "../store/index.ts";
import {
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import type { ContextClient } from "./index.ts";

export const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
export const REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
export const PLATFORM_ROOT = "cccccccccccccccccccccccccc";
export const TAIL = "dddddddddddddddddddddddddd";

export async function seededStore(
	options: { fresh?: boolean } = {},
): Promise<MattermostStore> {
	const store = await MattermostStore.open(":memory:");
	const now = options.fresh ? 100 : 1;
	store.writePage({
		conversation: conversationFixture("payments", "channel-payments"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout shared evidence",
				create_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "payment timeout reply",
				create_at: 20,
			}),
			postFixture({
				id: TAIL,
				root_id: ROOT,
				channel_id: "channel-payments",
				message: "follow-up evidence",
				create_at: 25,
			}),
		],
		checkpoint: {
			conversationId: "channel-payments",
			newestPostId: null,
			newestPostAt: 20,
			oldestCoveredAt: 10,
			lastSuccessAt: now,
			coverageComplete: false,
		},
	});
	store.writePage({
		conversation: conversationFixture("platform", "channel-platform"),
		users: [userFixture()],
		posts: [
			postFixture({
				id: PLATFORM_ROOT,
				channel_id: "channel-platform",
				message: "deployment rollback shared evidence",
				create_at: 30,
			}),
		],
		checkpoint: {
			conversationId: "channel-platform",
			newestPostId: null,
			newestPostAt: 30,
			oldestCoveredAt: 30,
			lastSuccessAt: now,
			coverageComplete: true,
		},
	});
	store.writePage({
		conversation: {
			...conversationFixture("leads", "dm-leads"),
			kind: "direct_message",
		},
		posts: [],
		checkpoint: {
			conversationId: "dm-leads",
			newestPostId: null,
			newestPostAt: null,
			oldestCoveredAt: null,
			lastSuccessAt: now,
			coverageComplete: true,
		},
	});
	return store;
}

export class FakeContextClient implements ContextClient {
	readonly posts = new Map<string, MattermostPost>();
	readonly postRequests: Array<{
		channelId: string;
		since?: number;
		page?: number;
	}> = [];
	readonly channelRequests: string[] = [];
	readonly threadRequests: string[] = [];
	readonly fileInfoRequests: string[] = [];
	readonly threads = new Map<string, MattermostPostList>();
	thread: MattermostPostList = list();

	async getChannelByName(
		_teamId: string,
		name: string,
	): Promise<MattermostChannel> {
		return channel(`channel-${name}`, name);
	}

	async getChannel(channelId: string): Promise<MattermostChannel> {
		this.channelRequests.push(channelId);
		return channel(
			channelId,
			channelId.replace(/^channel-/, ""),
			channelId.startsWith("dm-") ? "D" : "O",
		);
	}

	async getChannelPosts(
		channelId: string,
		options: { since?: number; page?: number } = {},
	): Promise<MattermostPostList> {
		this.postRequests.push({
			channelId,
			since: options.since,
			page: options.page,
		});
		return list();
	}

	async getUsersByIds(userIds: readonly string[]): Promise<MattermostUser[]> {
		return userIds.map((id) => userFixture({ id }));
	}

	async getFileInfo(fileId: string): Promise<MattermostFileInfo> {
		this.fileInfoRequests.push(fileId);
		return {
			id: fileId,
			user_id: "user-1",
			post_id: ROOT,
			create_at: 1,
			update_at: 1,
			delete_at: 0,
			name: fileId,
			extension: "txt",
			size: 1,
			mime_type: "text/plain",
		};
	}

	async getPost(postId: string): Promise<MattermostPost> {
		const post = this.posts.get(postId);
		if (!post) throw new Error(`Missing fake post ${postId}`);
		return post;
	}

	async getThread(postId: string): Promise<MattermostPostList> {
		this.threadRequests.push(postId);
		return this.threads.get(postId) ?? this.thread;
	}
}

export class SearchContextClient extends FakeContextClient {
	readonly searchRequests: Array<{
		teamId: string;
		terms: string;
		isOrSearch?: boolean;
		page?: number;
		perPage?: number;
	}> = [];
	searchResult: MattermostPostList = list();
	readonly searchResults = new Map<string, MattermostPostList>();
	failSearch = false;

	async searchTeamPosts(
		teamId: string,
		options: {
			terms: string;
			isOrSearch?: boolean;
			page?: number;
			perPage?: number;
		},
	): Promise<MattermostPostList> {
		this.searchRequests.push({ teamId, ...options });
		if (this.failSearch) throw new Error("Synthetic remote search failure");
		return this.searchResults.get(options.terms) ?? this.searchResult;
	}
}

export function throwingClient(): ContextClient {
	return new Proxy(
		{},
		{
			get() {
				return () => {
					throw new Error("Local mode made a network call");
				};
			},
		},
	) as ContextClient;
}

export function channel(
	id: string,
	name: string,
	type = "O",
): MattermostChannel {
	return {
		id,
		team_id: type === "D" ? "" : "team-id",
		type,
		name,
		display_name: name,
		header: "",
		purpose: "",
		delete_at: 0,
	};
}

export function list(...posts: MattermostPost[]): MattermostPostList {
	return {
		order: posts.map(({ id }) => id),
		posts: Object.fromEntries(posts.map((post) => [post.id, post])),
	};
}

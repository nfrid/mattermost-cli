import { describe, expect, test } from "bun:test";
import type { MattermostConfig } from "../config.ts";
import { MattermostApiError, MattermostClient } from "./client.ts";

const config = {
	schemaVersion: 1,
	url: "https://chat.example.test",
	teamId: "team-id",
	token: "super-secret-token",
	databasePath: "/tmp/index.sqlite3",
	configPath: "/tmp/config.json",
	projectRoot: "/tmp",
	freshnessSeconds: 300,
	reconciliationOverlapMs: 30_000,
	historyDays: 365,
	pageSize: 100,
	budgets: {
		defaultMaxCharacters: 16_000,
		defaultPerThreadCharacters: 6_000,
		defaultMaxThreads: 3,
		moreMaxCharacters: 32_000,
		morePerThreadCharacters: 10_000,
		moreMaxThreads: 6,
		matchNeighborhoodRadius: 8,
		conversationSurroundRoots: 5,
		shortThreadMaxReplies: 2,
	},
	channels: {},
	directMessages: {},
} satisfies MattermostConfig;

describe("MattermostClient", () => {
	test("uses GET, bearer auth, encoded paths, and supported query parameters", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const client = new MattermostClient(config, {
			fetch: mockFetch((input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				return jsonResponse({ order: [], posts: {} });
			}),
		});

		await client.getChannelPosts("channel/id", {
			page: 2,
			perPage: 50,
			since: 1234,
		});

		expect(capturedUrl).toBe(
			"https://chat.example.test/api/v4/channels/channel%2Fid/posts?page=2&per_page=50&since=1234",
		);
		expect(capturedInit?.method).toBe("GET");
		expect(new Headers(capturedInit?.headers).get("Authorization")).toBe(
			"Bearer super-secret-token",
		);
	});

	test("performs only the named bounded team post search operation", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const client = new MattermostClient(config, {
			fetch: mockFetch((input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				return jsonResponse({ order: [], posts: {}, matches: {} });
			}),
		});
		await client.searchTeamPosts("team/id", {
			terms: "payment timeout",
			isOrSearch: false,
			page: 0,
			perPage: 20,
		});
		expect(capturedUrl).toBe(
			"https://chat.example.test/api/v4/teams/team%2Fid/posts/search",
		);
		expect(capturedInit?.method).toBe("POST");
		expect(new Headers(capturedInit?.headers).get("Content-Type")).toBe(
			"application/json",
		);
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			terms: "payment timeout",
			is_or_search: false,
			page: 0,
			per_page: 20,
		});
	});

	test("rejects unbounded team post search before a request", async () => {
		let called = false;
		const client = new MattermostClient(config, {
			fetch: mockFetch(() => {
				called = true;
				return jsonResponse({});
			}),
		});
		await expect(
			client.searchTeamPosts("team", { terms: "x", perPage: 101 }),
		).rejects.toBeDefined();
		expect(called).toBe(false);
	});

	test("rejects oversized post-search result sets", async () => {
		const order = Array.from({ length: 101 }, (_, index) => `post-${index}`);
		const client = new MattermostClient(config, {
			fetch: mockFetch(() => jsonResponse({ order, posts: {} })),
		});
		await expect(
			client.searchTeamPosts("team", { terms: "payment" }),
		).rejects.toMatchObject({ kind: "invalid_response" });
	});

	test("rejects mutually incompatible channel cursors before a request", async () => {
		let called = false;
		const client = new MattermostClient(config, {
			fetch: mockFetch(() => {
				called = true;
				return jsonResponse({});
			}),
		});

		expect(
			client.getChannelPosts("channel", { since: 1, before: "post" }),
		).rejects.toThrow("since, before, and after cannot be combined");
		expect(called).toBe(false);
	});

	test("redacts tokens and bounds API response bodies", async () => {
		const client = new MattermostClient(config, {
			fetch: mockFetch(() =>
				Promise.resolve(
					new Response(`super-secret-token:${"x".repeat(10_000)}`, {
						status: 401,
						statusText: "Unauthorized",
					}),
				),
			),
		});

		try {
			await client.getCurrentUser();
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(MattermostApiError);
			const apiError = error as MattermostApiError;
			expect(apiError.responseBody).not.toContain("super-secret-token");
			expect(apiError.responseBody).toContain("[REDACTED]");
			expect(apiError.responseBody.length).toBeLessThanOrEqual(4_096);
		}
	});

	test("redacts a token that crosses the displayed error boundary", async () => {
		const client = new MattermostClient(config, {
			fetch: mockFetch(() =>
				Promise.resolve(
					new Response(`${"x".repeat(4_090)}super-secret-token:suffix`, {
						status: 500,
					}),
				),
			),
		});
		try {
			await client.getCurrentUser();
			expect.unreachable();
		} catch (error) {
			const apiError = error as MattermostApiError;
			expect(apiError.responseBody).not.toContain("super-secret-token");
			expect(apiError.responseBody.length).toBeLessThanOrEqual(4_096);
		}
	});

	test("rejects success bodies above the bounded response size", async () => {
		const client = new MattermostClient(config, {
			fetch: mockFetch(() =>
				Promise.resolve(
					new Response("{}", {
						headers: { "content-length": String(17 * 1_024 * 1_024) },
					}),
				),
			),
		});
		await expect(client.getCurrentUser()).rejects.toMatchObject({
			kind: "response_too_large",
		});
	});

	test("validates response fields while tolerating unrelated fields", async () => {
		const client = new MattermostClient(config, {
			fetch: mockFetch(() =>
				jsonResponse({
					id: "user-id",
					username: "alice",
					first_name: "Alice",
					last_name: "Example",
					nickname: "",
					delete_at: 0,
					unrelated: true,
				}),
			),
		});

		await expect(client.getCurrentUser()).resolves.toMatchObject({
			id: "user-id",
			username: "alice",
		});
	});

	test("does not expose a generic request helper", () => {
		const methods = Object.getOwnPropertyNames(MattermostClient.prototype);
		expect(methods).not.toContain("request");
		expect(methods).not.toContain("getRaw");
	});
});

function mockFetch(
	implementation: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Response | Promise<Response>,
): typeof fetch {
	return implementation as typeof fetch;
}

function jsonResponse(value: unknown): Promise<Response> {
	return Promise.resolve(Response.json(value));
}

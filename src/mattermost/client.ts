import { z } from "zod";
import { mapWithConcurrency } from "../concurrency.ts";
import type { MattermostConfig } from "../config.ts";
import { requireMattermostToken } from "../config.ts";
import { AppError } from "../errors.ts";
import {
	type MattermostChannel,
	type MattermostFileInfo,
	type MattermostPost,
	type MattermostPostList,
	type MattermostTeam,
	type MattermostUser,
	mattermostChannelSchema,
	mattermostFileInfoSchema,
	mattermostPostListSchema,
	mattermostPostSchema,
	mattermostPostSearchResultSchema,
	mattermostTeamSchema,
	mattermostUserSchema,
} from "./schemas.ts";

const MAX_ERROR_BODY_CHARACTERS = 4_096;
const MAX_RESPONSE_BODY_BYTES = 16 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 30_000;

const channelPostOptionsSchema = z
	.object({
		page: z.number().int().nonnegative().optional(),
		perPage: z.number().int().min(1).max(200).optional(),
		since: z.number().int().nonnegative().optional(),
		before: z.string().trim().min(1).optional(),
		after: z.string().trim().min(1).optional(),
	})
	.refine(
		(options) =>
			[options.since, options.before, options.after].filter(
				(value) => value !== undefined,
			).length <= 1,
		{ message: "since, before, and after cannot be combined" },
	);

const teamPostSearchOptionsSchema = z.object({
	terms: z.string().trim().min(2).max(256),
	isOrSearch: z.boolean().default(false),
	page: z.number().int().min(0).max(10).default(0),
	perPage: z.number().int().min(1).max(100).default(20),
});

export type ChannelPostOptions = z.input<typeof channelPostOptionsSchema>;
export type TeamPostSearchOptions = z.input<typeof teamPostSearchOptionsSchema>;

export class MattermostApiError extends AppError {
	constructor(
		message: string,
		readonly status: number,
		readonly responseBody: string,
		kind = "api_error",
		options?: ErrorOptions,
	) {
		super(message, "mattermost", kind, 1, options);
		this.name = "MattermostApiError";
	}
}

export interface MattermostClientOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export class MattermostClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImplementation: typeof fetch;
	private readonly timeoutMs: number;

	constructor(config: MattermostConfig, options: MattermostClientOptions = {}) {
		this.baseUrl = `${config.url}/api/v4`;
		this.token = requireMattermostToken(config);
		this.fetchImplementation = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async getCurrentUser(): Promise<MattermostUser> {
		return this.getJson("/users/me", mattermostUserSchema);
	}

	async getUser(userId: string): Promise<MattermostUser> {
		return this.getJson(
			`/users/${encodeURIComponent(userId)}`,
			mattermostUserSchema,
		);
	}

	async getUsersByIds(userIds: readonly string[]): Promise<MattermostUser[]> {
		return mapWithConcurrency(userIds, (userId) => this.getUser(userId));
	}

	async getTeam(teamId: string): Promise<MattermostTeam> {
		return this.getJson(
			`/teams/${encodeURIComponent(teamId)}`,
			mattermostTeamSchema,
		);
	}

	async getChannel(channelId: string): Promise<MattermostChannel> {
		return this.getJson(
			`/channels/${encodeURIComponent(channelId)}`,
			mattermostChannelSchema,
		);
	}

	async getChannelByName(
		teamId: string,
		channelName: string,
	): Promise<MattermostChannel> {
		return this.getJson(
			`/teams/${encodeURIComponent(teamId)}/channels/name/${encodeURIComponent(channelName)}`,
			mattermostChannelSchema,
		);
	}

	async getChannelPosts(
		channelId: string,
		options: ChannelPostOptions = {},
	): Promise<MattermostPostList> {
		const parsed = channelPostOptionsSchema.parse(options);
		const query: Record<string, string> = {};

		if (parsed.page !== undefined) query.page = String(parsed.page);
		if (parsed.perPage !== undefined) query.per_page = String(parsed.perPage);
		if (parsed.since !== undefined) query.since = String(parsed.since);
		if (parsed.before !== undefined) query.before = parsed.before;
		if (parsed.after !== undefined) query.after = parsed.after;

		return this.getJson(
			`/channels/${encodeURIComponent(channelId)}/posts`,
			mattermostPostListSchema,
			query,
		);
	}

	async searchTeamPosts(
		teamId: string,
		options: TeamPostSearchOptions,
	): Promise<MattermostPostList> {
		const parsed = teamPostSearchOptionsSchema.parse(options);
		return this.postJson(
			`/teams/${encodeURIComponent(teamId)}/posts/search`,
			mattermostPostSearchResultSchema,
			{
				terms: parsed.terms,
				is_or_search: parsed.isOrSearch,
				page: parsed.page,
				per_page: parsed.perPage,
			},
		);
	}

	async getPost(postId: string): Promise<MattermostPost> {
		return this.getJson(
			`/posts/${encodeURIComponent(postId)}`,
			mattermostPostSchema,
		);
	}

	async getThread(postId: string): Promise<MattermostPostList> {
		return this.getJson(
			`/posts/${encodeURIComponent(postId)}/thread`,
			mattermostPostListSchema,
		);
	}

	async getFileInfo(fileId: string): Promise<MattermostFileInfo> {
		return this.getJson(
			`/files/${encodeURIComponent(fileId)}/info`,
			mattermostFileInfoSchema,
		);
	}

	async downloadFile(fileId: string): Promise<Uint8Array> {
		return this.#requestBinary(`/files/${encodeURIComponent(fileId)}`);
	}

	private getJson<T>(
		path: string,
		schema: z.ZodType<T>,
		searchParams: Record<string, string> = {},
	): Promise<T> {
		return this.#requestJson("GET", path, schema, searchParams);
	}

	private postJson<T>(
		path: string,
		schema: z.ZodType<T>,
		body: unknown,
	): Promise<T> {
		return this.#requestJson("POST", path, schema, {}, body);
	}

	async #requestBinary(path: string): Promise<Uint8Array> {
		const url = new URL(`${this.baseUrl}${path}`);
		let response: Response;
		try {
			response = await this.fetchImplementation(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
				},
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new MattermostApiError(
				"Mattermost file download failed before receiving a response.",
				0,
				"",
				"request_failed",
				{ cause: error },
			);
		}

		if (!response.ok) {
			const tokenBytes = new TextEncoder().encode(this.token).length;
			const { text } = await readResponseText(
				response,
				MAX_ERROR_BODY_CHARACTERS + tokenBytes,
				true,
			);
			const responseBody = [...redactToken(text, this.token)]
				.slice(0, MAX_ERROR_BODY_CHARACTERS)
				.join("");
			throw new MattermostApiError(
				`Mattermost file download failed with ${response.status} ${response.statusText}.`,
				response.status,
				responseBody,
			);
		}

		const declaredLength = Number(response.headers.get("content-length"));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > MAX_RESPONSE_BODY_BYTES
		) {
			throw new MattermostApiError(
				"Mattermost file exceeded the configured safety bound.",
				response.status,
				"",
				"response_too_large",
			);
		}

		const { bytes, truncated } = await readResponseBytes(
			response,
			MAX_RESPONSE_BODY_BYTES,
		);
		if (truncated) {
			throw new MattermostApiError(
				"Mattermost file exceeded the configured safety bound.",
				response.status,
				"",
				"response_too_large",
			);
		}
		return bytes;
	}

	async #requestJson<T>(
		method: "GET" | "POST",
		path: string,
		schema: z.ZodType<T>,
		searchParams: Record<string, string> = {},
		body?: unknown,
	): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);

		for (const [name, value] of Object.entries(searchParams)) {
			url.searchParams.set(name, value);
		}

		let response: Response;

		try {
			response = await this.fetchImplementation(url, {
				method,
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${this.token}`,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			throw new MattermostApiError(
				"Mattermost API request failed before receiving a response.",
				0,
				"",
				"request_failed",
				{ cause: error },
			);
		}

		if (!response.ok) {
			const tokenBytes = new TextEncoder().encode(this.token).length;
			const { text } = await readResponseText(
				response,
				MAX_ERROR_BODY_CHARACTERS + tokenBytes,
				true,
			);
			const responseBody = [...redactToken(text, this.token)]
				.slice(0, MAX_ERROR_BODY_CHARACTERS)
				.join("");
			throw new MattermostApiError(
				`Mattermost API request failed with ${response.status} ${response.statusText}.`,
				response.status,
				responseBody,
			);
		}

		try {
			const declaredLength = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declaredLength) &&
				declaredLength > MAX_RESPONSE_BODY_BYTES
			) {
				throw new MattermostApiError(
					"Mattermost API response exceeded the configured safety bound.",
					response.status,
					"",
					"response_too_large",
				);
			}
			const { text, truncated } = await readResponseText(
				response,
				MAX_RESPONSE_BODY_BYTES,
				false,
			);
			if (truncated) {
				throw new MattermostApiError(
					"Mattermost API response exceeded the configured safety bound.",
					response.status,
					"",
					"response_too_large",
				);
			}
			return schema.parse(JSON.parse(text));
		} catch (error) {
			if (error instanceof MattermostApiError) throw error;
			throw new MattermostApiError(
				"Mattermost API returned an invalid response.",
				response.status,
				"",
				"invalid_response",
				{ cause: error },
			);
		}
	}
}

async function readResponseBytes(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const remaining = maxBytes - total;
		if (value.byteLength > remaining) {
			if (remaining > 0) chunks.push(value.slice(0, remaining));
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const bytes = new Uint8Array(
		chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

async function readResponseText(
	response: Response,
	maxBytes: number,
	allowTruncate: boolean,
): Promise<{ text: string; truncated: boolean }> {
	const { bytes, truncated } = await readResponseBytes(response, maxBytes);
	if (truncated && !allowTruncate) {
		return { text: "", truncated: true };
	}
	return { text: new TextDecoder().decode(bytes), truncated };
}

function redactToken(value: string, token: string): string {
	return token ? value.replaceAll(token, "[REDACTED]") : value;
}

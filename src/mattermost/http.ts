import type { z } from "zod";
import { AppError } from "../shared/errors.ts";

export const MAX_ERROR_BODY_CHARACTERS = 4_096;
export const MAX_RESPONSE_BODY_BYTES = 16 * 1_024 * 1_024;
export const DEFAULT_TIMEOUT_MS = 30_000;

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

export function redactToken(value: string, token: string): string {
	return token ? value.replaceAll(token, "[REDACTED]") : value;
}

export async function readResponseBytes(
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

export async function readResponseText(
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

export interface MattermostHttpRequest {
	baseUrl: string;
	token: string;
	fetchImplementation: typeof fetch;
	timeoutMs: number;
	method: "GET" | "POST";
	path: string;
	searchParams?: Record<string, string>;
	body?: unknown;
}

/** Shared read-only Mattermost HTTP core with bounded bodies and token redaction. */
export async function requestJson<T>(
	request: MattermostHttpRequest,
	schema: z.ZodType<T>,
): Promise<T> {
	const url = new URL(`${request.baseUrl}${request.path}`);
	for (const [name, value] of Object.entries(request.searchParams ?? {})) {
		url.searchParams.set(name, value);
	}

	let response: Response;
	try {
		response = await request.fetchImplementation(url, {
			method: request.method,
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${request.token}`,
				...(request.body === undefined
					? {}
					: { "Content-Type": "application/json" }),
			},
			...(request.body === undefined
				? {}
				: { body: JSON.stringify(request.body) }),
			signal: AbortSignal.timeout(request.timeoutMs),
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
		const tokenBytes = new TextEncoder().encode(request.token).length;
		const { text } = await readResponseText(
			response,
			MAX_ERROR_BODY_CHARACTERS + tokenBytes,
			true,
		);
		const responseBody = [...redactToken(text, request.token)]
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

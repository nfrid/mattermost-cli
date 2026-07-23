import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MattermostConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";
import type { MattermostClient } from "./mattermost/client.ts";
import { configuredConversations } from "./retrieval.ts";
import type { IndexedFile, MattermostStore } from "./storage.ts";

export interface FileDownloadInput {
	fileId: string;
	out?: string;
	local?: boolean;
}

export interface FileDownloadResult {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	path: string;
	postId: string;
	conversationId: string;
}

export interface FileDownloadClient {
	getFileInfo(fileId: string): Promise<{
		id: string;
		post_id: string;
		name: string;
		extension: string;
		size: number;
		mime_type: string;
		delete_at: number;
	}>;
	downloadFile(fileId: string): Promise<Uint8Array>;
}

const MAX_FILE_NAME_LENGTH = 120;

export async function downloadMattermostFile(
	input: FileDownloadInput,
	dependencies: {
		config: MattermostConfig;
		store: MattermostStore;
		client?: FileDownloadClient;
	},
): Promise<FileDownloadResult> {
	const fileId = input.fileId.trim();
	if (!fileId) {
		throw new ConfigError("File id is required.", "invalid_file_target");
	}

	const allowedConversationIds = new Set(
		configuredConversations(dependencies.config, dependencies.store).map(
			({ id }) => id,
		),
	);
	const local = dependencies.store.getFileById(fileId);
	let meta: IndexedFile & { conversationId: string };

	if (local) {
		if (!allowedConversationIds.has(local.conversationId)) {
			throw new ConfigError(
				"The file belongs to a conversation outside the configured allowlist.",
				"conversation_not_allowed",
			);
		}
		meta = local;
	} else if (input.local || !dependencies.client) {
		throw new ConfigError(
			"File metadata is not present in the local index.",
			"file_not_found",
		);
	} else {
		const info = await dependencies.client.getFileInfo(fileId);
		const post = dependencies.store.getPost(info.post_id);
		if (!post || !allowedConversationIds.has(post.conversationId)) {
			throw new ConfigError(
				"The file belongs to a conversation outside the configured allowlist.",
				"conversation_not_allowed",
			);
		}
		meta = {
			id: info.id,
			postId: info.post_id,
			name: info.name,
			extension: info.extension,
			size: info.size,
			mimeType: info.mime_type,
			deleteAt: info.delete_at,
			conversationId: post.conversationId,
		};
	}

	if (meta.deleteAt) {
		throw new ConfigError(
			"The file has been deleted in Mattermost.",
			"file_deleted",
		);
	}

	if (!dependencies.client) {
		throw new ConfigError(
			"A Mattermost client is required to download file contents.",
			"network_required",
		);
	}

	const bytes = await dependencies.client.downloadFile(fileId);
	const path = input.out?.trim()
		? input.out.trim()
		: defaultDownloadPath(meta.id, meta.name);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);

	return {
		id: meta.id,
		name: meta.name,
		mimeType: meta.mimeType,
		size: meta.size || bytes.byteLength,
		path,
		postId: meta.postId,
		conversationId: meta.conversationId,
	};
}

export function defaultDownloadPath(fileId: string, name: string): string {
	return join(tmpdir(), `mm-${fileId}-${sanitizeFileName(name)}`);
}

export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replaceAll(/[^\w.\-()+ @]/gu, "_")
		.replaceAll(/_+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, MAX_FILE_NAME_LENGTH);
	return cleaned || "attachment";
}

/** Narrow MattermostClient to the file download surface used by this module. */
export function asFileDownloadClient(
	client: MattermostClient,
): FileDownloadClient {
	return client;
}

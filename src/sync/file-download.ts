import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { MattermostConfig } from "../config/config.ts";
import {
	ConfigError,
	conversationNotAllowedDetails,
} from "../shared/errors.ts";
import type { IndexedFile, MattermostStore } from "../store/index.ts";
import { resolveConfiguredAllowlist } from "./conversations.ts";

export interface FileDownloadInput {
	fileId: string;
	/** Explicit destination path; overwrites an existing file. */
	out?: string;
	/**
	 * Destination directory, created if missing. Names the file exactly as
	 * `mm files` does and refuses to overwrite an existing file.
	 */
	outDir?: string;
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

interface FileDownloadClient {
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
		resolveConfiguredAllowlist(dependencies.config, dependencies.store).map(
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
				undefined,
				conversationNotAllowedDetails({
					reason: "not_configured",
					postId: local.postId,
					conversationId: local.conversationId,
				}),
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
				undefined,
				conversationNotAllowedDetails({
					reason: "not_configured",
					postId: info.post_id,
					// Absent when the post itself is unknown locally: there is no
					// conversation id to report that the caller did not already have.
					...(post ? { conversationId: post.conversationId } : {}),
				}),
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

	const path = await resolveDownloadPath(input, meta.id, meta.name);
	const bytes = await dependencies.client.downloadFile(fileId);
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

/**
 * Resolve the destination path for one download.
 * `--out` keeps its historical behavior and overwrites; `--out-dir` names the
 * file exactly as `mm files` does and refuses to overwrite.
 */
async function resolveDownloadPath(
	input: FileDownloadInput,
	fileId: string,
	name: string,
): Promise<string> {
	const out = input.out?.trim();
	const outDir = input.outDir?.trim();

	if (out && outDir) {
		throw new ConfigError(
			"Specify either --out <path> or --out-dir <dir>, not both.",
			"conflicting_out_target",
		);
	}
	if (out) return out;
	if (input.outDir === undefined) return defaultDownloadPath(fileId, name);
	if (!outDir) {
		throw new ConfigError("Output directory is required.", "invalid_out_dir");
	}

	const base = resolve(outDir);
	const path = safeJoinUnderOutDir(
		base,
		uniqueBatchFileName(name || "attachment", fileId, new Map()),
	);
	if (await pathExists(path)) {
		throw new ConfigError(
			`Refusing to overwrite existing file at ${path}.`,
			"file_exists",
		);
	}
	return path;
}

function defaultDownloadPath(fileId: string, name: string): string {
	return join(tmpdir(), `mm-${fileId}-${sanitizeFileName(name)}`);
}

/**
 * Deterministic collision naming shared by single and batch downloads.
 * `usedNames` maps an already claimed lowercased file name to its file id.
 */
export function uniqueBatchFileName(
	name: string,
	fileId: string,
	usedNames: Map<string, string>,
): string {
	const sanitized = sanitizeFileName(name);
	const key = sanitized.toLowerCase();
	if (!usedNames.has(key)) return sanitized;

	const extension = extname(sanitized);
	const stem = basename(sanitized, extension) || "attachment";
	const withId = sanitizeFileName(`${stem}-${fileId}${extension}`);
	if (!usedNames.has(withId.toLowerCase())) return withId;
	return sanitizeFileName(`${fileId}-${sanitized}`);
}

export function safeJoinUnderOutDir(outDir: string, fileName: string): string {
	const base = resolve(outDir);
	const cleaned = sanitizeFileName(fileName);
	const candidate = resolve(join(base, cleaned));
	const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
	if (candidate !== base && !candidate.startsWith(prefix)) {
		throw new ConfigError(
			"Refusing path that escapes the output directory.",
			"path_traversal",
		);
	}
	if (dirname(candidate) !== base) {
		throw new ConfigError(
			"Refusing nested destination paths inside --out-dir.",
			"path_traversal",
		);
	}
	return candidate;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replaceAll(/[^\w.\-()+ @]/gu, "_")
		.replaceAll(/_+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, MAX_FILE_NAME_LENGTH);
	return cleaned || "attachment";
}

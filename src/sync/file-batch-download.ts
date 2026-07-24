import { access, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { MattermostConfig } from "../config/config.ts";
import { ConfigError } from "../shared/errors.ts";
import type { MattermostStore } from "../store/index.ts";
import {
	downloadMattermostFile,
	type FileDownloadResult,
	sanitizeFileName,
} from "./file-download.ts";

/** Hard cap on how many attachments one `mm files` invocation may download. */
export const DEFAULT_MAX_BATCH_FILES = 20;

/** Hard cap on total downloaded bytes across the batch (50 MiB). */
export const DEFAULT_MAX_BATCH_TOTAL_BYTES = 50 * 1024 * 1024;

export type FileBatchSelector =
	| { kind: "file_ids"; fileIds: string[] }
	| { kind: "post"; postId: string }
	| { kind: "thread"; threadId: string };

export interface FileBatchDownloadInput {
	selector: FileBatchSelector;
	outDir: string;
	local?: boolean;
	maxFiles?: number;
	maxTotalBytes?: number;
}

export interface FileBatchDownloadedItem extends FileDownloadResult {
	status: "downloaded";
}

export interface FileBatchFailedItem {
	status: "error" | "skipped";
	id?: string;
	name?: string;
	error: {
		kind: string;
		message: string;
	};
}

export type FileBatchItem = FileBatchDownloadedItem | FileBatchFailedItem;

export interface FileBatchDownloadResult {
	outDir: string;
	selector: FileBatchSelector;
	limits: {
		maxFiles: number;
		maxTotalBytes: number;
	};
	downloaded: number;
	failed: number;
	skipped: number;
	totalBytes: number;
	files: FileBatchItem[];
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

/**
 * Download multiple allowlisted attachments into `--out-dir`.
 * Succeeds with a partial report when at least one file lands; callers should
 * fail the command only when `downloaded === 0`.
 */
export async function downloadMattermostFiles(
	input: FileBatchDownloadInput,
	dependencies: {
		config: MattermostConfig;
		store: MattermostStore;
		client?: FileDownloadClient;
	},
): Promise<FileBatchDownloadResult> {
	const outDir = resolve(input.outDir.trim());
	if (!outDir) {
		throw new ConfigError("Output directory is required.", "invalid_out_dir");
	}

	const maxFiles = input.maxFiles ?? DEFAULT_MAX_BATCH_FILES;
	const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_MAX_BATCH_TOTAL_BYTES;
	if (!Number.isInteger(maxFiles) || maxFiles < 1) {
		throw new ConfigError(
			"maxFiles must be a positive integer.",
			"invalid_batch_limit",
		);
	}
	if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1) {
		throw new ConfigError(
			"maxTotalBytes must be a positive integer.",
			"invalid_batch_limit",
		);
	}

	const fileIds = resolveBatchFileIds(input.selector, dependencies.store);
	if (fileIds.length === 0) {
		throw new ConfigError(
			"No attachments matched the given selector.",
			"no_files_selected",
		);
	}
	if (fileIds.length > maxFiles) {
		throw new ConfigError(
			`Batch would download ${fileIds.length} files; max is ${maxFiles}. Narrow the selector or download fewer file ids.`,
			"batch_file_count_exceeded",
		);
	}

	await mkdir(outDir, { recursive: true });

	const usedNames = new Map<string, string>();
	const files: FileBatchItem[] = [];
	let downloaded = 0;
	let failed = 0;
	let skipped = 0;
	let totalBytes = 0;
	let stopRemaining: "batch_total_size_exceeded" | undefined;

	for (const fileId of fileIds) {
		const local = dependencies.store.getFileById(fileId);
		const displayName = local?.name;
		const knownSize = local?.size ?? 0;

		if (stopRemaining) {
			skipped += 1;
			files.push({
				status: "skipped",
				id: fileId,
				...(displayName ? { name: displayName } : {}),
				error: {
					kind: stopRemaining,
					message: `Skipping remaining files: total size reached ${maxTotalBytes} bytes.`,
				},
			});
			continue;
		}

		if (knownSize > 0 && totalBytes + knownSize > maxTotalBytes) {
			stopRemaining = "batch_total_size_exceeded";
			skipped += 1;
			files.push({
				status: "skipped",
				id: fileId,
				...(displayName ? { name: displayName } : {}),
				error: {
					kind: "batch_total_size_exceeded",
					message: `Skipping remaining files: total size would exceed ${maxTotalBytes} bytes.`,
				},
			});
			continue;
		}

		const plannedName = uniqueBatchFileName(
			displayName ?? "attachment",
			fileId,
			usedNames,
		);
		const outPath = safeJoinUnderOutDir(outDir, plannedName);

		try {
			if (await pathExists(outPath)) {
				skipped += 1;
				files.push({
					status: "skipped",
					id: fileId,
					...(displayName ? { name: displayName } : {}),
					error: {
						kind: "file_exists",
						message: `Refusing to overwrite existing file at ${outPath}.`,
					},
				});
				continue;
			}

			const result = await downloadMattermostFile(
				{
					fileId,
					out: outPath,
					local: input.local,
				},
				dependencies,
			);

			totalBytes += result.size;
			downloaded += 1;
			usedNames.set(plannedName.toLowerCase(), fileId);
			files.push({
				status: "downloaded",
				...result,
			});

			if (totalBytes >= maxTotalBytes) {
				stopRemaining = "batch_total_size_exceeded";
			}
		} catch (error) {
			failed += 1;
			files.push({
				status: "error",
				id: fileId,
				...(displayName ? { name: displayName } : {}),
				error: {
					kind: errorKind(error),
					message: errorMessage(error),
				},
			});
		}
	}

	return {
		outDir,
		selector: input.selector,
		limits: { maxFiles, maxTotalBytes },
		downloaded,
		failed,
		skipped,
		totalBytes,
		files,
	};
}

export function resolveBatchFileIds(
	selector: FileBatchSelector,
	store: MattermostStore,
): string[] {
	switch (selector.kind) {
		case "file_ids": {
			const seen = new Set<string>();
			const ids: string[] = [];
			for (const raw of selector.fileIds) {
				const id = raw.trim();
				if (!id || seen.has(id)) continue;
				seen.add(id);
				ids.push(id);
			}
			return ids;
		}
		case "post": {
			const postId = selector.postId.trim();
			if (!postId) {
				throw new ConfigError("Post id is required.", "invalid_file_target");
			}
			const post = store.getPost(postId);
			if (!post) {
				throw new ConfigError(
					"Post is not present in the local index.",
					"post_not_found",
				);
			}
			return uniqueIds(store.getFilesForPosts([postId]).map((file) => file.id));
		}
		case "thread": {
			const threadId = selector.threadId.trim();
			if (!threadId) {
				throw new ConfigError("Thread id is required.", "invalid_file_target");
			}
			const posts = store.getThread(threadId);
			if (!posts.length) {
				throw new ConfigError(
					"Thread is not present in the local index.",
					"thread_not_found",
				);
			}
			return uniqueIds(
				store
					.getFilesForPosts(posts.map((post) => post.id))
					.map((file) => file.id),
			);
		}
	}
}

function uniqueBatchFileName(
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function uniqueIds(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function errorKind(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"kind" in error &&
		typeof (error as { kind: unknown }).kind === "string"
	) {
		return (error as { kind: string }).kind;
	}
	return "download_failed";
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

import type { ContextResult } from "../../../context/index.ts";
import type { Warning } from "../../../shared/command-result.ts";
import type { FileBatchDownloadResult } from "../../../sync/file-batch-download.ts";
import type { FileDownloadResult } from "../../../sync/file-download.ts";
import type { FileInspection } from "../../../sync/file-inspect.ts";
import type {
	AgentCommandResult,
	AgentEnvelope,
	AgentFollowedAttachment,
	AgentThread,
	AgentThreadAttachment,
} from "../types.ts";

/** Flatten download metadata and an explicitly requested bounded inspection. */
export function projectFileDownload(
	envelope: AgentEnvelope,
	data: FileDownloadResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		id: data.id,
		name: data.name,
		mimeType: data.mimeType,
		size: data.size,
		path: data.path,
		postId: data.postId,
		conversationId: data.conversationId,
		...(data.inspection ? { inspection: data.inspection } : {}),
		warnings,
	};
}

/** Flatten batch download metadata only — never file bytes. */
export function projectFiles(
	envelope: AgentEnvelope,
	data: FileBatchDownloadResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		outDir: data.outDir,
		selector: data.selector,
		limits: data.limits,
		downloaded: data.downloaded,
		failed: data.failed,
		skipped: data.skipped,
		totalBytes: data.totalBytes,
		files: data.files.map((item) => {
			if (item.status === "downloaded") {
				return {
					status: "downloaded" as const,
					id: item.id,
					name: item.name,
					mimeType: item.mimeType,
					size: item.size,
					path: item.path,
					postId: item.postId,
					conversationId: item.conversationId,
				};
			}
			return {
				status: item.status,
				...(item.id ? { id: item.id } : {}),
				...(item.name ? { name: item.name } : {}),
				error: item.error,
			};
		}),
		warnings,
	};
}

export function inspectionByFollowedFile(
	files: ContextResult["followedAttachments"],
): Map<string, FileInspection> {
	const map = new Map<string, FileInspection>();
	for (const file of files ?? []) {
		if (file.inspection) map.set(file.id, file.inspection);
	}
	return map;
}

export function mergeAttachmentInspections(
	threads: readonly AgentThread[],
	inspections: ReadonlyMap<string, FileInspection>,
): AgentThread[] {
	if (!inspections.size) return [...threads];
	return threads.map((thread) => {
		if (!thread.attachments?.length) return thread;
		return {
			...thread,
			attachments: thread.attachments.map((attachment) => {
				const inspection = inspections.get(attachment.id);
				if (!inspection) return attachment;
				return {
					...attachment,
					inspection: projectAttachmentInspection(inspection),
				};
			}),
		};
	});
}

export function projectFollowedAttachment(
	file: FileDownloadResult,
): AgentFollowedAttachment {
	return {
		id: file.id,
		name: file.name,
		path: file.path,
		postId: file.postId,
		...(file.inspection
			? {
					inspectionStatus: file.inspection.status,
					inspection: projectAttachmentInspection(file.inspection),
				}
			: {}),
	};
}

export function projectAttachmentInspection(
	inspection: FileInspection,
): NonNullable<AgentThreadAttachment["inspection"]> {
	if (inspection.status === "preview") {
		return {
			status: "preview",
			format: inspection.format,
			preview: inspection.preview,
			...(inspection.truncated ? { truncated: true as const } : {}),
			trust: "low",
		};
	}
	if (inspection.status === "text_extracted") {
		return {
			status: "text_extracted",
			format: "image",
			text: inspection.text,
			trust: "low",
			...(inspection.engine ? { engine: inspection.engine } : {}),
			...(inspection.truncated ? { truncated: true as const } : {}),
		};
	}
	return {
		status: "not_interpreted",
		format: inspection.format,
		reason: inspection.reason,
		recommendedAction: inspection.recommendedAction,
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

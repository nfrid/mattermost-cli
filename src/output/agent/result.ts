import type {
	ContextResult,
	SearchContextResult,
	ThreadResult,
} from "../../context/index.ts";
import type { CommandResult } from "../../shared/command-result.ts";
import type { FileBatchDownloadResult } from "../../sync/file-batch-download.ts";
import type { FileDownloadResult } from "../../sync/file-download.ts";
import {
	isRecord,
	projectFileDownload,
	projectFiles,
} from "./project/attachments.ts";
import { projectContext, projectThread } from "./project/context.ts";
import { projectSearch } from "./project/search.ts";
import type { AgentCommandResult } from "./types.ts";

/** Build the compact agent view from the same validated result used by JSON output. */
export function projectAgentResult(
	result: CommandResult<unknown>,
): AgentCommandResult {
	if (!result.success) return result;

	const envelope = {
		command: result.command,
		schemaVersion: result.schemaVersion,
		success: true as const,
	};

	switch (result.command) {
		case "context":
			return projectContext(
				envelope,
				result.data as ContextResult,
				result.warnings,
			);
		case "search":
			return projectSearch(
				envelope,
				result.data as SearchContextResult,
				result.warnings,
			);
		case "thread":
			return projectThread(
				envelope,
				result.data as ThreadResult,
				result.warnings,
			);
		case "file":
			return projectFileDownload(
				envelope,
				result.data as FileDownloadResult,
				result.warnings,
			);
		case "files":
			return projectFiles(
				envelope,
				result.data as FileBatchDownloadResult,
				result.warnings,
			);
		default:
			return {
				...envelope,
				...(isRecord(result.data) ? result.data : { result: result.data }),
				warnings: result.warnings,
			};
	}
}

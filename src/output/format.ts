/**
 * Human (non-`--json`) output.
 *
 * The per-command renderers live in `./human/`: `context.ts` for the packet
 * body, `commands.ts` for every other command, and `fields.ts` for the shared
 * field/health/post helpers. This module is the dispatcher.
 */
import type {
	ContextResult,
	PeopleResult,
	SearchContextResult,
	ThreadResult,
} from "../context/index.ts";
import type { CommandResult } from "../shared/command-result.ts";
import type { FileBatchDownloadResult } from "../sync/file-batch-download.ts";
import type { FileDownloadResult } from "../sync/file-download.ts";
import type {
	ChannelValidationResult,
	ConfiguredConversationsResult,
	DoctorResult,
} from "../sync/setup.ts";
import type { SyncResult } from "../sync/sync.ts";
import type { WhoamiResult } from "./human/commands.ts";
import {
	formatChannels,
	formatDoctor,
	formatFile,
	formatFiles,
	formatPeople,
	formatSearch,
	formatSync,
	formatThread,
	formatValidation,
	formatWhoami,
} from "./human/commands.ts";
import { formatContext } from "./human/context.ts";
import { styles } from "./styles.ts";

export function formatHumanResult(result: CommandResult<unknown>): string {
	if (!result.success) {
		return styles.error(
			`Error [${result.error.source}/${result.error.kind}]: ${result.error.message}`,
		);
	}

	let body: string;
	switch (result.command) {
		case "whoami":
			body = formatWhoami(result.data as WhoamiResult);
			break;
		case "channels":
			body = formatChannels(result.data as ConfiguredConversationsResult);
			break;
		case "channels.validate":
			body = formatValidation(result.data as ChannelValidationResult);
			break;
		case "doctor":
			body = formatDoctor(result.data as DoctorResult);
			break;
		case "sync":
			body = formatSync(result.data as SyncResult);
			break;
		case "context":
			body = formatContext(result.data as ContextResult);
			break;
		case "people":
			body = formatPeople(result.data as PeopleResult);
			break;
		case "search":
			body = formatSearch(result.data as SearchContextResult);
			break;
		case "thread":
			body = formatThread(result.data as ThreadResult);
			break;
		case "file":
			body = formatFile(result.data as FileDownloadResult);
			break;
		case "files":
			body = formatFiles(result.data as FileBatchDownloadResult);
			break;
		default:
			body = JSON.stringify(result.data, null, 2);
	}

	const warnings = result.warnings.map((warning) =>
		styles.warning(`Warning: ${warning.message}`),
	);
	return [body, ...warnings].filter(Boolean).join("\n");
}

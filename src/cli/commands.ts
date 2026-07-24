import type { MattermostConfig } from "../config/config.ts";
import {
	type ContextInput,
	getMattermostContext,
	getMattermostThread,
	type SearchInput,
	searchMattermost,
	type ThreadInput,
} from "../context/index.ts";
import {
	connectionFromConfig,
	MattermostClient,
	type MattermostClientOptions,
} from "../mattermost/client.ts";
import {
	type CommandResult,
	commandSuccess,
	type Warning,
} from "../shared/command-result.ts";
import { ConfigError } from "../shared/errors.ts";
import {
	FRESHEN_LOCK_STALE_MS,
	FRESHEN_LOCK_TIMEOUT_MS,
} from "../shared/limits.ts";
import { freshenLockPath, withFileLock } from "../shared/lock.ts";
import { MattermostStore } from "../store/index.ts";
import {
	downloadMattermostFiles,
	type FileBatchDownloadInput,
	type FileBatchDownloadResult,
} from "../sync/file-batch-download.ts";
import {
	downloadMattermostFile,
	type FileDownloadInput,
} from "../sync/file-download.ts";
import {
	listConfiguredConversations,
	runDoctor,
	validateConfiguredConversations,
} from "../sync/setup.ts";
import { type SyncOptions, syncConfiguredConversations } from "../sync/sync.ts";

export interface CommandDependencies extends MattermostClientOptions {
	onProgress?: (message: string) => void;
}

export async function whoamiCommand(
	config: MattermostConfig,
	dependencies: CommandDependencies = {},
): Promise<CommandResult<unknown>> {
	const user = await createClient(config, dependencies).getCurrentUser();
	const displayName =
		[user.first_name, user.last_name].filter(Boolean).join(" ") ||
		user.nickname ||
		user.username;
	return commandSuccess("whoami", {
		id: user.id,
		username: user.username,
		displayName,
	});
}

export function channelsCommand(
	config: MattermostConfig,
): CommandResult<unknown> {
	return commandSuccess("channels", listConfiguredConversations(config));
}

export async function validateChannelsCommand(
	config: MattermostConfig,
	dependencies: CommandDependencies = {},
): Promise<CommandResult<unknown>> {
	const validation = await validateConfiguredConversations(
		config,
		createClient(config, dependencies),
	);
	return commandSuccess(
		"channels.validate",
		validation.data,
		validation.warnings,
	);
}

export async function doctorCommand(
	config: MattermostConfig,
	dependencies: CommandDependencies = {},
): Promise<CommandResult<unknown>> {
	return commandSuccess(
		"doctor",
		await runDoctor(config, () => createClient(config, dependencies)),
	);
}

export async function contextCommand(
	config: MattermostConfig,
	input: ContextInput,
	dependencies: CommandDependencies = {},
): Promise<CommandResult<unknown>> {
	const data = await getMattermostContext(input, {
		config,
		client: input.local ? undefined : createClient(config, dependencies),
	});
	return commandSuccess("context", data, data.warnings);
}

export async function searchCommand(
	config: MattermostConfig,
	input: SearchInput,
): Promise<CommandResult<unknown>> {
	const data = await searchMattermost(input, { config });
	return commandSuccess("search", data, data.warnings);
}

export async function threadCommand(
	config: MattermostConfig,
	input: ThreadInput,
	dependencies: CommandDependencies = {},
): Promise<CommandResult<unknown>> {
	const data = await getMattermostThread(input, {
		config,
		client: input.local ? undefined : createClient(config, dependencies),
	});
	return commandSuccess("thread", data, data.warnings);
}

export async function fileCommand(
	config: MattermostConfig,
	input: FileDownloadInput,
	dependencies: CommandDependencies = {},
): Promise<CommandResult<unknown>> {
	const store = await MattermostStore.open(config.databasePath, {
		concepts: config.concepts,
	});
	try {
		const data = await downloadMattermostFile(input, {
			config,
			store,
			client: input.local ? undefined : createClient(config, dependencies),
		});
		return commandSuccess("file", data);
	} finally {
		store.close();
	}
}

export async function filesCommand(
	config: MattermostConfig,
	input: FileBatchDownloadInput,
	dependencies: CommandDependencies = {},
): Promise<CommandResult<FileBatchDownloadResult>> {
	const store = await MattermostStore.open(config.databasePath, {
		concepts: config.concepts,
	});
	try {
		const data = await downloadMattermostFiles(input, {
			config,
			store,
			client: input.local ? undefined : createClient(config, dependencies),
		});
		if (data.downloaded === 0) {
			throw new ConfigError(
				summarizeBatchFailure(data),
				"batch_download_empty",
			);
		}
		return commandSuccess("files", data, batchWarnings(data));
	} finally {
		store.close();
	}
}

function batchWarnings(data: FileBatchDownloadResult): Warning[] {
	if (data.failed === 0 && data.skipped === 0) return [];
	const parts: string[] = [];
	if (data.failed > 0) parts.push(`${data.failed} failed`);
	if (data.skipped > 0) parts.push(`${data.skipped} skipped`);
	return [
		{
			kind: "batch_partial_failure",
			message: `Downloaded ${data.downloaded}; ${parts.join(", ")}. See files[] for per-item status.`,
		},
	];
}

function summarizeBatchFailure(data: FileBatchDownloadResult): string {
	const first = data.files.find(
		(item) => item.status === "error" || item.status === "skipped",
	);
	if (first && (first.status === "error" || first.status === "skipped")) {
		return `No files downloaded (${data.failed} failed, ${data.skipped} skipped). First issue: ${first.error.message}`;
	}
	return "No files downloaded.";
}

export async function syncCommand(
	config: MattermostConfig,
	options: Pick<SyncOptions, "aliases" | "full"> = {},
	dependencies: CommandDependencies = {},
): Promise<CommandResult<unknown>> {
	const store = await MattermostStore.open(config.databasePath, {
		concepts: config.concepts,
	});
	try {
		const run = () =>
			syncConfiguredConversations(
				config,
				createClient(config, dependencies),
				store,
				{ ...options, onProgress: dependencies.onProgress },
			);
		const lockPath = freshenLockPath(config.databasePath);
		if (!lockPath) {
			return commandSuccess("sync", await run());
		}
		const locked = await withFileLock(lockPath, run, {
			timeoutMs: FRESHEN_LOCK_TIMEOUT_MS,
			staleMs: FRESHEN_LOCK_STALE_MS,
		});
		if (!locked.acquired) {
			return commandSuccess("sync", { synced: [], skipped: true }, [
				{
					kind: "freshen_lock_busy",
					message:
						"Skipped sync because another mm process holds the freshen lock.",
				},
			]);
		}
		return commandSuccess("sync", locked.value);
	} finally {
		store.close();
	}
}

function createClient(
	config: MattermostConfig,
	dependencies: CommandDependencies,
): MattermostClient {
	return new MattermostClient(connectionFromConfig(config), {
		fetch: dependencies.fetch,
		timeoutMs: dependencies.timeoutMs,
	});
}

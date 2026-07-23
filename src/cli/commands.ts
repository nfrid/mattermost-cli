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
	MattermostClient,
	type MattermostClientOptions,
} from "../mattermost/client.ts";
import {
	type CommandResult,
	commandSuccess,
} from "../shared/command-result.ts";
import {
	FRESHEN_LOCK_STALE_MS,
	FRESHEN_LOCK_TIMEOUT_MS,
} from "../shared/limits.ts";
import { freshenLockPath, withFileLock } from "../shared/lock.ts";
import { MattermostStore } from "../store/index.ts";
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
	return new MattermostClient(config, {
		fetch: dependencies.fetch,
		timeoutMs: dependencies.timeoutMs,
	});
}

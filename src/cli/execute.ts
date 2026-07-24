import {
	type LoadConfigOptions,
	loadMattermostConfig,
} from "../config/config.ts";
import { parseCommandResultV1 } from "../contracts/contracts.ts";
import { projectAgentResult } from "../output/agent-view.ts";
import { formatHumanResult } from "../output/format.ts";
import { styles } from "../output/styles.ts";
import {
	type CommandResult,
	commandFailure,
} from "../shared/command-result.ts";
import type { FileBatchSelector } from "../sync/file-batch-download.ts";
import {
	type CommandDependencies,
	channelsCommand,
	contextCommand,
	doctorCommand,
	fileCommand,
	filesCommand,
	searchCommand,
	syncCommand,
	threadCommand,
	validateChannelsCommand,
	whoamiCommand,
} from "./commands.ts";
import type {
	CliContext,
	CommandOptions,
	GlobalOptions,
	OutputWriter,
} from "./types.ts";

export async function executeCommand(
	command: string,
	options: GlobalOptions,
	commandOptions: CommandOptions,
	context: CliContext,
): Promise<CommandResult<unknown>> {
	let resolvedToken = context.env?.MATTERMOST_TOKEN;
	try {
		const loadOptions: LoadConfigOptions = {
			env: context.env,
			projectRoot: context.projectRoot,
			configPath: options.config,
		};
		const config = await loadMattermostConfig(loadOptions);
		resolvedToken = config.token;
		const dependencies: CommandDependencies = {
			fetch: context.fetch,
			timeoutMs: context.timeoutMs,
			onProgress: options.json
				? undefined
				: (message) =>
						context.stderr?.write(`${styles.hint(message)}\n`) ??
						process.stderr.write(`${styles.hint(message)}\n`),
		};

		switch (command) {
			case "whoami":
				return await whoamiCommand(config, dependencies);
			case "channels":
				return channelsCommand(config);
			case "channels.validate":
				return await validateChannelsCommand(config, dependencies);
			case "doctor":
				return await doctorCommand(config, dependencies);
			case "context":
				return await contextCommand(
					config,
					{
						subject: commandOptions.subject,
						ticket: commandOptions.ticket,
						queries: commandOptions.query,
						repositories: commandOptions.repository,
						scopes: commandOptions.scope,
						channels: commandOptions.channel,
						from: commandOptions.from,
						after: commandOptions.after,
						before: commandOptions.before,
						hasFile: commandOptions.hasFile,
						file: commandOptions.file,
						fresh: commandOptions.fresh,
						local: commandOptions.local,
						remoteSearch: commandOptions.remoteSearch,
						noWiden: commandOptions.widen === false,
						includeAutomation: commandOptions.includeAutomation,
						short: commandOptions.short,
						navigate: commandOptions.navigate,
						signals: commandOptions.signals,
					},
					dependencies,
				);
			case "search":
				return await searchCommand(config, {
					subject: commandOptions.subject,
					ticket: commandOptions.ticket,
					queries: commandOptions.query,
					repositories: commandOptions.repository,
					scopes: commandOptions.scope,
					channels: commandOptions.channel,
					from: commandOptions.from,
					after: commandOptions.after,
					before: commandOptions.before,
					hasFile: commandOptions.hasFile,
					file: commandOptions.file,
					local: commandOptions.local,
					noWiden: commandOptions.widen === false,
					includeAutomation: commandOptions.includeAutomation,
					limit: commandOptions.limit,
				});
			case "thread":
				if (!commandOptions.target)
					throw new Error("Thread target is required.");
				return await threadCommand(
					config,
					{
						target: commandOptions.target,
						local: commandOptions.local,
						fresh: commandOptions.fresh,
						full: commandOptions.full,
						around: commandOptions.around,
						beforePosts: commandOptions.beforePosts,
						afterPosts: commandOptions.afterPosts,
						signals: commandOptions.signals,
					},
					dependencies,
				);
			case "file":
				if (!commandOptions.fileId) throw new Error("File id is required.");
				return await fileCommand(
					config,
					{
						fileId: commandOptions.fileId,
						out: commandOptions.out,
					},
					dependencies,
				);
			case "files": {
				const selector = resolveFilesSelector(commandOptions);
				if (!commandOptions.outDir) {
					throw new Error("--out-dir is required.");
				}
				return await filesCommand(
					config,
					{
						selector,
						outDir: commandOptions.outDir,
					},
					dependencies,
				);
			}
			case "sync":
				return await syncCommand(
					config,
					{
						aliases: commandOptions.channel,
						full: commandOptions.full,
					},
					dependencies,
				);
			default:
				throw new Error(`Unsupported command: ${command}`);
		}
	} catch (error) {
		return commandFailure(command, error, [resolvedToken]);
	}
}

function resolveFilesSelector(
	commandOptions: CommandOptions,
): FileBatchSelector {
	const fileIds = commandOptions.fileIds ?? [];
	const postId = commandOptions.postId?.trim() ?? "";
	const threadId = commandOptions.threadId?.trim() ?? "";
	const hasFileIds = fileIds.length > 0;
	const hasPost = postId.length > 0;
	const hasThread = threadId.length > 0;
	const selected = Number(hasFileIds) + Number(hasPost) + Number(hasThread);
	if (selected !== 1) {
		throw new Error(
			"Specify exactly one of --post <id>, --thread <id>, or <file-id…>.",
		);
	}
	if (hasPost) {
		return { kind: "post", postId };
	}
	if (hasThread) {
		return { kind: "thread", threadId };
	}
	return { kind: "file_ids", fileIds };
}

export function emitResult(
	result: CommandResult<unknown>,
	json: boolean,
	pretty: boolean,
	agent: boolean,
	stdout: OutputWriter,
	stderr: OutputWriter,
): void {
	const validated = json || agent ? parseCommandResultV1(result) : undefined;
	const text = agent
		? `${JSON.stringify(projectAgentResult(validated as CommandResult<unknown>))}\n`
		: json
			? `${JSON.stringify(validated, null, pretty ? 2 : undefined)}\n`
			: `${formatHumanResult(result)}\n`;
	if (json || agent || result.success) {
		stdout.write(text);
	} else {
		stderr.write(text);
	}
}

export function inferCommand(args: string[]): string {
	const positional = args.filter(
		(argument, index) =>
			!argument.startsWith("-") && args[index - 1] !== "--config",
	);
	return positional.slice(0, 2).join(".") || "cli";
}

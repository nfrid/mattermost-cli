import {
	type LoadConfigOptions,
	loadMattermostConfig,
	type MattermostConfig,
} from "../config/config.ts";
import {
	type ContextResult,
	followRecommendedSteps,
	type SearchInput,
} from "../context/index.ts";
import { parseCommandResultV1 } from "../contracts/contracts.ts";
import {
	connectionFromConfig,
	MattermostClient,
} from "../mattermost/client.ts";
import { projectAgentResult } from "../output/agent-view.ts";
import { formatHumanResult } from "../output/format.ts";
import { styles } from "../output/styles.ts";
import {
	type CommandResult,
	commandFailure,
	commandSuccess,
} from "../shared/command-result.ts";
import { ConfigError } from "../shared/errors.ts";
import type { FileBatchSelector } from "../sync/file-batch-download.ts";
import {
	type CommandDependencies,
	channelsCommand,
	contextCommand,
	doctorCommand,
	fileCommand,
	filesCommand,
	peopleCommand,
	searchCommand,
	syncCommand,
	threadCommand,
	validateChannelsCommand,
	whoamiCommand,
} from "./commands.ts";
import { resolveContextAgentBrief } from "./context-projection.ts";
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
			case "context": {
				if (commandOptions.followRecommended && !options.agent) {
					throw new ConfigError(
						"--follow-recommended requires --agent.",
						"invalid_follow_recommended",
					);
				}
				const brief = resolveContextAgentBrief({
					agent: Boolean(options.agent),
					subject: commandOptions.subject,
					ticket: commandOptions.ticket,
					brief: commandOptions.brief,
					navigate: commandOptions.navigate,
					short: commandOptions.short,
					fullPosts: commandOptions.fullPosts,
				});
				const contextConfig = applyBudgetOverrides(config, commandOptions);
				const result = await contextCommand(
					contextConfig,
					{
						...retrievalInput(commandOptions),
						fresh: commandOptions.fresh,
						remoteSearch: commandOptions.remoteSearch,
						short: commandOptions.short,
						navigate: commandOptions.navigate,
						...(brief ? { brief: true } : {}),
						...(commandOptions.fullPosts ? { fullPosts: true } : {}),
						timeline: commandOptions.timeline,
						signals: commandOptions.signals,
						permalinks: commandOptions.permalink,
					},
					dependencies,
				);
				if (
					!commandOptions.followRecommended ||
					!result.success ||
					!isContextData(result.data)
				) {
					return result;
				}
				const followed = await followRecommendedSteps({
					context: result.data,
					config: contextConfig,
					local: commandOptions.local,
					client: commandOptions.local
						? undefined
						: createFollowClient(contextConfig, dependencies),
				});
				return commandSuccess(
					"context",
					followed.context,
					followed.context.warnings,
				);
			}
			case "people":
				return await peopleCommand(config, {
					channels: commandOptions.channel,
					limit: commandOptions.limit,
				});
			case "search":
				return await searchCommand(config, {
					...retrievalInput(commandOptions),
					limit: commandOptions.limit,
					excerpts: commandOptions.excerpts,
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
						windowOnly: commandOptions.windowOnly,
						brief: commandOptions.brief,
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
						outDir: commandOptions.outDir,
						agent: options.agent,
						inspect: commandOptions.inspect,
						previewLines: commandOptions.previewLines,
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

function createFollowClient(
	config: MattermostConfig,
	dependencies: CommandDependencies,
): MattermostClient {
	return new MattermostClient(connectionFromConfig(config), {
		fetch: dependencies.fetch,
		timeoutMs: dependencies.timeoutMs,
	});
}

function isContextData(data: unknown): data is ContextResult {
	return (
		typeof data === "object" &&
		data !== null &&
		"threads" in data &&
		"evidence" in data &&
		"subject" in data
	);
}

/**
 * The subject, routing, and filter options `context` and `search` share. Both
 * commands expose the same retrieval flags, so the mapping lives in one place.
 */
function retrievalInput(
	commandOptions: CommandOptions,
): Omit<SearchInput, "limit" | "excerpts"> {
	return {
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
	};
}

const MAX_THREADS_CLI_CAP = 20;
const MAX_CHARACTERS_CLI_CAP = 200_000;
const PER_THREAD_CHARACTERS_CLI_CAP = 100_000;

/**
 * Apply request-scoped budget CLI overrides onto a config copy. Defaults stay
 * config-backed when flags are omitted (including `defaultMaxThreads: 3`).
 */
export function applyBudgetOverrides(
	config: MattermostConfig,
	options: Pick<
		CommandOptions,
		"maxThreads" | "maxCharacters" | "perThreadCharacters"
	>,
): MattermostConfig {
	const maxThreads = options.maxThreads;
	const maxCharacters = options.maxCharacters;
	const perThreadCharacters = options.perThreadCharacters;
	if (
		maxThreads === undefined &&
		maxCharacters === undefined &&
		perThreadCharacters === undefined
	) {
		return config;
	}
	if (
		maxThreads !== undefined &&
		(!Number.isInteger(maxThreads) ||
			maxThreads < 1 ||
			maxThreads > MAX_THREADS_CLI_CAP)
	) {
		throw new ConfigError(
			`--max-threads must be an integer from 1 to ${MAX_THREADS_CLI_CAP}.`,
			"invalid_budget_override",
		);
	}
	if (
		maxCharacters !== undefined &&
		(!Number.isInteger(maxCharacters) ||
			maxCharacters < 1_000 ||
			maxCharacters > MAX_CHARACTERS_CLI_CAP)
	) {
		throw new ConfigError(
			`--max-characters must be an integer from 1000 to ${MAX_CHARACTERS_CLI_CAP}.`,
			"invalid_budget_override",
		);
	}
	if (
		perThreadCharacters !== undefined &&
		(!Number.isInteger(perThreadCharacters) ||
			perThreadCharacters < 500 ||
			perThreadCharacters > PER_THREAD_CHARACTERS_CLI_CAP)
	) {
		throw new ConfigError(
			`--per-thread-characters must be an integer from 500 to ${PER_THREAD_CHARACTERS_CLI_CAP}.`,
			"invalid_budget_override",
		);
	}
	return {
		...config,
		budgets: {
			...config.budgets,
			...(maxThreads !== undefined ? { defaultMaxThreads: maxThreads } : {}),
			...(maxCharacters !== undefined
				? { defaultMaxCharacters: maxCharacters }
				: {}),
			...(perThreadCharacters !== undefined
				? { defaultPerThreadCharacters: perThreadCharacters }
				: {}),
		},
	};
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

/**
 * The rendered document plus the stream it belongs on. Separated from
 * {@link emitResult} so a caller redirecting output to a file can reuse the
 * exact bytes stdout would have received.
 */
export function renderResult(
	result: CommandResult<unknown>,
	json: boolean,
	pretty: boolean,
	agent: boolean,
): { text: string; stream: "stdout" | "stderr" } {
	const validated = json || agent ? parseCommandResultV1(result) : undefined;
	const text = agent
		? `${JSON.stringify(projectAgentResult(validated as CommandResult<unknown>))}\n`
		: json
			? `${JSON.stringify(validated, null, pretty ? 2 : undefined)}\n`
			: `${formatHumanResult(result)}\n`;
	return {
		text,
		stream: json || agent || result.success ? "stdout" : "stderr",
	};
}

export function emitResult(
	result: CommandResult<unknown>,
	json: boolean,
	pretty: boolean,
	agent: boolean,
	stdout: OutputWriter,
	stderr: OutputWriter,
): void {
	const { text, stream } = renderResult(result, json, pretty, agent);
	(stream === "stdout" ? stdout : stderr).write(text);
}

export function inferCommand(args: string[]): string {
	const positional = args.filter(
		(argument, index) =>
			!argument.startsWith("-") && args[index - 1] !== "--config",
	);
	return positional.slice(0, 2).join(".") || "cli";
}

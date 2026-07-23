import chalk from "chalk";
import { Command, CommanderError, Option } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { projectAgentResult } from "./agent.ts";
import {
	type CommandDependencies,
	channelsCommand,
	contextCommand,
	doctorCommand,
	fileCommand,
	searchCommand,
	syncCommand,
	threadCommand,
	validateChannelsCommand,
	whoamiCommand,
} from "./commands.ts";
import { type LoadConfigOptions, loadMattermostConfig } from "./config.ts";
import { DEFAULT_SEARCH_LIMIT } from "./context.ts";
import { parseCommandResultV1 } from "./contracts.ts";
import { formatHumanResult } from "./format.ts";
import {
	type CommandResult,
	commandFailure,
	resultExitCode,
} from "./results.ts";
import { styles } from "./styles.ts";

const VERSION = packageJson.version;
const GLOBAL_HELP = `
Global options:
  --config <path>      path to local Mattermost config
  --json               emit one minified versioned JSON document
  --pretty             emit one pretty-printed versioned JSON document
  --agent              emit a compact agent-oriented JSON projection
  --color              force colored output
  --no-color           disable colored output`;

export interface OutputWriter {
	write(text: string): unknown;
}

export interface CliContext extends CommandDependencies {
	stdout?: OutputWriter;
	stderr?: OutputWriter;
	env?: Record<string, string | undefined>;
	projectRoot?: string;
}

interface GlobalOptions {
	config?: string;
	json?: boolean;
	pretty?: boolean;
	agent?: boolean;
}

interface CommandOptions {
	subject?: string;
	target?: string;
	fileId?: string;
	ticket?: string;
	query?: string[];
	repository?: string[];
	scope?: string[];
	channel?: string[];
	from?: string;
	after?: string;
	before?: string;
	hasFile?: boolean;
	file?: string;
	out?: string;
	fresh?: boolean;
	local?: boolean;
	remoteSearch?: boolean;
	widen?: boolean;
	full?: boolean;
	around?: string;
	includeAutomation?: boolean;
	short?: boolean;
	limit?: number;
}

export async function runCli(
	args: string[],
	context: CliContext = {},
): Promise<number> {
	const stdout = context.stdout ?? process.stdout;
	const stderr = context.stderr ?? process.stderr;
	if (args.includes("--no-color")) chalk.level = 0;
	else if (args.includes("--color")) chalk.level = 1;
	let activeCommand = inferCommand(args);
	let pretty = args.includes("--pretty");
	let agent = args.includes("--agent");
	let json = args.includes("--json") || pretty;
	let emitted = false;
	let exitCode = 0;
	const program = createProgram(
		async (command, options, commandOptions = {}) => {
			activeCommand = command;
			pretty = options.pretty ?? false;
			agent = options.agent ?? false;
			json = (options.json ?? false) || pretty;
			const result = await executeCommand(
				command,
				{ ...options, json: json || agent },
				commandOptions,
				context,
			);
			emitResult(result, json, pretty, agent, stdout, stderr);
			emitted = true;
			exitCode = resultExitCode(result);
			return result;
		},
	);

	try {
		await program.parseAsync(args, { from: "user" });
		return exitCode;
	} catch (error) {
		if (
			error instanceof CommanderError &&
			(error.code === "commander.helpDisplayed" ||
				error.code === "commander.version")
		) {
			return 0;
		}

		if (!emitted) {
			const result = commandFailure(activeCommand, error, [
				context.env?.MATTERMOST_TOKEN,
			]);
			emitResult(result, json, pretty, agent, stdout, stderr);
			return resultExitCode(result);
		}

		return 1;
	}
}

function createProgram(
	run: (
		command: string,
		options: GlobalOptions,
		commandOptions?: CommandOptions,
	) => Promise<CommandResult<unknown>>,
): Command {
	const program = new Command();
	program
		.name("mm")
		.description("Read-only Mattermost context retrieval and indexing.")
		.version(VERSION)
		.option("--config <path>", "path to local Mattermost config")
		.option("--json", "emit one minified versioned JSON document")
		.option("--pretty", "emit one pretty-printed versioned JSON document")
		.addOption(
			new Option(
				"--agent",
				"emit a compact agent-oriented JSON projection",
			).conflicts(["json", "pretty"]),
		)
		.showSuggestionAfterError()
		.exitOverride()
		.configureOutput({ outputError: () => {} });

	program.addOption(
		new Option("--color", "force colored output").conflicts("noColor"),
	);
	program.addOption(new Option("--no-color", "disable colored output"));

	program
		.command("whoami")
		.description("Show the authenticated Mattermost user.")
		.addHelpText("after", GLOBAL_HELP)
		.action(async () => {
			await run("whoami", program.opts<GlobalOptions>());
		});

	const channels = program
		.command("channels")
		.description("List configured channels and direct messages.")
		.addHelpText("after", GLOBAL_HELP)
		.action(async () => {
			await run("channels", program.opts<GlobalOptions>());
		});
	channels
		.command("validate")
		.description("Validate configured conversations without modifying config.")
		.addHelpText("after", GLOBAL_HELP)
		.action(async () => {
			await run("channels.validate", program.opts<GlobalOptions>());
		});

	program
		.command("doctor")
		.description(
			"Check authentication, configuration, access, and local support.",
		)
		.addHelpText("after", GLOBAL_HELP)
		.action(async () => {
			await run("doctor", program.opts<GlobalOptions>());
		});

	const context = program
		.command("context")
		.description("Retrieve a bounded, current Mattermost context packet.")
		.argument("[subject]", "ticket key, post permalink/ID, or free text")
		.option("--ticket <key>", "explicit issue tracker key")
		.option(
			"--query <probe>",
			"additional ranking signal, not a required filter (repeatable)",
			collect,
			[],
		)
		.option(
			"--repository <name>",
			"repository routing hint (repeatable)",
			collect,
			[],
		)
		.option("--scope <name>", "scope routing hint (repeatable)", collect, [])
		.option(
			"--channel <alias>",
			"restrict to a configured alias (repeatable)",
			collect,
			[],
		)
		.option("--from <username>", "require the username in the thread")
		.option("--after <date>", "require a post at or after this date")
		.option("--before <date>", "require a post before this date")
		.option("--has-file", "require an attachment in the thread")
		.option("--file <pattern>", "require an attachment filename substring")
		.option("--fresh", "force reconciliation of routed conversations")
		.option("--local", "perform no network calls")
		.addOption(
			new Option(
				"--remote-search",
				"request bounded Mattermost server-side search fallback",
			).conflicts("local"),
		)
		.option("--no-widen", "disable one-time routing fallback")
		.option(
			"--include-automation",
			"include unreplied bot/automation root posts in results",
		)
		.option(
			"--short",
			"pack evidence cards with ticket windows and anchors instead of dense timelines",
		)
		.addHelpText("after", GLOBAL_HELP)
		.action(async (subject?: string) => {
			await run("context", program.opts<GlobalOptions>(), {
				...context.opts<CommandOptions>(),
				subject,
			});
		});

	const search = program
		.command("search")
		.description("Search the local index and return compact thread candidates.")
		.argument("[subject]", "ticket key, post permalink/ID, or free text")
		.option("--ticket <key>", "explicit issue tracker key")
		.option(
			"--query <probe>",
			"additional ranking signal, not a required filter (repeatable)",
			collect,
			[],
		)
		.option(
			"--repository <name>",
			"repository routing hint (repeatable)",
			collect,
			[],
		)
		.option("--scope <name>", "scope routing hint (repeatable)", collect, [])
		.option(
			"--channel <alias>",
			"restrict to a configured alias (repeatable)",
			collect,
			[],
		)
		.option("--from <username>", "require the username in the thread")
		.option("--after <date>", "require a post at or after this date")
		.option("--before <date>", "require a post before this date")
		.option("--has-file", "require an attachment in the thread")
		.option("--file <pattern>", "require an attachment filename substring")
		.option(
			"--limit <n>",
			`max ranked candidates to return (default ${DEFAULT_SEARCH_LIMIT})`,
			(value) => Number(value),
		)
		.option("--local", "perform no network calls (search is always local)")
		.option("--no-widen", "disable one-time routing fallback")
		.option(
			"--include-automation",
			"include unreplied bot/automation root posts in results",
		)
		.addHelpText("after", GLOBAL_HELP)
		.action(async (subject?: string) => {
			await run("search", program.opts<GlobalOptions>(), {
				...search.opts<CommandOptions>(),
				subject,
			});
		});

	const thread = program
		.command("thread")
		.description("Retrieve one configured Mattermost thread.")
		.argument("<target>", "post ID or permalink")
		.option("--local", "perform no network calls")
		.option("--fresh", "force a remote thread refresh when possible")
		.option("--full", "return the complete selected thread")
		.option("--around <post-id>", "prioritize a neighborhood around one post")
		.addHelpText("after", GLOBAL_HELP)
		.action(async (target: string) => {
			await run("thread", program.opts<GlobalOptions>(), {
				...thread.opts<CommandOptions>(),
				target,
			});
		});

	const file = program
		.command("file")
		.description(
			"Download one attachment from a configured conversation into a local path.",
		)
		.argument("<file-id>", "Mattermost file id from context/thread evidence")
		.option("--out <path>", "destination path (default: /tmp/mm-<id>-<name>)")
		.addHelpText("after", GLOBAL_HELP)
		.action(async (fileId: string) => {
			await run("file", program.opts<GlobalOptions>(), {
				...file.opts<CommandOptions>(),
				fileId,
			});
		});

	const sync = program
		.command("sync")
		.description("Synchronize configured conversations into the local index.")
		.option(
			"--channel <alias>",
			"restrict sync to a configured alias (repeatable)",
			collect,
			[],
		)
		.option("--full", "backfill complete available history")
		.addHelpText("after", GLOBAL_HELP)
		.action(async () => {
			await run(
				"sync",
				program.opts<GlobalOptions>(),
				sync.opts<CommandOptions>(),
			);
		});

	return program;
}

async function executeCommand(
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

function emitResult(
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

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

function inferCommand(args: string[]): string {
	const positional = args.filter(
		(argument, index) =>
			!argument.startsWith("-") && args[index - 1] !== "--config",
	);
	return positional.slice(0, 2).join(".") || "cli";
}

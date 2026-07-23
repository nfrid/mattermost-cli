import { Command, Option } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { DEFAULT_SEARCH_LIMIT } from "../context/index.ts";
import type { CommandResult } from "../shared/command-result.ts";
import type { CommandOptions, GlobalOptions } from "./types.ts";

const VERSION = packageJson.version;
const GLOBAL_HELP = `
Global options:
  --config <path>      path to local Mattermost config
  --json               emit one minified versioned JSON document
  --pretty             emit one pretty-printed versioned JSON document
  --agent              emit a compact agent-oriented JSON projection
  --color              force colored output
  --no-color           disable colored output`;

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** Shared retrieval option block for context/search commands. */
export function addRetrievalOptions(command: Command): Command {
	return command
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
		.option("--no-widen", "disable one-time routing fallback")
		.option(
			"--include-automation",
			"include unreplied bot/automation root posts in results",
		);
}

export function createProgram(
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

	const context = addRetrievalOptions(
		program
			.command("context")
			.description("Retrieve a bounded, current Mattermost context packet.")
			.argument("[subject]", "ticket key, post permalink/ID, or free text"),
	)
		.option("--fresh", "force reconciliation of routed conversations")
		.option("--local", "perform no network calls")
		.addOption(
			new Option(
				"--remote-search",
				"request bounded Mattermost server-side search fallback",
			).conflicts("local"),
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

	const search = addRetrievalOptions(
		program
			.command("search")
			.description(
				"Search the local index and return compact thread candidates.",
			)
			.argument("[subject]", "ticket key, post permalink/ID, or free text"),
	)
		.option(
			"--limit <n>",
			`max ranked candidates to return (default ${DEFAULT_SEARCH_LIMIT})`,
			(value) => Number(value),
		)
		.option("--local", "perform no network calls (search is always local)")
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

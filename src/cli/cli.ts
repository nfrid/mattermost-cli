import chalk from "chalk";
import { CommanderError } from "commander";
import {
	type CommandResult,
	commandFailure,
	resultExitCode,
} from "../shared/command-result.ts";
import {
	emitResult,
	executeCommand,
	inferCommand,
	renderResult,
} from "./execute.ts";
import { createProgram } from "./program.ts";
import type { CliContext, OutputWriter } from "./types.ts";

export type { CliContext, OutputWriter } from "./types.ts";

/**
 * Retrieval commands accept `--out <path>` so a large packet can be inspected
 * with file tools instead of being pasted through stdout. Only a successful
 * document is redirected: an error must stay where the caller is looking.
 */
const OUT_REDIRECT_COMMANDS = new Set(["context", "search", "thread"]);

async function emitOrWrite(
	result: CommandResult<unknown>,
	options: { json: boolean; pretty: boolean; agent: boolean; out?: string },
	command: string,
	stdout: OutputWriter,
	stderr: OutputWriter,
): Promise<void> {
	const out = options.out?.trim();
	if (!out || !OUT_REDIRECT_COMMANDS.has(command) || !result.success) {
		emitResult(
			result,
			options.json,
			options.pretty,
			options.agent,
			stdout,
			stderr,
		);
		return;
	}
	const { text } = renderResult(
		result,
		options.json,
		options.pretty,
		options.agent,
	);
	const bytes = await Bun.write(out, text);
	stdout.write(
		options.json || options.agent
			? `${JSON.stringify({ out, bytes })}\n`
			: `Wrote ${bytes} bytes to ${out}\n`,
	);
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
			await emitOrWrite(
				result,
				{ json, pretty, agent, out: commandOptions.out },
				command,
				stdout,
				stderr,
			);
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

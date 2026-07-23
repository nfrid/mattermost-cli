import chalk from "chalk";
import { CommanderError } from "commander";
import {
	type CommandResult,
	commandFailure,
	resultExitCode,
} from "../shared/command-result.ts";
import { emitResult, executeCommand, inferCommand } from "./execute.ts";
import { createProgram } from "./program.ts";
import type { CliContext, OutputWriter } from "./types.ts";

export type { CliContext, OutputWriter } from "./types.ts";

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

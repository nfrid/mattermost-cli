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
	const receipt = outReceipt(result);
	stdout.write(
		options.json || options.agent
			? `${JSON.stringify({ out, bytes, ...receipt })}\n`
			: `Wrote ${bytes} bytes to ${out}${receiptSuffix(receipt)}\n`,
	);
}

/**
 * The few numbers that decide whether the file needs reading at all, and in
 * what order. Without them `{out,bytes}` forces a second `jq` pass just to learn
 * whether a `recommended` step is waiting — which is exactly the read `--out`
 * exists to avoid.
 */
interface OutReceipt {
	adequacy?: string;
	threads?: number;
	warnings: number;
	materialWarnings: number;
	recommendedNext?: number;
	canAnswer?: boolean;
	recommendedActionRequired?: boolean;
	blockedPermalinks?: number;
	subjectMatchedThreadsDropped?: number;
}

function outReceipt(result: CommandResult<unknown>): OutReceipt {
	const data =
		result.success && isRecord(result.data) ? result.data : undefined;
	const evidence = isRecord(data?.evidence) ? data.evidence : undefined;
	const verdict = isRecord(evidence?.verdict) ? evidence.verdict : undefined;
	const selection = isRecord(evidence?.selection)
		? evidence.selection
		: undefined;
	const next = Array.isArray(evidence?.next) ? evidence.next : [];
	const threads = Array.isArray(data?.threads)
		? data.threads.length
		: undefined;
	const researchSummary = isRecord(data?.researchSummary)
		? data.researchSummary
		: undefined;
	const blockedFromSummary = Array.isArray(
		researchSummary?.blockedOrUnresolvedPermalinks,
	)
		? researchSummary.blockedOrUnresolvedPermalinks.length
		: undefined;
	const permalinks = Array.isArray(data?.permalinks) ? data.permalinks : [];
	const blockedFromPermalinks = permalinks.filter(
		(entry) =>
			isRecord(entry) &&
			(entry.status === "not_allowed" ||
				entry.status === "unresolved" ||
				entry.status === "invalid"),
	).length;
	const blockedPermalinks = blockedFromSummary ?? blockedFromPermalinks;
	return {
		...(typeof evidence?.adequacy === "string"
			? { adequacy: evidence.adequacy }
			: {}),
		...(threads === undefined ? {} : { threads }),
		warnings: result.warnings.length,
		materialWarnings: result.warnings.filter(
			({ severity }) => severity !== "informational",
		).length,
		...(evidence
			? {
					recommendedNext: next.filter(
						(step) => isRecord(step) && step.priority === "recommended",
					).length,
				}
			: {}),
		...(typeof verdict?.canAnswerFromSelectedEvidence === "boolean"
			? { canAnswer: verdict.canAnswerFromSelectedEvidence }
			: {}),
		...(typeof verdict?.recommendedActionRequired === "boolean"
			? { recommendedActionRequired: verdict.recommendedActionRequired }
			: {}),
		...(blockedPermalinks > 0 ? { blockedPermalinks } : {}),
		...(typeof selection?.droppedByBudgetSubjectMatched === "number"
			? {
					subjectMatchedThreadsDropped: selection.droppedByBudgetSubjectMatched,
				}
			: {}),
	};
}

function receiptSuffix(receipt: OutReceipt): string {
	const parts = [
		receipt.adequacy ? `evidence ${receipt.adequacy}` : undefined,
		receipt.canAnswer === undefined
			? undefined
			: receipt.canAnswer
				? "can answer"
				: "cannot answer from selected",
		receipt.threads === undefined ? undefined : `${receipt.threads} thread(s)`,
		`${receipt.materialWarnings} material / ${receipt.warnings} total warning(s)`,
		receipt.recommendedNext === undefined
			? undefined
			: `${receipt.recommendedNext} recommended step(s)`,
		receipt.recommendedActionRequired
			? "recommended action required"
			: undefined,
		receipt.blockedPermalinks
			? `${receipt.blockedPermalinks} blocked permalink(s)`
			: undefined,
		receipt.subjectMatchedThreadsDropped
			? `${receipt.subjectMatchedThreadsDropped} subject-matched drop(s)`
			: undefined,
	].filter((part): part is string => part !== undefined);
	return ` (${parts.join(", ")})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

if (import.meta.main) {
	process.exitCode = await runCli(Bun.argv.slice(2));
}

import type { CommandDependencies } from "./commands.ts";

export interface OutputWriter {
	write(text: string): unknown;
}

export interface CliContext extends CommandDependencies {
	stdout?: OutputWriter;
	stderr?: OutputWriter;
	env?: Record<string, string | undefined>;
	projectRoot?: string;
}

export interface GlobalOptions {
	config?: string;
	json?: boolean;
	pretty?: boolean;
	agent?: boolean;
}

export interface CommandOptions {
	subject?: string;
	target?: string;
	fileId?: string;
	fileIds?: string[];
	postId?: string;
	threadId?: string;
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
	outDir?: string;
	inspect?: boolean;
	previewLines?: number;
	fresh?: boolean;
	local?: boolean;
	remoteSearch?: boolean;
	widen?: boolean;
	full?: boolean;
	around?: string;
	beforePosts?: number;
	afterPosts?: number;
	windowOnly?: boolean;
	includeAutomation?: boolean;
	short?: boolean;
	navigate?: boolean;
	/** Decision-only `--agent` projection. */
	brief?: boolean;
	/** Merge selected threads into one cross-thread chronology. */
	timeline?: boolean;
	/** Opt-in agent emission of advisory `signals` and `technicalEntities`. */
	signals?: boolean;
	/** Repeatable `--permalink`: extra links folded into one context packet. */
	permalink?: string[];
	limit?: number;
	/** Excerpts per candidate in `search --agent`. */
	excerpts?: number;
}

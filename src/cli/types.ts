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
	fresh?: boolean;
	local?: boolean;
	remoteSearch?: boolean;
	widen?: boolean;
	full?: boolean;
	around?: string;
	beforePosts?: number;
	afterPosts?: number;
	includeAutomation?: boolean;
	short?: boolean;
	navigate?: boolean;
	/** Opt-in agent emission of advisory `signals` and `technicalEntities`. */
	signals?: boolean;
	limit?: number;
}

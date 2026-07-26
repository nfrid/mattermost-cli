import { classifySubject } from "../search/subject.ts";

/**
 * Whether `context` should run the decision-only brief projection.
 *
 * Ticket subjects under `--agent` default to brief unless the caller opts into
 * dense posts (`--full-posts`) or another exclusive projection (`--navigate` /
 * `--short`). Explicit `--brief` always wins. Human (non-agent) output keeps
 * today's dense default unless `--brief` is passed.
 */
export function resolveContextAgentBrief(input: {
	agent: boolean;
	subject?: string;
	ticket?: string;
	brief?: boolean;
	navigate?: boolean;
	short?: boolean;
	fullPosts?: boolean;
}): boolean {
	if (input.brief) return true;
	if (!input.agent) return false;
	if (input.navigate || input.short || input.fullPosts) return false;
	try {
		return classifySubject(input.subject, input.ticket).kind === "ticket";
	} catch {
		return false;
	}
}

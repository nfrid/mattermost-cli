import { classifySubject } from "../search/subject.ts";

/**
 * Whether `context` should emit the decision brief layer.
 *
 * Ticket subjects under `--agent` default to brief (including with
 * `--full-posts`, which keeps dense posts *and* top-level `brief`). Legacy
 * `--short` still opts out. Explicit `--brief` always wins. `--navigate` keeps
 * top-level brief for tickets (lean posts + decision layer). Human (non-agent)
 * output keeps today's dense default unless `--brief` is passed.
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
	if (input.short) return false;
	try {
		return classifySubject(input.subject, input.ticket).kind === "ticket";
	} catch {
		return false;
	}
}

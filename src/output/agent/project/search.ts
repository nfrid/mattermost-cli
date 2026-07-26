import type { SearchContextResult } from "../../../context/index.ts";
import type { Warning } from "../../../shared/command-result.ts";
import { isoTimestamp, subjectValue } from "../../shared.ts";
import type {
	AgentCandidate,
	AgentCommandResult,
	AgentEnvelope,
} from "../types.ts";
import { status } from "./shared.ts";

export const SHORT_MESSAGE_LIMIT = 8;

export const SEARCH_CONTRIBUTING_PROBES_LIMIT = 12;

export function projectSearch(
	envelope: AgentEnvelope,
	data: SearchContextResult,
	warnings: Warning[],
): AgentCommandResult {
	return {
		...envelope,
		subject: subjectValue(data.subject),
		status: status(data.freshnessMode),
		candidates: data.candidates.map((candidate, index): AgentCandidate => {
			const contributingProbes = [
				...new Set(candidate.matches.map(({ probe }) => probe)),
			].filter(Boolean);
			const excerpts = [
				...new Set(candidate.matches.map(({ excerpt }) => excerpt)),
			].filter((excerpt) => excerpt.length > 0);
			return {
				rank: index + 1,
				threadId: candidate.threadId,
				conversation: candidate.conversationAlias,
				kind: candidate.conversationKind,
				url: candidate.link,
				latestAt: isoTimestamp(candidate.latestActivityAt),
				reasons: [...candidate.reasons],
				...(contributingProbes.length
					? {
							contributingProbes: contributingProbes.slice(
								0,
								SEARCH_CONTRIBUTING_PROBES_LIMIT,
							),
							...(contributingProbes.length > SEARCH_CONTRIBUTING_PROBES_LIMIT
								? {
										omittedContributingProbes:
											contributingProbes.length -
											SEARCH_CONTRIBUTING_PROBES_LIMIT,
									}
								: {}),
						}
					: {}),
				excerpts: excerpts.slice(0, data.excerptLimit),
				...(excerpts.length > data.excerptLimit
					? { omittedExcerpts: excerpts.length - data.excerptLimit }
					: {}),
			};
		}),
		warnings,
	};
}

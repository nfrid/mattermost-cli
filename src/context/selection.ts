import type { SelectionEvidence } from "./types.ts";

export function selectionEvidence(input: {
	candidateThreads: number;
	returnedThreads: number;
	droppedThin: number;
	droppedByBudget: number;
	droppedNoMatch: number;
}): SelectionEvidence {
	return {
		candidateThreads: input.candidateThreads,
		returnedThreads: input.returnedThreads,
		droppedThin: input.droppedThin,
		droppedByBudget: input.droppedByBudget,
		droppedNoMatch: input.droppedNoMatch,
	};
}

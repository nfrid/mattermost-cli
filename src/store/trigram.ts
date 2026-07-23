import { normalizeMorphText } from "../search/search-token-normalization.ts";
import { normalizeSearchText } from "../search/text.ts";
import type { TrigramSearchPolicy } from "./types.ts";

export function stringTrigrams(value: string): string[] {
	const normalized = normalizeSearchText(value).trim();
	if (normalized.length < 3) return [];
	return [
		...new Set(
			Array.from({ length: normalized.length - 2 }, (_, index) =>
				normalized.slice(index, index + 3),
			),
		),
	];
}

export function trigramSearchPolicy(probe: string): TrigramSearchPolicy | null {
	const tokens = normalizeSearchText(probe).match(/[\p{L}\p{N}_-]+/gu) ?? [];
	const length = Array.from(tokens[0] ?? "").length;
	if (tokens.length !== 1 || length < 5 || length > 64) return null;
	const token = tokens[0] ?? "";
	const latin = /^[a-z]+$/u.test(token);
	return {
		minimumSimilarity: !latin && length <= 9 ? 0.5 : length <= 6 ? 0.5 : 0.6,
		maximumEditDistance: latin && length <= 6 ? 3 : length >= 10 ? 2 : 1,
	};
}

export function bestBoundedTokenTrigramSimilarity(
	message: string,
	probe: string,
	policy: TrigramSearchPolicy,
): number {
	const queryValues = new Set([normalizeSearchText(probe)]);
	const queryMorph = normalizeMorphText(probe);
	if (queryMorph) queryValues.add(queryMorph);
	const tokens = normalizeSearchText(message).match(/[\p{L}\p{N}_-]+/gu) ?? [];
	let best = 0;
	for (const token of tokens) {
		const candidateValues = new Set([token]);
		const morph = normalizeMorphText(token);
		if (morph) candidateValues.add(morph);
		for (const query of queryValues) {
			const expected = new Set(stringTrigrams(query));
			if (!expected.size) continue;
			for (const candidate of candidateValues) {
				if (
					boundedEditDistance(query, candidate, policy.maximumEditDistance) ===
					null
				) {
					continue;
				}
				const actual = new Set(stringTrigrams(candidate));
				if (!actual.size) continue;
				let overlap = 0;
				for (const trigram of expected) {
					if (actual.has(trigram)) overlap += 1;
				}
				best = Math.max(best, (2 * overlap) / (expected.size + actual.size));
			}
		}
	}
	return best;
}

function boundedEditDistance(
	leftValue: string,
	rightValue: string,
	maximum: number,
): number | null {
	const left = Array.from(normalizeSearchText(leftValue));
	const right = Array.from(normalizeSearchText(rightValue));
	if (Math.abs(left.length - right.length) > maximum) return null;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex];
		let rowMinimum = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const value = Math.min(
				(previous[rightIndex] ?? maximum + 1) + 1,
				(current[rightIndex - 1] ?? maximum + 1) + 1,
				(previous[rightIndex - 1] ?? maximum + 1) +
					(left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			current.push(value);
			rowMinimum = Math.min(rowMinimum, value);
		}
		if (rowMinimum > maximum) return null;
		previous = current;
	}
	const distance = previous[right.length] ?? maximum + 1;
	return distance <= maximum ? distance : null;
}

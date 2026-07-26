/**
 * Labelled evaluation for the `open_question` signal.
 *
 * The retrieval benchmark measures whether the right threads come back; this
 * measures whether the right *posts inside them* are reported as unresolved.
 * Both are needed before touching cue weights or gates: the cue firing report
 * (`bun run cues`) says which cue decides an outcome, and this says whether the
 * outcome was correct.
 *
 * Fixture text is synthetic, and the labels are editorial judgements about what
 * an agent should be told is open. Treat a score as a comparison between two
 * versions of the code, never as an absolute quality number.
 */
import { z } from "zod";
import type { EvidencePost } from "../evidence/packing.ts";
import { buildThreadBrief } from "../evidence/signals.ts";

const casePostSchema = z.object({
	id: z.string().trim().min(1),
	author: z.string().trim().min(1),
	message: z.string(),
});

const caseSchema = z.object({
	id: z.string().trim().min(1),
	note: z.string().trim().min(1),
	subjectTicket: z.string().trim().min(1).optional(),
	posts: z.array(casePostSchema).min(1),
	/** Post ids that should appear in `brief.openQuestions`. */
	expectedOpenQuestions: z.array(z.string().trim().min(1)),
	/** Whether an `open_question` purpose hint should be emitted. */
	expectPurposeHint: z.boolean(),
});

const fixtureSchema = z.object({
	schemaVersion: z.literal(1),
	name: z.string().trim().min(1),
	description: z.string().trim().min(1),
	cases: z.array(caseSchema).min(1),
});

export type QuestionCorpusCase = z.output<typeof caseSchema>;
export type QuestionCorpusFixture = z.output<typeof fixtureSchema>;

export async function loadQuestionCorpus(
	path: string,
): Promise<QuestionCorpusFixture> {
	const fixture = fixtureSchema.parse(await Bun.file(path).json());
	const ids = new Set<string>();
	for (const entry of fixture.cases) {
		if (ids.has(entry.id)) {
			throw new Error(`Duplicate case id ${entry.id}.`);
		}
		ids.add(entry.id);
		const postIds = new Set(entry.posts.map((post) => post.id));
		for (const expected of entry.expectedOpenQuestions) {
			if (!postIds.has(expected)) {
				throw new Error(
					`Case ${entry.id} expects unknown post id ${expected}.`,
				);
			}
		}
	}
	return fixture;
}

/** Positional timestamps keep the fixture terse and the ordering explicit. */
function toEvidencePosts(entry: QuestionCorpusCase): EvidencePost[] {
	return entry.posts.map((post, index) => ({
		id: post.id,
		rootId: entry.posts[0]?.id ?? post.id,
		userId: `user-${post.author}`,
		authorUsername: post.author,
		authorDisplayName: post.author,
		createAt: (index + 1) * 1000,
		updateAt: (index + 1) * 1000,
		deleteAt: 0,
		message: post.message,
		attachments: [],
	}));
}

export interface QuestionCaseResult {
	id: string;
	note: string;
	/** Expected open-question post ids that were reported. */
	truePositives: string[];
	/** Reported open-question post ids that were not expected. */
	falsePositives: string[];
	/** Expected open-question post ids that were not reported. */
	falseNegatives: string[];
	expectPurposeHint: boolean;
	actualPurposeHint: boolean;
	purposeHintCorrect: boolean;
	/** Cues behind each reported question, for reading a regression quickly. */
	reportedCues: Record<string, string[]>;
	passed: boolean;
}

export interface QuestionCorpusReport {
	name: string;
	cases: QuestionCaseResult[];
	questions: {
		truePositives: number;
		falsePositives: number;
		falseNegatives: number;
		precision: number | null;
		recall: number | null;
		f1: number | null;
	};
	purposeHints: {
		correct: number;
		total: number;
		falsePositives: number;
		falseNegatives: number;
		accuracy: number;
	};
	casesPassed: number;
	casesTotal: number;
}

function ratio(numerator: number, denominator: number): number | null {
	if (denominator <= 0) return null;
	return Math.round((numerator / denominator) * 1000) / 1000;
}

export function runQuestionCorpus(
	fixture: QuestionCorpusFixture,
): QuestionCorpusReport {
	const cases: QuestionCaseResult[] = [];
	let truePositives = 0;
	let falsePositives = 0;
	let falseNegatives = 0;
	let hintCorrect = 0;
	let hintFalsePositives = 0;
	let hintFalseNegatives = 0;

	for (const entry of fixture.cases) {
		const brief = buildThreadBrief(toEvidencePosts(entry), {
			...(entry.subjectTicket ? { subjectTicket: entry.subjectTicket } : {}),
		});
		const reported = brief.openQuestions ?? [];
		const reportedIds = new Set(reported.map((question) => question.postId));
		const expected = new Set(entry.expectedOpenQuestions);

		const casePositives = [...expected].filter((id) => reportedIds.has(id));
		const caseFalsePositives = [...reportedIds].filter(
			(id) => !expected.has(id),
		);
		const caseFalseNegatives = [...expected].filter(
			(id) => !reportedIds.has(id),
		);
		truePositives += casePositives.length;
		falsePositives += caseFalsePositives.length;
		falseNegatives += caseFalseNegatives.length;

		const actualPurposeHint = brief.purposeHints.some(
			(hint) => hint.label === "open_question",
		);
		const purposeHintCorrect = actualPurposeHint === entry.expectPurposeHint;
		if (purposeHintCorrect) hintCorrect += 1;
		else if (actualPurposeHint) hintFalsePositives += 1;
		else hintFalseNegatives += 1;

		cases.push({
			id: entry.id,
			note: entry.note,
			truePositives: casePositives,
			falsePositives: caseFalsePositives,
			falseNegatives: caseFalseNegatives,
			expectPurposeHint: entry.expectPurposeHint,
			actualPurposeHint,
			purposeHintCorrect,
			reportedCues: Object.fromEntries(
				reported.map((question) => [question.postId, [...question.cues]]),
			),
			passed:
				caseFalsePositives.length === 0 &&
				caseFalseNegatives.length === 0 &&
				purposeHintCorrect,
		});
	}

	const precision = ratio(truePositives, truePositives + falsePositives);
	const recall = ratio(truePositives, truePositives + falseNegatives);
	const f1 =
		precision !== null && recall !== null && precision + recall > 0
			? Math.round(((2 * precision * recall) / (precision + recall)) * 1000) /
				1000
			: null;

	return {
		name: fixture.name,
		cases,
		questions: {
			truePositives,
			falsePositives,
			falseNegatives,
			precision,
			recall,
			f1,
		},
		purposeHints: {
			correct: hintCorrect,
			total: fixture.cases.length,
			falsePositives: hintFalsePositives,
			falseNegatives: hintFalseNegatives,
			accuracy: Math.round((hintCorrect / fixture.cases.length) * 1000) / 1000,
		},
		casesPassed: cases.filter((entry) => entry.passed).length,
		casesTotal: cases.length,
	};
}

export function formatQuestionCorpusReport(
	report: QuestionCorpusReport,
): string {
	const lines: string[] = [];
	const { questions, purposeHints } = report;
	lines.push(`${report.name}`);
	lines.push(`cases passed:      ${report.casesPassed}/${report.casesTotal}`);
	lines.push(
		`open questions:    precision=${questions.precision ?? "-"} recall=${questions.recall ?? "-"} f1=${questions.f1 ?? "-"}`,
	);
	lines.push(
		`                   tp=${questions.truePositives} fp=${questions.falsePositives} fn=${questions.falseNegatives}`,
	);
	lines.push(
		`purpose hint:      accuracy=${purposeHints.accuracy} (fp=${purposeHints.falsePositives} fn=${purposeHints.falseNegatives})`,
	);
	const failures = report.cases.filter((entry) => !entry.passed);
	if (failures.length) {
		lines.push("");
		lines.push("failures:");
		for (const failure of failures) {
			lines.push(`  ${failure.id}`);
			lines.push(`    ${failure.note}`);
			if (failure.falsePositives.length) {
				const detail = failure.falsePositives
					.map(
						(id) =>
							`${id} (cues: ${failure.reportedCues[id]?.join(", ") ?? ""})`,
					)
					.join("; ");
				lines.push(`    reported but not expected: ${detail}`);
			}
			if (failure.falseNegatives.length) {
				lines.push(
					`    expected but missing: ${failure.falseNegatives.join(", ")}`,
				);
			}
			if (!failure.purposeHintCorrect) {
				lines.push(
					`    purpose hint: expected ${failure.expectPurposeHint}, got ${failure.actualPurposeHint}`,
				);
			}
		}
	}
	return `${lines.join("\n")}\n`;
}

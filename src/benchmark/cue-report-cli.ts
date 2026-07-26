#!/usr/bin/env bun
/**
 * Per-cue firing report over the local index.
 *
 * Answers "does this cue earn its place" for the `signals.ts` tables: how often
 * each entry fires, how much of that firing survives the sentence guards, how
 * much reaches a packet, and how often the cue was the only evidence for its
 * signal. Read-only and offline — it never touches Mattermost.
 *
 *   bun run cues              # text table over the whole index
 *   bun run cues --json       # machine-readable report
 *   bun run cues --limit 500  # cap threads scanned
 */
import { loadMattermostConfig } from "../config/config.ts";
import {
	CueTelemetry,
	formatCueFiringReport,
} from "../evidence/cue-telemetry.ts";
import type { EvidencePost } from "../evidence/packing.ts";
import { buildThreadBrief, cueInventory } from "../evidence/signals.ts";
import type { IndexedPost } from "../store/index.ts";
import { MattermostStore } from "../store/index.ts";

interface CueReportArguments {
	json: boolean;
	limit?: number;
}

function parseArguments(argv: readonly string[]): CueReportArguments {
	const parsed: CueReportArguments = { json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") {
			parsed.json = true;
			continue;
		}
		if (argument === "--limit") {
			const value = Number(argv[index + 1]);
			if (!Number.isInteger(value) || value <= 0) {
				throw new Error("--limit requires a positive integer.");
			}
			parsed.limit = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument ${argument}. Accepts --json, --limit N.`);
	}
	return parsed;
}

/**
 * Signals read only `message`, `deleteAt`, `createAt`, `userId` and `id`; the
 * display fields are inert here, and attachments never carry cues. Filling them
 * from the store would cost a user join per thread for no effect on the counts.
 */
function toEvidencePost(post: IndexedPost): EvidencePost {
	return {
		id: post.id,
		rootId: post.rootId,
		userId: post.userId,
		authorUsername: post.userId,
		authorDisplayName: post.userId,
		createAt: post.createAt,
		updateAt: post.updateAt,
		deleteAt: post.deleteAt,
		message: post.message,
		attachments: [],
	};
}

const parsed = parseArguments(process.argv.slice(2));
const config = await loadMattermostConfig();
const store = await MattermostStore.open(config.databasePath);

try {
	const threadIds = store.database
		.query<{ thread_id: string }, [] | [number]>(
			parsed.limit === undefined
				? "SELECT DISTINCT thread_id FROM posts ORDER BY thread_id"
				: "SELECT DISTINCT thread_id FROM posts ORDER BY thread_id LIMIT ?",
		)
		.all(...(parsed.limit === undefined ? [] : ([parsed.limit] as [number])))
		.map((row) => row.thread_id);

	const telemetry = new CueTelemetry();
	for (const threadId of threadIds) {
		const posts = store.getThread(threadId).map(toEvidencePost);
		if (!posts.length) continue;
		// The brief path, not bare signals: it is the one that applies every cap
		// and confidence floor, so `survived` and `brief` mean what they say.
		buildThreadBrief(posts, { cueTelemetry: telemetry });
		telemetry.observe(posts.map((post) => post.id));
	}

	const report = telemetry.snapshot(cueInventory());
	process.stdout.write(
		parsed.json
			? `${JSON.stringify(report, null, 2)}\n`
			: formatCueFiringReport(report),
	);
} finally {
	store.close();
}

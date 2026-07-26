import { describe, expect, test } from "bun:test";
import { commandSuccess } from "../shared/command-result.ts";
import { agentStderrSummary, emitResult } from "./execute.ts";

describe("emitResult file --agent", () => {
	test("emits flattened schemaVersion-3 JSON, not the human one-liner", () => {
		const chunks: string[] = [];
		const stderr: string[] = [];
		emitResult(
			commandSuccess(
				"file",
				{
					id: "file-1",
					name: "trace.txt",
					mimeType: "text/plain",
					size: 4,
					path: "/tmp/mm-file-1-trace.txt",
					postId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
					conversationId: "channel-payments",
				},
				[],
			),
			false,
			false,
			true,
			{ write: (chunk) => chunks.push(String(chunk)) },
			{ write: (chunk) => stderr.push(String(chunk)) },
		);

		expect(stderr).toEqual([]);
		expect(chunks).toHaveLength(1);
		const document = JSON.parse(chunks[0] ?? "");
		expect(document).toEqual({
			command: "file",
			schemaVersion: 5,
			success: true,
			id: "file-1",
			name: "trace.txt",
			mimeType: "text/plain",
			size: 4,
			path: "/tmp/mm-file-1-trace.txt",
			postId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
			conversationId: "channel-payments",
			warnings: [],
		});
		expect(document.data).toBeUndefined();
		expect(chunks[0]).not.toContain("Downloaded");
	});
});

describe("agentStderrSummary", () => {
	test("surfaces mayMissReason and noActionAvailable", () => {
		const summary = agentStderrSummary(
			commandSuccess(
				"context",
				{
					evidence: {
						verdict: {
							canAnswerFromSelectedEvidence: true,
							mayHaveMissedOtherThreads: true,
							mayHaveMissedReason: "stale_discovery",
							selectedEvidenceMayBeStale: false,
							recommendedActionRequired: false,
							noActionAvailable: true,
							noActionReason: "discovery may be stale",
						},
						next: [],
					},
				},
				[],
			),
		);
		expect(summary).toContain("canAnswer");
		expect(summary).toContain("mayMiss=stale_discovery");
		expect(summary).toContain("noActionAvailable");
	});

	test("counts recommended next steps", () => {
		const summary = agentStderrSummary(
			commandSuccess(
				"context",
				{
					evidence: {
						verdict: {
							canAnswerFromSelectedEvidence: false,
							mayHaveMissedOtherThreads: false,
							selectedEvidenceMayBeStale: false,
							recommendedActionRequired: true,
						},
						next: [
							{ action: "read_attachments", priority: "recommended" },
							{ action: "fresh_or_remote", priority: "optional" },
						],
					},
				},
				[],
			),
		);
		expect(summary).toContain("cannotAnswer");
		expect(summary).toContain("recommended=1");
	});
});

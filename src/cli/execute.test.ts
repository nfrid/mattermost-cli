import { describe, expect, test } from "bun:test";
import { commandSuccess } from "../shared/command-result.ts";
import { emitResult } from "./execute.ts";

describe("emitResult file --agent", () => {
	test("emits flattened schemaVersion-2 JSON, not the human one-liner", () => {
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
			schemaVersion: 2,
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

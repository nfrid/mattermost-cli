import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION } from "../shared/command-result.ts";
import { createProgram } from "./program.ts";

describe("context --navigate", () => {
	test("accepts --navigate and rejects --navigate with --short", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const program = createProgram(async (command, _global, commandOptions) => {
			seen.push({ command, ...(commandOptions ?? {}) });
			return {
				command,
				schemaVersion: SCHEMA_VERSION,
				success: true,
				data: {},
				warnings: [],
			};
		});

		await program.parseAsync(["context", "BTB-1", "--navigate", "--agent"], {
			from: "user",
		});
		expect(seen.at(-1)?.navigate).toBe(true);
		expect(seen.at(-1)?.short).toBeUndefined();

		await expect(
			program.parseAsync(
				["context", "BTB-1", "--navigate", "--short", "--agent"],
				{ from: "user" },
			),
		).rejects.toThrow(/cannot be used|conflict|navigat|short/i);
	});
});

describe("context/thread --signals", () => {
	test("accepts --signals on context and thread", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const program = createProgram(async (command, _global, commandOptions) => {
			seen.push({ command, ...(commandOptions ?? {}) });
			return {
				command,
				schemaVersion: SCHEMA_VERSION,
				success: true,
				data: {},
				warnings: [],
			};
		});

		await program.parseAsync(["context", "BTB-1", "--signals", "--agent"], {
			from: "user",
		});
		expect(seen.at(-1)).toMatchObject({
			command: "context",
			signals: true,
		});

		await program.parseAsync(
			["thread", "aaaaaaaaaaaaaaaaaaaaaaaaaa", "--signals", "--agent"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "thread",
			signals: true,
			target: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
	});
});

describe("file command", () => {
	test("accepts file-id and optional --out with --agent", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const program = createProgram(async (command, global, commandOptions) => {
			seen.push({ command, ...global, ...(commandOptions ?? {}) });
			return {
				command,
				schemaVersion: SCHEMA_VERSION,
				success: true,
				data: {
					id: "file-1",
					name: "trace.txt",
					mimeType: "text/plain",
					size: 4,
					path: "/tmp/mm-file-1-trace.txt",
					postId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
					conversationId: "channel-payments",
				},
				warnings: [],
			};
		});

		await program.parseAsync(
			["file", "file-1", "--out", "/tmp/mm-file-1-trace.txt", "--agent"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "file",
			fileId: "file-1",
			out: "/tmp/mm-file-1-trace.txt",
			agent: true,
		});
	});
});

describe("files batch command", () => {
	test("requires --out-dir and accepts exclusive selectors", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const program = createProgram(async (command, _global, commandOptions) => {
			seen.push({ command, ...(commandOptions ?? {}) });
			return {
				command,
				schemaVersion: SCHEMA_VERSION,
				success: true,
				data: {},
				warnings: [],
			};
		});

		await expect(
			program.parseAsync(["files", "file-1"], { from: "user" }),
		).rejects.toThrow(/out-dir|required/i);

		await program.parseAsync(
			["files", "file-1", "file-2", "--out-dir", "/tmp/mm-out"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "files",
			outDir: "/tmp/mm-out",
			fileIds: ["file-1", "file-2"],
		});

		await program.parseAsync(
			["files", "--post", "post-1", "--out-dir", "/tmp/mm-out"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "files",
			postId: "post-1",
			outDir: "/tmp/mm-out",
		});

		await expect(
			program.parseAsync(
				[
					"files",
					"--post",
					"post-1",
					"--thread",
					"thread-1",
					"--out-dir",
					"/tmp/mm-out",
				],
				{ from: "user" },
			),
		).rejects.toThrow(/cannot be used|conflict/i);
	});
});

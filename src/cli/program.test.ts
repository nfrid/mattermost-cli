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

describe("context ticket --agent brief default flags", () => {
	test("accepts --full-posts and rejects it with exclusive projections", async () => {
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

		await program.parseAsync(["context", "BTB-1", "--full-posts", "--agent"], {
			from: "user",
		});
		expect(seen.at(-1)).toMatchObject({
			command: "context",
			subject: "BTB-1",
			fullPosts: true,
		});
		expect(seen.at(-1)?.brief).toBeUndefined();

		await program.parseAsync(["context", "BTB-1", "--brief", "--agent"], {
			from: "user",
		});
		expect(seen.at(-1)).toMatchObject({ brief: true });

		// Dense posts + decision brief is an intentional combination.
		await program.parseAsync(
			["context", "BTB-1", "--full-posts", "--brief", "--agent"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({ fullPosts: true, brief: true });

		for (const conflicting of ["--navigate", "--short"] as const) {
			await expect(
				program.parseAsync(
					["context", "BTB-1", "--full-posts", conflicting, "--agent"],
					{ from: "user" },
				),
			).rejects.toThrow(/cannot be used|conflict|full-posts|navigat|short/i);
		}
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

describe("thread --window-only", () => {
	test("accepts a bounded range and conflicts with --full", async () => {
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

		await program.parseAsync(
			[
				"thread",
				"aaaaaaaaaaaaaaaaaaaaaaaaaa",
				"--around",
				"bbbbbbbbbbbbbbbbbbbbbbbbbb",
				"--window-only",
			],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({ windowOnly: true });
		await expect(
			program.parseAsync(
				[
					"thread",
					"aaaaaaaaaaaaaaaaaaaaaaaaaa",
					"--around",
					"bbbbbbbbbbbbbbbbbbbbbbbbbb",
					"--window-only",
					"--full",
				],
				{ from: "user" },
			),
		).rejects.toThrow(/cannot be used|conflict|full|window/i);
	});
});

describe("context budget overrides", () => {
	test("accepts --max-threads and character budget flags", async () => {
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

		await program.parseAsync(
			[
				"context",
				"BTB-1",
				"--agent",
				"--max-threads",
				"5",
				"--max-characters",
				"20000",
				"--per-thread-characters",
				"8000",
			],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "context",
			subject: "BTB-1",
			maxThreads: 5,
			maxCharacters: 20_000,
			perThreadCharacters: 8_000,
		});
	});
});

describe("file command", () => {
	test("accepts file-id, --out, and bounded --inspect with --agent", async () => {
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
			[
				"file",
				"file-1",
				"--out",
				"/tmp/mm-file-1-trace.txt",
				"--inspect",
				"--preview-lines",
				"5",
				"--agent",
			],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "file",
			fileId: "file-1",
			out: "/tmp/mm-file-1-trace.txt",
			inspect: true,
			previewLines: 5,
			agent: true,
		});
	});

	test("accepts --out-dir and rejects it together with --out", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const program = createProgram(async (command, global, commandOptions) => {
			seen.push({ command, ...global, ...(commandOptions ?? {}) });
			return {
				command,
				schemaVersion: SCHEMA_VERSION,
				success: true,
				data: {},
				warnings: [],
			};
		});

		await program.parseAsync(
			["file", "file-1", "--out-dir", "/tmp/mm-out", "--agent"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "file",
			fileId: "file-1",
			outDir: "/tmp/mm-out",
		});
		expect(seen.at(-1)?.out).toBeUndefined();

		await expect(
			program.parseAsync(
				[
					"file",
					"file-1",
					"--out",
					"/tmp/mm-file-1-trace.txt",
					"--out-dir",
					"/tmp/mm-out",
				],
				{ from: "user" },
			),
		).rejects.toThrow(/cannot be used|conflict|out-dir/i);
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

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../shared/errors.ts";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import { downloadMattermostFile, sanitizeFileName } from "./file-download.ts";

const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILE_ID = "file-1";

describe("file download", () => {
	test("downloads and inspects allowlisted file contents", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-file-"));
		const out = join(outDir, "trace.txt");
		const bytes = new TextEncoder().encode("attachment-bytes");
		const result = await downloadMattermostFile(
			{ fileId: FILE_ID, out, inspect: true },
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("should use local metadata");
					},
					downloadFile: async (fileId) => {
						expect(fileId).toBe(FILE_ID);
						return bytes;
					},
				},
			},
		);
		expect(result.path).toBe(out);
		expect(result.id).toBe(FILE_ID);
		expect(result.name).toBe("trace.txt");
		expect(result.inspection).toMatchObject({
			status: "preview",
			decoded: true,
			syntaxValidated: false,
			preview: "attachment-bytes",
		});
		expect(await readFile(out, "utf8")).toBe("attachment-bytes");
		store.close();
		await rm(outDir, { recursive: true, force: true });
	});

	test("overwrites an existing file at --out", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-file-"));
		const out = join(outDir, "trace.txt");
		await writeFile(out, "stale");
		const result = await downloadMattermostFile(
			{ fileId: FILE_ID, out },
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("should use local metadata");
					},
					downloadFile: async () => new TextEncoder().encode("fresh-bytes"),
				},
			},
		);
		expect(result.path).toBe(out);
		expect(await readFile(out, "utf8")).toBe("fresh-bytes");
		store.close();
		await rm(outDir, { recursive: true, force: true });
	});

	test("names the file under --out-dir like the batch path", async () => {
		const store = await seededStore();
		const parent = await mkdtemp(join(tmpdir(), "mm-file-"));
		const outDir = join(parent, "nested", "attachments");
		const result = await downloadMattermostFile(
			{ fileId: FILE_ID, outDir },
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("should use local metadata");
					},
					downloadFile: async () =>
						new TextEncoder().encode("attachment-bytes"),
				},
			},
		);
		expect(result.path).toBe(join(outDir, "trace.txt"));
		expect(await readFile(result.path, "utf8")).toBe("attachment-bytes");
		store.close();
		await rm(parent, { recursive: true, force: true });
	});

	test("refuses to overwrite an existing file under --out-dir", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-file-"));
		const existing = join(outDir, "trace.txt");
		await writeFile(existing, "keep-me");
		let downloads = 0;
		const error = await downloadMattermostFile(
			{ fileId: FILE_ID, outDir },
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("should use local metadata");
					},
					downloadFile: async () => {
						downloads += 1;
						return new TextEncoder().encode("attachment-bytes");
					},
				},
			},
		).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).kind).toBe("file_exists");
		expect((error as ConfigError).message).toContain(existing);
		expect(downloads).toBe(0);
		expect(await readFile(existing, "utf8")).toBe("keep-me");
		store.close();
		await rm(outDir, { recursive: true, force: true });
	});

	test("rejects --out and --out-dir together", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-file-"));
		await expect(
			downloadMattermostFile(
				{ fileId: FILE_ID, out: join(outDir, "trace.txt"), outDir },
				{
					config: configFixture(),
					store,
					client: {
						getFileInfo: async () => {
							throw new Error("should use local metadata");
						},
						downloadFile: async () => new Uint8Array(),
					},
				},
			),
		).rejects.toMatchObject({ kind: "conflicting_out_target" });
		store.close();
		await rm(outDir, { recursive: true, force: true });
	});

	test("refuses files outside the configured conversation allowlist", async () => {
		const store = await seededStore({ conversationId: "channel-other" });
		await expect(
			downloadMattermostFile(
				{ fileId: FILE_ID, out: join(tmpdir(), "denied.txt") },
				{
					config: configFixture(),
					store,
					client: {
						getFileInfo: async () => {
							throw new Error("unused");
						},
						downloadFile: async () => new Uint8Array(),
					},
				},
			),
		).rejects.toBeInstanceOf(ConfigError);
		store.close();
	});

	test("sanitizes download filenames", () => {
		expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
		expect(sanitizeFileName("ok name.png")).toBe("ok name.png");
	});
});

async function seededStore(
	options: { conversationId?: string } = {},
): Promise<MattermostStore> {
	const conversationId = options.conversationId ?? "channel-payments";
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture("payments", conversationId),
		users: [userFixture()],
		files: [
			{
				id: FILE_ID,
				user_id: "user-1",
				post_id: REPLY,
				create_at: 20,
				update_at: 20,
				delete_at: 0,
				name: "trace.txt",
				extension: "txt",
				size: 16,
				mime_type: "text/plain",
			},
		],
		posts: [
			postFixture({
				id: ROOT,
				channel_id: conversationId,
				message: "root",
				create_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: conversationId,
				message: "reply",
				file_ids: [FILE_ID],
				create_at: 20,
			}),
		],
		checkpoint: {
			conversationId,
			newestPostId: REPLY,
			newestPostAt: 20,
			oldestCoveredAt: 10,
			lastSuccessAt: 1_000,
			coverageComplete: true,
		},
	});
	return store;
}

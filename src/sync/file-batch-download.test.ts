import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MattermostStore } from "../store/index.ts";
import {
	configFixture,
	conversationFixture,
	postFixture,
	userFixture,
} from "../test-fixtures.ts";
import {
	DEFAULT_MAX_BATCH_FILES,
	DEFAULT_MAX_BATCH_TOTAL_BYTES,
	downloadMattermostFiles,
	safeJoinUnderOutDir,
} from "./file-batch-download.ts";

const ROOT = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const FILE_A = "file-a";
const FILE_B = "file-b";
const FILE_C = "file-c";

describe("file batch download", () => {
	test("downloads file ids into out-dir without printing bytes", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-files-"));
		const result = await downloadMattermostFiles(
			{
				selector: { kind: "file_ids", fileIds: [FILE_A, FILE_B] },
				outDir,
			},
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("should use local metadata");
					},
					downloadFile: async (fileId) => {
						return new TextEncoder().encode(`bytes-for-${fileId}`);
					},
				},
			},
		);

		expect(result.downloaded).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.limits.maxFiles).toBe(DEFAULT_MAX_BATCH_FILES);
		expect(result.limits.maxTotalBytes).toBe(DEFAULT_MAX_BATCH_TOTAL_BYTES);
		expect(await readFile(join(outDir, "trace-a.txt"), "utf8")).toBe(
			`bytes-for-${FILE_A}`,
		);
		expect(await readFile(join(outDir, "trace-b.txt"), "utf8")).toBe(
			`bytes-for-${FILE_B}`,
		);
		expect(JSON.stringify(result)).not.toContain(`bytes-for-${FILE_A}`);

		store.close();
		await rm(outDir, { recursive: true, force: true });
	});

	test("resolves --post and --thread selectors from the local index", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-files-post-"));
		const postResult = await downloadMattermostFiles(
			{ selector: { kind: "post", postId: REPLY }, outDir },
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("unused");
					},
					downloadFile: async (fileId) => new TextEncoder().encode(fileId),
				},
			},
		);
		expect(postResult.downloaded).toBe(2);
		expect(postResult.files.map((file) => file.id).sort()).toEqual([
			FILE_A,
			FILE_B,
		]);

		const threadDir = await mkdtemp(join(tmpdir(), "mm-files-thread-"));
		const threadResult = await downloadMattermostFiles(
			{ selector: { kind: "thread", threadId: ROOT }, outDir: threadDir },
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("unused");
					},
					downloadFile: async (fileId) => new TextEncoder().encode(fileId),
				},
			},
		);
		expect(threadResult.downloaded).toBe(3);
		expect(threadResult.files.map((file) => file.id).sort()).toEqual([
			FILE_A,
			FILE_B,
			FILE_C,
		]);

		store.close();
		await rm(outDir, { recursive: true, force: true });
		await rm(threadDir, { recursive: true, force: true });
	});

	test("skips existing paths and reports partial success", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-files-skip-"));
		await writeFile(join(outDir, "trace-a.txt"), "already-there");

		const result = await downloadMattermostFiles(
			{
				selector: { kind: "file_ids", fileIds: [FILE_A, FILE_B] },
				outDir,
			},
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("unused");
					},
					downloadFile: async (fileId) =>
						new TextEncoder().encode(`new-${fileId}`),
				},
			},
		);

		expect(result.downloaded).toBe(1);
		expect(result.skipped).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.files[0]).toMatchObject({
			status: "skipped",
			id: FILE_A,
			error: { kind: "file_exists" },
		});
		expect(result.files[1]).toMatchObject({
			status: "downloaded",
			id: FILE_B,
		});
		expect(await readFile(join(outDir, "trace-a.txt"), "utf8")).toBe(
			"already-there",
		);

		store.close();
		await rm(outDir, { recursive: true, force: true });
	});

	test("continues after per-file errors and enforces count limit", async () => {
		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-files-err-"));

		const partial = await downloadMattermostFiles(
			{
				selector: { kind: "file_ids", fileIds: [FILE_A, FILE_B] },
				outDir,
			},
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("unused");
					},
					downloadFile: async (fileId) => {
						if (fileId === FILE_A) throw new Error("network boom");
						return new TextEncoder().encode("ok");
					},
				},
			},
		);
		expect(partial.downloaded).toBe(1);
		expect(partial.failed).toBe(1);
		expect(partial.files[0]).toMatchObject({
			status: "error",
			id: FILE_A,
			error: { message: "network boom" },
		});

		await expect(
			downloadMattermostFiles(
				{
					selector: {
						kind: "file_ids",
						fileIds: [FILE_A, FILE_B, FILE_C],
					},
					outDir: await mkdtemp(join(tmpdir(), "mm-files-limit-")),
					maxFiles: 2,
				},
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
		).rejects.toMatchObject({
			kind: "batch_file_count_exceeded",
		});

		store.close();
		await rm(outDir, { recursive: true, force: true });
	});

	test("keeps destinations under out-dir and enforces total size limit", async () => {
		expect(safeJoinUnderOutDir("/tmp/out", "../etc/passwd")).toBe(
			"/tmp/out/_etc_passwd",
		);
		expect(safeJoinUnderOutDir("/tmp/out", "ok name.png")).toBe(
			"/tmp/out/ok name.png",
		);

		const store = await seededStore();
		const outDir = await mkdtemp(join(tmpdir(), "mm-files-size-"));
		const result = await downloadMattermostFiles(
			{
				selector: { kind: "file_ids", fileIds: [FILE_A, FILE_B] },
				outDir,
				maxTotalBytes: 16,
			},
			{
				config: configFixture(),
				store,
				client: {
					getFileInfo: async () => {
						throw new Error("unused");
					},
					downloadFile: async () =>
						new TextEncoder().encode("0123456789ABCDEF"),
				},
			},
		);
		expect(result.downloaded).toBe(1);
		expect(result.skipped).toBe(1);
		expect(result.files[1]).toMatchObject({
			status: "skipped",
			error: { kind: "batch_total_size_exceeded" },
		});

		store.close();
		await rm(outDir, { recursive: true, force: true });
	});
});

async function seededStore(): Promise<MattermostStore> {
	const conversationId = "channel-payments";
	const store = await MattermostStore.open(":memory:");
	store.writePage({
		conversation: conversationFixture("payments", conversationId),
		users: [userFixture()],
		files: [
			{
				id: FILE_A,
				user_id: "user-1",
				post_id: REPLY,
				create_at: 20,
				update_at: 20,
				delete_at: 0,
				name: "trace-a.txt",
				extension: "txt",
				size: 16,
				mime_type: "text/plain",
			},
			{
				id: FILE_B,
				user_id: "user-1",
				post_id: REPLY,
				create_at: 21,
				update_at: 21,
				delete_at: 0,
				name: "trace-b.txt",
				extension: "txt",
				size: 16,
				mime_type: "text/plain",
			},
			{
				id: FILE_C,
				user_id: "user-1",
				post_id: ROOT,
				create_at: 10,
				update_at: 10,
				delete_at: 0,
				name: "root.png",
				extension: "png",
				size: 8,
				mime_type: "image/png",
			},
		],
		posts: [
			postFixture({
				id: ROOT,
				channel_id: conversationId,
				message: "root",
				file_ids: [FILE_C],
				create_at: 10,
			}),
			postFixture({
				id: REPLY,
				root_id: ROOT,
				channel_id: conversationId,
				message: "reply",
				file_ids: [FILE_A, FILE_B],
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

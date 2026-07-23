import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./lock.ts";
import {
	FRESHEN_LOCK_STALE_MS,
	FRESHEN_LOCK_TIMEOUT_MS,
} from "./runtime-limits.ts";

describe("withFileLock", () => {
	test("runs the critical section when the lock is free", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mm-lock-"));
		const lockPath = join(directory, "test.lock");
		try {
			const result = await withFileLock(lockPath, async () => "ok", {
				timeoutMs: FRESHEN_LOCK_TIMEOUT_MS,
				staleMs: FRESHEN_LOCK_STALE_MS,
			});
			expect(result).toEqual({ acquired: true, value: "ok" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("returns acquired false when the lock is held past timeout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mm-lock-"));
		const lockPath = join(directory, "test.lock");
		try {
			const holder = withFileLock(
				lockPath,
				async () => {
					await Bun.sleep(200);
					return "held";
				},
				{
					timeoutMs: FRESHEN_LOCK_TIMEOUT_MS,
					staleMs: FRESHEN_LOCK_STALE_MS,
				},
			);
			await Bun.sleep(20);
			const blocked = await withFileLock(
				lockPath,
				async () => "should-not-run",
				{ timeoutMs: 50, staleMs: FRESHEN_LOCK_STALE_MS, pollMs: 10 },
			);
			expect(blocked).toEqual({ acquired: false });
			expect(await holder).toEqual({ acquired: true, value: "held" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

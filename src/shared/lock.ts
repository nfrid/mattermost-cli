import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface FileLockOptions {
	timeoutMs: number;
	staleMs: number;
	pollMs?: number;
}

type FileLockResult<T> = { acquired: true; value: T } | { acquired: false };

/** Exclusive create lockfile around a critical section (freshen/sync). */
export async function withFileLock<T>(
	lockPath: string,
	action: () => Promise<T>,
	options: FileLockOptions,
): Promise<FileLockResult<T>> {
	const { timeoutMs, staleMs } = options;
	const pollMs = options.pollMs ?? 50;
	const started = Date.now();
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }).catch(
		() => undefined,
	);

	while (Date.now() - started < timeoutMs) {
		try {
			const handle = await open(lockPath, "wx");
			try {
				await handle.write(
					Buffer.from(
						JSON.stringify({ pid: process.pid, at: Date.now() }),
						"utf8",
					),
				);
			} finally {
				await handle.close();
			}
			try {
				return { acquired: true, value: await action() };
			} finally {
				await unlink(lockPath).catch(() => undefined);
			}
		} catch (error) {
			if (!isExistError(error)) throw error;
			if (await isStaleLock(lockPath, staleMs)) {
				await unlink(lockPath).catch(() => undefined);
				continue;
			}
			await Bun.sleep(pollMs);
		}
	}
	return { acquired: false };
}

export function freshenLockPath(databasePath: string): string | null {
	if (databasePath === ":memory:") return null;
	return `${databasePath}.freshen.lock`;
}

async function isStaleLock(
	lockPath: string,
	staleMs: number,
): Promise<boolean> {
	try {
		const raw = await readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw) as { at?: number };
		return typeof parsed.at === "number" && Date.now() - parsed.at > staleMs;
	} catch {
		return true;
	}
}

function isExistError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code: unknown }).code === "EEXIST",
	);
}

/** SQLite waits this long for a busy lock before failing a statement. */
export const SQLITE_BUSY_TIMEOUT_MS = 20_000;

/** Soft wall-clock budget for local (+ automatic remote) search work. */
const SEARCH_DEADLINE_MS = 45_000;

/** How long a second process waits for freshen/sync single-flight. */
export const FRESHEN_LOCK_TIMEOUT_MS = 30_000;

/** Stale freshen lockfiles older than this may be stolen. */
export const FRESHEN_LOCK_STALE_MS = 120_000;

export function searchDeadlineAt(now = Date.now()): number {
	return now + SEARCH_DEADLINE_MS;
}

export function deadlineReached(
	deadlineAt: number | undefined,
	now = Date.now(),
): boolean {
	return deadlineAt !== undefined && now >= deadlineAt;
}

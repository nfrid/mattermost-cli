const DEFAULT_READ_CONCURRENCY = 8;

export async function mapWithConcurrency<T, R>(
	values: readonly T[],
	operation: (value: T) => Promise<R>,
	concurrency = DEFAULT_READ_CONCURRENCY,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(Math.max(1, concurrency), values.length) },
		async () => {
			while (cursor < values.length) {
				const index = cursor;
				cursor += 1;
				const value = values[index];
				if (value !== undefined) results[index] = await operation(value);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

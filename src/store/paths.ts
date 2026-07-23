export function databaseFilePaths(path: string): string[] {
	return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
}

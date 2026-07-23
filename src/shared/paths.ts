import { isAbsolute, relative, resolve } from "node:path";
import { ConfigError } from "./errors.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

interface LocalPaths {
	projectRoot: string;
	configPath: string;
	databasePath: string;
}

export function resolveLocalPaths(
	env: Record<string, string | undefined> = Bun.env,
	options: {
		projectRoot?: string;
		configPath?: string;
		databasePath?: string;
	} = {},
): LocalPaths {
	const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
	const configPath = resolveFromRoot(
		options.configPath ?? env.MATTERMOST_CONFIG ?? ".mattermost/config.json",
		projectRoot,
	);
	const databasePath = resolveFromRoot(
		options.databasePath ??
			env.MATTERMOST_DATABASE ??
			".mattermost/mattermost.sqlite3",
		projectRoot,
	);
	assertRuntimePath(configPath, projectRoot, "configuration");
	assertRuntimePath(databasePath, projectRoot, "database");

	return { projectRoot, configPath, databasePath };
}

function resolveFromRoot(path: string, projectRoot: string): string {
	return isAbsolute(path) ? path : resolve(projectRoot, path);
}

function assertRuntimePath(
	path: string,
	projectRoot: string,
	kind: "configuration" | "database",
): void {
	const runtimeRoot = resolve(projectRoot, ".mattermost");
	const fromRuntimeRoot = relative(runtimeRoot, path);
	if (
		fromRuntimeRoot === "" ||
		(!fromRuntimeRoot.startsWith("..") && !isAbsolute(fromRuntimeRoot))
	) {
		return;
	}
	throw new ConfigError(
		`Mattermost ${kind} path must stay under ${runtimeRoot}.`,
		"runtime_path_outside_private_directory",
	);
}

export type ErrorSource =
	| "cli"
	| "config"
	| "database"
	| "mattermost"
	| "routing"
	| "sync";

export class AppError extends Error {
	constructor(
		message: string,
		readonly source: ErrorSource,
		readonly kind: string,
		readonly exitCode = 1,
		options?: ErrorOptions,
		readonly details?: Readonly<Record<string, unknown>>,
	) {
		super(message, options);
		this.name = "AppError";
	}
}

export class DatabaseError extends AppError {
	constructor(
		message: string,
		kind = "database_unavailable",
		options?: ErrorOptions,
	) {
		super(message, "database", kind, 1, options, {
			recommendedAction: recommendedActionFor(kind),
		});
		this.name = "DatabaseError";
	}
}

/** True when SQLite (or a wrapped DatabaseError) reports a busy/locked database. */
export function isSqliteBusyError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current; depth += 1) {
		if (current instanceof DatabaseError && current.kind === "database_busy") {
			return true;
		}
		if (
			current &&
			typeof current === "object" &&
			"code" in current &&
			(current as { code: unknown }).code === "SQLITE_BUSY"
		) {
			return true;
		}
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
}

function recommendedActionFor(kind: string): string {
	if (kind === "database_busy") {
		return "wait for other mm processes to finish and retry";
	}
	return "remove the disposable database and run mm sync";
}

export class ConfigError extends AppError {
	constructor(
		message: string,
		kind = "invalid_config",
		options?: ErrorOptions,
	) {
		super(message, "config", kind, 2, options);
		this.name = "ConfigError";
	}
}

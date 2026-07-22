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
			recommendedAction: "remove the disposable database and run mm sync",
		});
		this.name = "DatabaseError";
	}
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

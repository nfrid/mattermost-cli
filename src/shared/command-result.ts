import { CommanderError } from "commander";
import { AppError, type ErrorSource } from "./errors.ts";

export const SCHEMA_VERSION = 2 as const;

export interface Warning {
	kind: string;
	message: string;
}

export interface StableError {
	source: ErrorSource;
	kind: string;
	message: string;
	details?: Readonly<Record<string, unknown>>;
}

export type CommandResult<T> =
	| {
			command: string;
			schemaVersion: typeof SCHEMA_VERSION;
			success: true;
			data: T;
			warnings: Warning[];
	  }
	| {
			command: string;
			schemaVersion: typeof SCHEMA_VERSION;
			success: false;
			error: StableError;
			warnings: Warning[];
	  };

export function commandSuccess<T>(
	command: string,
	data: T,
	warnings: Warning[] = [],
): CommandResult<T> {
	return {
		command,
		schemaVersion: SCHEMA_VERSION,
		success: true,
		data,
		warnings,
	};
}

export function commandFailure(
	command: string,
	error: unknown,
	secrets: readonly (string | undefined)[] = [],
): CommandResult<never> {
	return {
		command,
		schemaVersion: SCHEMA_VERSION,
		success: false,
		error: stableError(error, secrets),
		warnings: [],
	};
}

export function stableError(
	error: unknown,
	secrets: readonly (string | undefined)[] = [],
): StableError {
	const redact = (value: string) => redactSecrets(value, secrets);
	if (error instanceof AppError) {
		return {
			source: error.source,
			kind: error.kind,
			message: redact(error.message),
			...(error.details
				? { details: redactDetails(error.details, secrets) }
				: {}),
		};
	}

	if (error instanceof CommanderError) {
		return {
			source: "cli",
			kind: error.code,
			message: redact(error.message),
		};
	}

	return {
		source: "cli",
		kind: "internal_error",
		message: redact(error instanceof Error ? error.message : String(error)),
	};
}

function redactDetails(
	details: Readonly<Record<string, unknown>>,
	secrets: readonly (string | undefined)[],
): Readonly<Record<string, unknown>> {
	return Object.fromEntries(
		Object.entries(details).map(([key, value]) => [
			key,
			redactUnknown(value, secrets),
		]),
	);
}

function redactUnknown(
	value: unknown,
	secrets: readonly (string | undefined)[],
): unknown {
	if (typeof value === "string") return redactSecrets(value, secrets);
	if (Array.isArray(value)) {
		return value.map((item) => redactUnknown(item, secrets));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				redactUnknown(item, secrets),
			]),
		);
	}
	return value;
}

function redactSecrets(
	value: string,
	secrets: readonly (string | undefined)[],
): string {
	return secrets.reduce<string>(
		(redacted, secret) =>
			secret ? redacted.replaceAll(secret, "[REDACTED]") : redacted,
		value,
	);
}

export function resultExitCode(result: CommandResult<unknown>): number {
	return result.success ? 0 : 1;
}

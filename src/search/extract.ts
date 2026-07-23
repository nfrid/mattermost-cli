import { normalizeSearchText } from "./text.ts";

export type EngineeringEntityKind =
	| "ticket"
	| "repository"
	| "pull_request"
	| "commit"
	| "url"
	| "permalink"
	| "file_path"
	| "package"
	| "symbol"
	| "error_code"
	| "username"
	| "service"
	| "attachment_filename";

export interface EngineeringEntity {
	kind: EngineeringEntityKind;
	value: string;
	normalizedValue: string;
}

const FILE_EXTENSION_PATTERN =
	/(?:^|[\s("'`])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|cpp|h|hpp|sql|ya?ml|json|toml|ini|conf|md))(?![\p{L}\p{N}_])/giu;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;
const TICKET_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/gi;
const COMMIT_PATTERN = /\b[0-9a-f]{7,40}\b/gi;
const PULL_REQUEST_PATTERN = /\b(?:PR|MR)\s*[#!](\d{1,7})\b/gi;
const PACKAGE_PATTERN =
	/(?:^|\s)(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|\s|[),.;:])/g;
const BACKTICK_SYMBOL_PATTERN = /`([A-Za-z_$][A-Za-z0-9_$.]{2,})`/g;
const CALL_SYMBOL_PATTERN = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g;
const ERROR_CODE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const USERNAME_PATTERN = /(?:^|\s)@([A-Za-z0-9._-]{2,64})\b/g;
const NAMED_RELATION_PATTERN =
	/(?:^|[\s(])(repo(?:sitory)?|репозитор(?:ий|ия)|service|сервис)\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9_./-]{1,100})/giu;

/** Unique tracker keys like `BTB-2080` / `TECHSUPP-109` (uppercase, sorted). */
export function extractTicketKeys(text: string): string[] {
	return [
		...new Set(
			(text.match(TICKET_PATTERN) ?? []).map((key) => key.toUpperCase()),
		),
	].sort((left, right) => left.localeCompare(right));
}

export function extractEngineeringEntities(text: string): EngineeringEntity[] {
	const entities: EngineeringEntity[] = [];
	const urls = text.match(URL_PATTERN) ?? [];
	for (const rawUrl of urls) {
		const value = trimTrailingPunctuation(rawUrl);
		addEntity(
			entities,
			/\/pl\/[a-z0-9]{26}(?:[/?#]|$)/i.test(value) ? "permalink" : "url",
			value,
		);
		try {
			const url = new URL(value);
			const path = url.pathname.split("/").filter(Boolean);
			if (/(?:github\.com|gitlab\.)/i.test(url.hostname) && path.length >= 2) {
				addEntity(entities, "repository", `${path[0]}/${path[1]}`);
			}
		} catch {
			// The URL itself remains useful even if URL parsing rejects it.
		}
	}
	for (const value of extractTicketKeys(text)) {
		addEntity(entities, "ticket", value);
	}
	for (const value of text.match(COMMIT_PATTERN) ?? []) {
		addEntity(entities, "commit", value);
	}
	for (const match of text.matchAll(PULL_REQUEST_PATTERN)) {
		addEntity(entities, "pull_request", match[0]);
	}
	for (const match of text.matchAll(FILE_EXTENSION_PATTERN)) {
		if (match[1]) addEntity(entities, "file_path", match[1]);
	}
	for (const match of text.matchAll(PACKAGE_PATTERN)) {
		if (match[1]) addEntity(entities, "package", match[1]);
	}
	for (const match of text.matchAll(BACKTICK_SYMBOL_PATTERN)) {
		if (match[1]) addEntity(entities, "symbol", match[1]);
	}
	for (const match of text.matchAll(CALL_SYMBOL_PATTERN)) {
		if (match[1]) addEntity(entities, "symbol", match[1]);
	}
	for (const value of text.match(ERROR_CODE_PATTERN) ?? []) {
		addEntity(entities, "error_code", value);
	}
	for (const match of text.matchAll(USERNAME_PATTERN)) {
		if (match[1]) addEntity(entities, "username", match[1]);
	}
	for (const match of text.matchAll(NAMED_RELATION_PATTERN)) {
		const label = normalizeSearchText(match[1] ?? "");
		const value = match[2];
		if (!value) continue;
		addEntity(
			entities,
			label.startsWith("repo") || label.startsWith("репозитор")
				? "repository"
				: "service",
			value,
		);
	}
	return [
		...new Map(
			entities.map((entity) => [
				`${entity.kind}\0${entity.normalizedValue}`,
				entity,
			]),
		).values(),
	].sort(
		(left, right) =>
			left.kind.localeCompare(right.kind) ||
			left.normalizedValue.localeCompare(right.normalizedValue),
	);
}

function addEntity(
	entities: EngineeringEntity[],
	kind: EngineeringEntityKind,
	value: string,
): void {
	const normalizedValue = normalizeSearchText(value.trim());
	if (!normalizedValue) return;
	entities.push({ kind, value: value.trim(), normalizedValue });
}

function trimTrailingPunctuation(value: string): string {
	return value.replace(/[.,;:!?\])}]+$/g, "");
}

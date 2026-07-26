import type { ImageTextExtractor } from "./image-text.ts";
import { shouldUseMacosVisionOcr } from "./macos-ocr.ts";
import { previewXlsxWorkbook } from "./xlsx-preview.ts";

export type FileInspection =
	| {
			status: "preview";
			format: "text" | "csv" | "json" | "xml" | "spreadsheet";
			decoded: true;
			/** Classification only; syntax/rows are not validated or parsed. */
			syntaxValidated: false;
			preview: string;
			bytesExamined: number;
			lines: number;
			/** Best-effort header-based detection; not an anonymization guarantee. */
			sensitiveFieldsDetected?: string[];
			redactionApplied?: true;
			truncated?: true;
			/** Bytes were written locally and a textual preview was produced. */
			downloaded?: true;
			inspected?: true;
			/** Present for workbook previews. */
			sheets?: string[];
			activeSheet?: string;
			headers?: string[];
			rowCount?: number;
	  }
	| {
			status: "text_extracted";
			format: "image";
			/** OCR / external extractor output — never treat as high-trust evidence. */
			trust: "low";
			source: "ocr";
			text: string;
			downloaded: true;
			inspected: true;
			engine?: string;
			truncated?: true;
	  }
	| {
			status: "not_interpreted";
			format: "image" | "spreadsheet" | "binary";
			interpreted: false;
			/** Bytes were written locally; contents were not read as evidence. */
			downloaded: true;
			/** mm did not produce a textual inspection of the file body. */
			inspected: false;
			reason:
				| "external_image_reader_required"
				| "external_spreadsheet_parser_required"
				| "unsupported_binary_format";
			recommendedAction: string;
	  };

const MAX_INSPECT_BYTES = 64 * 1024;
const MAX_PREVIEW_CHARACTERS = 8_000;
const DEFAULT_PREVIEW_LINES = 10;
export const MAX_PREVIEW_LINES = 40;

const TEXT_EXTENSIONS = new Set([
	"csv",
	"tsv",
	"txt",
	"log",
	"json",
	"ndjson",
	"xml",
	"sql",
	"md",
	"yaml",
	"yml",
]);
/** Binary workbook formats mm still does not parse (OLE / ODF). */
const LEGACY_SPREADSHEET_EXTENSIONS = new Set(["xls", "ods"]);
const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"svg",
]);

/**
 * Optional image-text extractor. Callers may pass a hook, or
 * {@link loadConfiguredOcrExtractor} loads `MATTERMOST_OCR_MODULE` or the
 * built-in macOS Vision backend. Returned text is always tagged `trust: "low"`.
 */
export type { ImageTextExtractor } from "./image-text.ts";

/**
 * Inspect only bounded, directly decodable text (and bounded XLSX sheet
 * previews). Binary formats stay explicit unless an opt-in image extractor
 * returns text. Async only because OCR hooks may be async; the default path
 * does not await network or subprocesses.
 */
export async function inspectDownloadedFile(input: {
	name: string;
	mimeType: string;
	bytes: Uint8Array;
	previewLines?: number;
	extractImageText?: ImageTextExtractor;
}): Promise<FileInspection> {
	const extension = input.name.split(".").pop()?.toLowerCase() ?? "";
	if (
		IMAGE_EXTENSIONS.has(extension) ||
		input.mimeType.toLowerCase().startsWith("image/")
	) {
		return await inspectImage(input);
	}
	if (extension === "xlsx") {
		return inspectXlsx(input);
	}
	if (LEGACY_SPREADSHEET_EXTENSIONS.has(extension)) {
		return {
			status: "not_interpreted",
			format: "spreadsheet",
			interpreted: false,
			downloaded: true,
			inspected: false,
			reason: "external_spreadsheet_parser_required",
			recommendedAction:
				"open the downloaded path with a spreadsheet parser; mm only previews OOXML .xlsx workbooks",
		};
	}
	const textLike =
		TEXT_EXTENSIONS.has(extension) ||
		input.mimeType.toLowerCase().startsWith("text/") ||
		["application/json", "application/xml"].includes(
			input.mimeType.toLowerCase(),
		);
	if (!textLike) {
		return {
			status: "not_interpreted",
			format: "binary",
			interpreted: false,
			downloaded: true,
			inspected: false,
			reason: "unsupported_binary_format",
			recommendedAction:
				"open the downloaded path with a parser appropriate for its MIME type",
		};
	}

	const examined = input.bytes.subarray(
		0,
		Math.min(input.bytes.byteLength, MAX_INSPECT_BYTES),
	);
	if (examined.includes(0)) {
		return {
			status: "not_interpreted",
			format: "binary",
			interpreted: false,
			downloaded: true,
			inspected: false,
			reason: "unsupported_binary_format",
			recommendedAction:
				"the nominally textual file contains binary data; inspect the downloaded path with a format-specific parser",
		};
	}
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(examined, {
			// A byte cap may split one otherwise valid trailing code point. Streaming
			// mode withholds that incomplete tail instead of misclassifying the file.
			stream: input.bytes.byteLength > examined.byteLength,
		});
	} catch {
		return {
			status: "not_interpreted",
			format: "binary",
			interpreted: false,
			downloaded: true,
			inspected: false,
			reason: "unsupported_binary_format",
			recommendedAction:
				"the nominally textual file is not valid UTF-8; inspect the downloaded path with a format-specific parser",
		};
	}
	const previewLineLimit = Math.max(
		1,
		Math.min(
			MAX_PREVIEW_LINES,
			Math.floor(input.previewLines ?? DEFAULT_PREVIEW_LINES),
		),
	);
	const allLines = decoded.split(/\r\n|\r|\n/u);
	const selectedLines = allLines.slice(0, previewLineLimit);
	const table =
		extension === "csv" || extension === "tsv"
			? redactSensitiveTable(
					decoded,
					extension === "tsv" ? "\t" : ",",
					previewLineLimit,
				)
			: undefined;
	const lineBounded = (table?.records ?? selectedLines).join("\n");
	const characters = [...lineBounded];
	const preview = characters.slice(0, MAX_PREVIEW_CHARACTERS).join("");
	const truncated =
		input.bytes.byteLength > examined.byteLength ||
		(table ? table.truncated : allLines.length > previewLineLimit) ||
		characters.length > MAX_PREVIEW_CHARACTERS;
	return {
		status: "preview",
		format:
			extension === "csv" || extension === "tsv"
				? "csv"
				: extension === "json" || extension === "ndjson"
					? "json"
					: extension === "xml"
						? "xml"
						: "text",
		decoded: true,
		syntaxValidated: false,
		preview,
		bytesExamined: examined.byteLength,
		lines: table
			? table.records.length
			: Math.min(allLines.length, previewLineLimit),
		downloaded: true,
		inspected: true,
		...(table?.fields.length
			? {
					sensitiveFieldsDetected: table.fields,
					redactionApplied: true as const,
				}
			: {}),
		...(truncated ? { truncated: true as const } : {}),
	};
}

async function inspectImage(input: {
	name: string;
	mimeType: string;
	bytes: Uint8Array;
	extractImageText?: ImageTextExtractor;
}): Promise<FileInspection> {
	const notInterpreted = (): FileInspection => ({
		status: "not_interpreted",
		format: "image",
		interpreted: false,
		downloaded: true,
		inspected: false,
		reason: "external_image_reader_required",
		recommendedAction:
			"the local path is readable by an image-capable agent or tool; mm did not extract text (configure MATTERMOST_OCR_MODULE, or on macOS ensure Vision OCR is available)",
	});
	if (!input.extractImageText) return notInterpreted();
	try {
		const extracted = await input.extractImageText({
			name: input.name,
			mimeType: input.mimeType,
			bytes: input.bytes,
		});
		const text = extracted?.text?.trim();
		if (!text) return notInterpreted();
		const characters = [...text];
		const clipped = characters.slice(0, MAX_PREVIEW_CHARACTERS).join("");
		return {
			status: "text_extracted",
			format: "image",
			trust: "low",
			source: "ocr",
			text: clipped,
			downloaded: true,
			inspected: true,
			...(extracted?.engine ? { engine: extracted.engine } : {}),
			...(extracted?.truncated || characters.length > MAX_PREVIEW_CHARACTERS
				? { truncated: true as const }
				: {}),
		};
	} catch {
		return notInterpreted();
	}
}

function inspectXlsx(input: {
	name: string;
	mimeType: string;
	bytes: Uint8Array;
	previewLines?: number;
}): FileInspection {
	const previewLineLimit = Math.max(
		1,
		Math.min(
			MAX_PREVIEW_LINES,
			Math.floor(input.previewLines ?? DEFAULT_PREVIEW_LINES),
		),
	);
	const workbook = previewXlsxWorkbook(input.bytes, previewLineLimit);
	if (!workbook) {
		return {
			status: "not_interpreted",
			format: "spreadsheet",
			interpreted: false,
			downloaded: true,
			inspected: false,
			reason: "external_spreadsheet_parser_required",
			recommendedAction:
				"open the downloaded path with a spreadsheet parser; mm could not produce a bounded OOXML preview",
		};
	}
	const redacted = redactWorkbookPreview(workbook);
	const characters = [...redacted.preview];
	const preview = characters.slice(0, MAX_PREVIEW_CHARACTERS).join("");
	const truncated =
		workbook.truncated || characters.length > MAX_PREVIEW_CHARACTERS;
	return {
		status: "preview",
		format: "spreadsheet",
		decoded: true,
		syntaxValidated: false,
		preview,
		bytesExamined: input.bytes.byteLength,
		lines: redacted.headers.length ? redacted.rowCount + 1 : redacted.rowCount,
		downloaded: true,
		inspected: true,
		sheets: workbook.sheets,
		activeSheet: workbook.activeSheet,
		headers: redacted.headers,
		rowCount: redacted.rowCount,
		...(redacted.sensitiveFieldsDetected.length
			? {
					sensitiveFieldsDetected: redacted.sensitiveFieldsDetected,
					redactionApplied: true as const,
				}
			: {}),
		...(truncated ? { truncated: true as const } : {}),
	};
}

/**
 * Load an image-text extractor. Preference order:
 * 1. `MATTERMOST_OCR_MODULE` (explicit JS module)
 * 2. Built-in macOS Vision helper when on Darwin and not disabled
 * 3. `undefined` → images stay `not_interpreted`
 */
export async function loadConfiguredOcrExtractor(
	env: Record<string, string | undefined> = Bun.env,
): Promise<ImageTextExtractor | undefined> {
	const modulePath = env.MATTERMOST_OCR_MODULE?.trim();
	if (modulePath) {
		try {
			const loaded = (await import(modulePath)) as {
				extractImageText?: ImageTextExtractor;
				default?:
					| ImageTextExtractor
					| { extractImageText?: ImageTextExtractor };
			};
			if (typeof loaded.extractImageText === "function") {
				return loaded.extractImageText;
			}
			if (typeof loaded.default === "function") {
				return loaded.default;
			}
			if (
				loaded.default &&
				typeof loaded.default === "object" &&
				typeof loaded.default.extractImageText === "function"
			) {
				return loaded.default.extractImageText;
			}
		} catch {
			return undefined;
		}
		return undefined;
	}
	if (shouldUseMacosVisionOcr(env)) {
		const { createMacosVisionOcrExtractor } = await import("./macos-ocr.ts");
		return createMacosVisionOcrExtractor();
	}
	return undefined;
}

const SENSITIVE_HEADER =
	/(?:^|[_\s-])(phone|mobile|telephone|телефон|email|e-mail|почта|passport|паспорт|inn|инн|snils|снилс|card|карта|account|счет|счёт)(?:$|[_\s-])/iu;

function redactWorkbookPreview(workbook: {
	headers: string[];
	rows: string[][];
	preview: string;
	rowCount: number;
}): {
	headers: string[];
	rows: string[][];
	preview: string;
	rowCount: number;
	sensitiveFieldsDetected: string[];
	redactionApplied?: true;
} {
	const sensitiveIndexes = workbook.headers
		.map((value, index) => ({ value: value.trim(), index }))
		.filter(({ value }) => SENSITIVE_HEADER.test(value));
	const indexes = new Set(sensitiveIndexes.map(({ index }) => index));
	const headers = workbook.headers;
	const rows = workbook.rows.map((row) =>
		row.map((cell, index) =>
			indexes.has(index) && cell
				? "[REDACTED]"
				: redactObviousSensitiveValues(cell),
		),
	);
	const records = [
		headers,
		...rows.map((row) =>
			row.map((cell) =>
				indexes.size ? cell : redactObviousSensitiveValues(cell),
			),
		),
	];
	const preview = records
		.map((row) =>
			row
				.map((cell) =>
					encodeDelimitedField(cell.replace(/\r\n|\r|\n/gu, "\\n"), ","),
				)
				.join(","),
		)
		.join("\n");
	return {
		headers,
		rows,
		preview,
		rowCount: workbook.rowCount,
		sensitiveFieldsDetected: sensitiveIndexes.map(({ value }) => value),
		...(sensitiveIndexes.length ? { redactionApplied: true as const } : {}),
	};
}

/** Best-effort table minimization. Parsing remains deliberately unvalidated. */
function redactSensitiveTable(
	text: string,
	delimiter: "," | "\t",
	limit: number,
): { records: string[]; fields: string[]; truncated: boolean } {
	const parsed = parseDelimitedRecords(text, delimiter);
	const headers = parsed.records[0] ?? [];
	const sensitiveIndexes = headers
		.map((value, index) => ({ value: value.trim(), index }))
		.filter(({ value }) => SENSITIVE_HEADER.test(value));
	const indexes = new Set(sensitiveIndexes.map(({ index }) => index));
	const records = parsed.records.slice(0, limit).map((source, recordIndex) => {
		const fields = [...source];
		if (recordIndex > 0) {
			for (const index of indexes) {
				if (index < fields.length && fields[index])
					fields[index] = "[REDACTED]";
			}
		}
		const serialized = fields
			.map((field) =>
				encodeDelimitedField(field.replace(/\r\n|\r|\n/gu, "\\n"), delimiter),
			)
			.join(delimiter);
		return indexes.size ? redactObviousSensitiveValues(serialized) : serialized;
	});
	return {
		records,
		fields: sensitiveIndexes.map(({ value }) => value),
		truncated: !parsed.complete || parsed.records.length > limit,
	};
}

function redactObviousSensitiveValues(value: string): string {
	return value
		.replace(/[\w.+-]+@[\w.-]+\.[\p{L}]{2,}/giu, "[REDACTED]")
		.replace(/(?:\+?\d[\d ()-]{8,}\d)/gu, "[REDACTED]");
}

function parseDelimitedRecords(
	text: string,
	delimiter: "," | "\t",
): { records: string[][]; complete: boolean } {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character === '"') {
			if (quoted && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else {
				quoted = !quoted;
			}
		} else if (character === delimiter && !quoted) {
			record.push(field);
			field = "";
		} else if ((character === "\n" || character === "\r") && !quoted) {
			record.push(field);
			records.push(record);
			record = [];
			field = "";
			if (character === "\r" && text[index + 1] === "\n") index += 1;
		} else {
			field += character;
		}
	}
	if (!quoted && (field.length > 0 || record.length > 0)) {
		record.push(field);
		records.push(record);
	}
	return { records, complete: !quoted };
}

function encodeDelimitedField(field: string, delimiter: "," | "\t"): string {
	return field.includes(delimiter) || /["\r\n]/u.test(field)
		? `"${field.replaceAll('"', '""')}"`
		: field;
}

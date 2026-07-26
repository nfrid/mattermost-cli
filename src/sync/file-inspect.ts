export type FileInspection =
	| {
			status: "preview";
			format: "text" | "csv" | "json" | "xml";
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
	  }
	| {
			status: "not_interpreted";
			format: "image" | "spreadsheet" | "binary";
			interpreted: false;
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
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xls", "ods"]);
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
 * Inspect only bounded, directly decodable text. Binary formats stay explicit:
 * pretending a downloaded spreadsheet or image was read is worse than requiring
 * a capable external viewer.
 */
export function inspectDownloadedFile(input: {
	name: string;
	mimeType: string;
	bytes: Uint8Array;
	previewLines?: number;
}): FileInspection {
	const extension = input.name.split(".").pop()?.toLowerCase() ?? "";
	if (
		IMAGE_EXTENSIONS.has(extension) ||
		input.mimeType.toLowerCase().startsWith("image/")
	) {
		return {
			status: "not_interpreted",
			format: "image",
			interpreted: false,
			reason: "external_image_reader_required",
			recommendedAction:
				"the local path is readable by an image-capable agent or tool; mm does not perform OCR or generate captions",
		};
	}
	if (SPREADSHEET_EXTENSIONS.has(extension)) {
		return {
			status: "not_interpreted",
			format: "spreadsheet",
			interpreted: false,
			reason: "external_spreadsheet_parser_required",
			recommendedAction:
				"open the downloaded path with a spreadsheet parser; mm does not treat unparsed workbook bytes as evidence",
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
		...(table?.fields.length
			? {
					sensitiveFieldsDetected: table.fields,
					redactionApplied: true as const,
				}
			: {}),
		...(truncated ? { truncated: true as const } : {}),
	};
}

const SENSITIVE_HEADER =
	/(?:^|[_\s-])(phone|mobile|telephone|телефон|email|e-mail|почта|passport|паспорт|inn|инн|snils|снилс|card|карта|account|счет|счёт)(?:$|[_\s-])/iu;

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

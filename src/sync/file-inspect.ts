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
const MAX_PREVIEW_LINES = 40;

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
				"open the downloaded path with an image-capable reader; mm does not generate OCR or captions",
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
	const allLines = decoded.split(/\r\n|\r|\n/u);
	const lineBounded = allLines.slice(0, MAX_PREVIEW_LINES).join("\n");
	const characters = [...lineBounded];
	const preview = characters.slice(0, MAX_PREVIEW_CHARACTERS).join("");
	const truncated =
		input.bytes.byteLength > examined.byteLength ||
		allLines.length > MAX_PREVIEW_LINES ||
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
		lines: Math.min(allLines.length, MAX_PREVIEW_LINES),
		...(truncated ? { truncated: true as const } : {}),
	};
}

/**
 * Bounded XLSX (OOXML) preview without third-party parsers.
 *
 * Reads sheet names, the first worksheet's header row, and up to N data rows
 * from shared-string / inline cells. Store and deflate ZIP entries only —
 * unsupported layouts fall back to `undefined` so callers keep
 * `not_interpreted`.
 *
 * Large real workbooks often exceed a naive per-entry cap (`sharedStrings.xml`
 * ~1MB, `sheet1.xml` multi-MB). Oversized non-critical entries are skipped;
 * workbook / sheet / shared-string entries may inflate up to a higher bound, and
 * sheet XML is only scanned for the first preview rows when possible.
 */

import { inflateSync } from "bun";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_ZIP_ENTRIES = 96;
/** Soft cap: skip optional ZIP members above this without failing the workbook. */
const MAX_ENTRY_BYTES = 512 * 1024;
/**
 * Hard cap for workbook.xml, sharedStrings, and worksheet members that the
 * preview actually needs. Real BTB-scale sheets fit; beyond this we give up.
 */
const MAX_WORKBOOK_ENTRY_BYTES = 8 * 1024 * 1024;
/** When sheet XML is huge, only decode/scan this many uncompressed bytes. */
const MAX_SHEET_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SHEETS = 12;
const MAX_HEADER_CELLS = 40;
const MAX_PREVIEW_ROWS = 40;
const MAX_SHARED_STRINGS = 50_000;

export interface XlsxSheetPreview {
	name: string;
	headers: string[];
	rows: string[][];
	rowCount: number;
	truncated: boolean;
}

export interface XlsxWorkbookPreview {
	sheets: string[];
	/** First sheet that yielded cells (usually sheet1). */
	activeSheet: string;
	headers: string[];
	rows: string[][];
	/** Data rows included in {@link rows} (excludes the header row). */
	rowCount: number;
	truncated: boolean;
	/** CSV-like text for the active sheet preview (header + rows). */
	preview: string;
}

/**
 * Best-effort workbook preview. Returns `undefined` when the bytes are not a
 * recognizable OOXML workbook or the first sheet has no readable cells.
 */
export function previewXlsxWorkbook(
	bytes: Uint8Array,
	previewRows = 10,
): XlsxWorkbookPreview | undefined {
	const rowLimit = Math.max(
		1,
		Math.min(MAX_PREVIEW_ROWS, Math.floor(previewRows)),
	);
	const entries = readZipEntries(bytes);
	if (!entries) return undefined;

	const workbookXml = entryText(entries, "xl/workbook.xml");
	const relsXml = entryText(entries, "xl/_rels/workbook.xml.rels");
	if (!workbookXml || !relsXml) return undefined;

	const sheetRefs = parseWorkbookSheets(workbookXml);
	if (!sheetRefs.length) return undefined;
	const relTargets = parseRelationshipTargets(relsXml);
	const sharedEntry = entries.get(normalizeZipPath("xl/sharedStrings.xml"));
	const sharedStrings = parseSharedStrings(
		(sharedEntry ? decodeUtf8(sharedEntry.bytes) : "") ?? "",
		sharedEntry?.truncated,
	);

	const sheets: string[] = [];
	let active: XlsxSheetPreview | undefined;
	let workbookTruncated = Boolean(sharedEntry?.truncated);
	for (const sheet of sheetRefs.slice(0, MAX_SHEETS)) {
		sheets.push(sheet.name);
		const target = relTargets.get(sheet.rId);
		if (!target || active) continue;
		const path = normalizeZipPath(`xl/${target}`);
		const sheetEntry = entries.get(path);
		if (!sheetEntry) continue;
		const sheetXml = decodeUtf8(sheetEntry.bytes);
		if (!sheetXml) continue;
		const preview = parseWorksheet(sheetXml, sharedStrings.values, rowLimit);
		workbookTruncated =
			workbookTruncated ||
			sheetEntry.truncated ||
			sharedStrings.truncated ||
			preview.truncated;
		if (preview.rowCount > 0 || preview.headers.length > 0) {
			active = {
				...preview,
				name: sheet.name,
				truncated:
					preview.truncated || sheetEntry.truncated || sharedStrings.truncated,
			};
		}
	}
	if (!active) return undefined;

	const records = [active.headers, ...active.rows].filter(
		(row) => row.length > 0,
	);
	const preview = records
		.map((row) =>
			row
				.map((cell) => encodeCsvField(cell.replace(/\r\n|\r|\n/gu, "\\n")))
				.join(","),
		)
		.join("\n");

	return {
		sheets,
		activeSheet: active.name,
		headers: active.headers,
		rows: active.rows,
		rowCount: active.rowCount,
		truncated:
			active.truncated || workbookTruncated || sheetRefs.length > sheets.length,
		preview,
	};
}

interface ZipEntry {
	bytes: Uint8Array;
	/** True when only a prefix of the member was kept. */
	truncated?: boolean;
}

function readZipEntries(bytes: Uint8Array): Map<string, ZipEntry> | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries = new Map<string, ZipEntry>();
	let offset = 0;
	while (offset + 30 <= bytes.byteLength && entries.size < MAX_ZIP_ENTRIES) {
		if (view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) break;
		const compression = view.getUint16(offset + 8, true);
		const compressedSize = view.getUint32(offset + 18, true);
		const uncompressedSize = view.getUint32(offset + 22, true);
		const nameLength = view.getUint16(offset + 26, true);
		const extraLength = view.getUint16(offset + 28, true);
		const nameStart = offset + 30;
		const dataStart = nameStart + nameLength + extraLength;
		if (dataStart + compressedSize > bytes.byteLength) {
			// Truncated ZIP — keep whatever we already collected.
			break;
		}
		const name = new TextDecoder("utf-8").decode(
			bytes.subarray(nameStart, nameStart + nameLength),
		);
		const normalized = normalizeZipPath(name);
		const critical = isCriticalWorkbookPath(normalized);
		const sizeCap = critical ? MAX_WORKBOOK_ENTRY_BYTES : MAX_ENTRY_BYTES;
		offset = dataStart + compressedSize;
		if (name.endsWith("/")) continue;
		if (compressedSize > sizeCap || uncompressedSize > sizeCap) {
			// Skip oversized optional members; fail only if a critical path is too big.
			if (critical) return undefined;
			continue;
		}
		const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
		let raw: Uint8Array;
		try {
			if (compression === 0) {
				raw = compressed;
			} else if (compression === 8) {
				raw = new Uint8Array(inflateSync(Buffer.from(compressed)));
			} else {
				if (critical) return undefined;
				continue;
			}
		} catch {
			if (critical) return undefined;
			continue;
		}
		if (raw.byteLength !== uncompressedSize && uncompressedSize !== 0) {
			if (compression !== 8 && critical) return undefined;
			if (compression !== 8) continue;
		}
		let truncated = false;
		if (
			normalized.includes("/worksheets/") &&
			raw.byteLength > MAX_SHEET_SCAN_BYTES
		) {
			raw = raw.subarray(0, MAX_SHEET_SCAN_BYTES);
			truncated = true;
		}
		entries.set(normalized, {
			bytes: raw,
			...(truncated ? { truncated } : {}),
		});
	}
	return entries.size ? entries : undefined;
}

function isCriticalWorkbookPath(path: string): boolean {
	return (
		path === "xl/workbook.xml" ||
		path === "xl/_rels/workbook.xml.rels" ||
		path === "xl/sharedStrings.xml" ||
		path.startsWith("xl/worksheets/")
	);
}

function entryText(
	entries: ReadonlyMap<string, ZipEntry>,
	path: string,
): string | undefined {
	const entry = entries.get(normalizeZipPath(path));
	if (!entry) return undefined;
	return decodeUtf8(entry.bytes);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		// A sheet scan prefix may split a trailing multi-byte sequence.
		try {
			return new TextDecoder("utf-8").decode(bytes);
		} catch {
			return undefined;
		}
	}
}

function normalizeZipPath(path: string): string {
	return path.replace(/^\/+/u, "").replace(/\\/gu, "/");
}

function parseWorkbookSheets(
	xml: string,
): Array<{ name: string; rId: string }> {
	const sheets: Array<{ name: string; rId: string }> = [];
	const sheetTag =
		/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/?>|<sheet\b[^>]*\br:id="([^"]+)"[^>]*\bname="([^"]+)"[^>]*\/?>/giu;
	for (const match of xml.matchAll(sheetTag)) {
		const name = decodeXml(match[1] ?? match[4] ?? "");
		const rId = match[2] ?? match[3] ?? "";
		if (name && rId) sheets.push({ name, rId });
	}
	return sheets;
}

function parseRelationshipTargets(xml: string): Map<string, string> {
	const targets = new Map<string, string>();
	const relTag =
		/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>|<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"[^>]*\/?>/giu;
	for (const match of xml.matchAll(relTag)) {
		const id = match[1] ?? match[4] ?? "";
		const target = match[2] ?? match[3] ?? "";
		if (id && target) targets.set(id, target);
	}
	return targets;
}

function parseSharedStrings(
	xml: string,
	entryTruncated = false,
): { values: string[]; truncated: boolean } {
	if (!xml) return { values: [], truncated: entryTruncated };
	const values: string[] = [];
	const siBlocks = xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/giu) ?? [];
	const truncated =
		entryTruncated ||
		siBlocks.length > MAX_SHARED_STRINGS ||
		!xml.includes("</sst>");
	for (const block of siBlocks.slice(0, MAX_SHARED_STRINGS)) {
		const parts = [...block.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/giu)].map(
			(match) => decodeXml(match[1] ?? ""),
		);
		values.push(parts.join(""));
	}
	return { values, truncated };
}

function parseWorksheet(
	xml: string,
	sharedStrings: readonly string[],
	rowLimit: number,
): Omit<XlsxSheetPreview, "name"> {
	// Prefer a bounded scan: stop after rowLimit complete <row>…</row> blocks so
	// multi-megabyte sheets do not force a full global match.
	const matrix: string[][] = [];
	let truncated = false;
	let cursor = 0;
	const rowOpen = /<row\b[^>]*>/giu;
	while (matrix.length < rowLimit) {
		rowOpen.lastIndex = cursor;
		const open = rowOpen.exec(xml);
		if (!open) break;
		const openEnd = open.index + open[0].length;
		const close = xml.indexOf("</row>", openEnd);
		if (close < 0) {
			truncated = true;
			break;
		}
		const block = xml.slice(open.index, close + "</row>".length);
		cursor = close + "</row>".length;
		matrix.push(parseRowCells(block, sharedStrings));
	}
	if (matrix.length >= rowLimit) {
		rowOpen.lastIndex = cursor;
		if (rowOpen.exec(xml)) truncated = true;
	} else if (!xml.includes("</sheetData>") && !xml.includes("</worksheet>")) {
		truncated = true;
	}
	const headers = (matrix[0] ?? []).map((cell) => cell.trim());
	const rows = matrix.slice(1);
	if (headers.length > MAX_HEADER_CELLS) {
		truncated = true;
		headers.length = MAX_HEADER_CELLS;
	}
	return {
		headers,
		rows: rows.map((row) => row.slice(0, headers.length || MAX_HEADER_CELLS)),
		rowCount: rows.length,
		truncated,
	};
}

function parseRowCells(
	block: string,
	sharedStrings: readonly string[],
): string[] {
	const cells = new Map<number, string>();
	let maxCol = -1;
	for (const cell of block.matchAll(
		/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/giu,
	)) {
		const attrs = cell[1] ?? cell[3] ?? "";
		const body = cell[2] ?? "";
		const ref = /(?:^|\s)r="([A-Z]+)(\d+)"/u.exec(attrs);
		const col = ref ? columnIndex(ref[1] ?? "A") : maxCol + 1;
		const type = /(?:^|\s)t="([^"]+)"/u.exec(attrs)?.[1];
		let value = "";
		if (type === "inlineStr") {
			const parts = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/giu)].map(
				(match) => decodeXml(match[1] ?? ""),
			);
			value = parts.join("");
		} else {
			const raw = /<v>([\s\S]*?)<\/v>/u.exec(body)?.[1] ?? "";
			if (type === "s") {
				const index = Number(raw);
				value = Number.isInteger(index)
					? (sharedStrings[index] ?? "")
					: decodeXml(raw);
			} else {
				value = decodeXml(raw);
			}
		}
		cells.set(col, value);
		maxCol = Math.max(maxCol, col);
	}
	const width = Math.min(MAX_HEADER_CELLS, Math.max(0, maxCol + 1));
	return Array.from({ length: width }, (_, index) => cells.get(index) ?? "");
}

function columnIndex(letters: string): number {
	let value = 0;
	for (const character of letters.toUpperCase()) {
		value = value * 26 + (character.charCodeAt(0) - 64);
	}
	return Math.max(0, value - 1);
}

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'")
		.replace(/&amp;/gu, "&");
}

function encodeCsvField(field: string): string {
	return /[",\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/**
 * Build a minimal store-method XLSX for tests (no compression).
 */
export function buildMinimalXlsxFixture(input: {
	sheetName?: string;
	headers: string[];
	rows: string[][];
}): Uint8Array {
	const sheetName = input.sheetName ?? "Sheet1";
	const shared: string[] = [];
	const indexOf = (value: string) => {
		const existing = shared.indexOf(value);
		if (existing >= 0) return existing;
		shared.push(value);
		return shared.length - 1;
	};
	for (const cell of [...input.headers, ...input.rows.flat()]) indexOf(cell);

	const sharedXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
		.map((value) => `<si><t>${escapeXml(value)}</t></si>`)
		.join("")}</sst>`;

	const sheetRows = [input.headers, ...input.rows]
		.map((row, rowIndex) => {
			const cells = row
				.map((value, colIndex) => {
					const ref = `${columnLetters(colIndex)}${rowIndex + 1}`;
					return `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>`;
				})
				.join("");
			return `<row r="${rowIndex + 1}">${cells}</row>`;
		})
		.join("");
	const sheetXml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
	const workbookXml = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	const relsXml = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
	const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;

	return zipStore([
		{ name: "[Content_Types].xml", data: contentTypes },
		{ name: "xl/workbook.xml", data: workbookXml },
		{ name: "xl/_rels/workbook.xml.rels", data: relsXml },
		{ name: "xl/sharedStrings.xml", data: sharedXml },
		{ name: "xl/worksheets/sheet1.xml", data: sheetXml },
	]);
}

/**
 * Build an XLSX whose sharedStrings / sheet members exceed the soft entry cap
 * (regression for large real workbooks).
 */
export function buildLargeEntryXlsxFixture(input: {
	sharedStringsBytes: number;
	sheetPaddingBytes: number;
	headers: string[];
	rows: string[][];
}): Uint8Array {
	const shared: string[] = [];
	const indexOf = (value: string) => {
		const existing = shared.indexOf(value);
		if (existing >= 0) return existing;
		shared.push(value);
		return shared.length - 1;
	};
	for (const cell of [...input.headers, ...input.rows.flat()]) indexOf(cell);
	// One large shared string is enough to blow the soft ZIP entry cap without
	// an O(n²) fixture builder.
	const padTarget = Math.max(0, input.sharedStringsBytes);
	if (padTarget > 0) {
		indexOf(`pad-${"x".repeat(padTarget)}`);
	}

	const sharedXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
		.map((value) => `<si><t>${escapeXml(value)}</t></si>`)
		.join("")}</sst>`;

	const sheetRows = [input.headers, ...input.rows]
		.map((row, rowIndex) => {
			const cells = row
				.map((value, colIndex) => {
					const ref = `${columnLetters(colIndex)}${rowIndex + 1}`;
					return `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>`;
				})
				.join("");
			return `<row r="${rowIndex + 1}">${cells}</row>`;
		})
		.join("");
	const padChunk = "y".repeat(200);
	const paddingRowCount = Math.max(
		0,
		Math.ceil(input.sheetPaddingBytes / (padChunk.length + 80)),
	);
	const paddingRows = Array.from({ length: paddingRowCount }, (_, index) => {
		const rowNum = input.rows.length + 2 + index;
		return `<row r="${rowNum}"><c r="A${rowNum}" t="inlineStr"><is><t>${padChunk}</t></is></c></row>`;
	}).join("");
	const sheetXml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}${paddingRows}</sheetData></worksheet>`;
	const workbookXml = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	const relsXml = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
	const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;

	return zipStore([
		{ name: "[Content_Types].xml", data: contentTypes },
		{ name: "xl/workbook.xml", data: workbookXml },
		{ name: "xl/_rels/workbook.xml.rels", data: relsXml },
		{ name: "xl/sharedStrings.xml", data: sharedXml },
		{ name: "xl/worksheets/sheet1.xml", data: sheetXml },
	]);
}

function columnLetters(index: number): string {
	let value = index + 1;
	let letters = "";
	while (value > 0) {
		const rem = (value - 1) % 26;
		letters = String.fromCharCode(65 + rem) + letters;
		value = Math.floor((value - 1) / 26);
	}
	return letters;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;");
}

function zipStore(
	files: ReadonlyArray<{ name: string; data: string }>,
): Uint8Array {
	const chunks: Uint8Array[] = [];
	const encoder = new TextEncoder();
	for (const file of files) {
		const nameBytes = encoder.encode(file.name);
		const dataBytes = encoder.encode(file.data);
		const header = new Uint8Array(30 + nameBytes.byteLength);
		const view = new DataView(header.buffer);
		view.setUint32(0, LOCAL_FILE_SIGNATURE, true);
		view.setUint16(8, 0, true); // store
		view.setUint32(18, dataBytes.byteLength, true);
		view.setUint32(22, dataBytes.byteLength, true);
		view.setUint16(26, nameBytes.byteLength, true);
		header.set(nameBytes, 30);
		chunks.push(header, dataBytes);
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

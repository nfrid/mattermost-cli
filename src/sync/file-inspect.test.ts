import { describe, expect, test } from "bun:test";
import { inspectDownloadedFile } from "./file-inspect.ts";
import { buildMinimalXlsxFixture } from "./xlsx-preview.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("bounded attachment inspection", () => {
	test("previews text and reports its format", async () => {
		expect(
			await inspectDownloadedFile({
				name: "duplicates.csv",
				mimeType: "text/csv",
				bytes: bytes("id,status\n1,duplicate\n2,ok"),
			}),
		).toEqual({
			status: "preview",
			format: "csv",
			decoded: true,
			syntaxValidated: false,
			preview: "id,status\n1,duplicate\n2,ok",
			bytesExamined: 26,
			lines: 3,
			downloaded: true,
			inspected: true,
		});
	});

	test("caps lines and characters without decoding the whole document", async () => {
		const inspection = await inspectDownloadedFile({
			name: "events.log",
			mimeType: "text/plain",
			bytes: bytes(
				Array.from({ length: 100 }, (_, i) => `${i}:${"x".repeat(300)}`).join(
					"\n",
				),
			),
		});
		expect(inspection).toMatchObject({
			status: "preview",
			decoded: true,
			syntaxValidated: false,
			lines: 10,
			truncated: true,
			downloaded: true,
			inspected: true,
		});
		if (inspection.status === "preview") {
			expect([...inspection.preview].length).toBeLessThanOrEqual(8_000);
		}
	});

	test("redacts sensitive table columns and honors an explicit line cap", async () => {
		const inspection = await inspectDownloadedFile({
			name: "workers.csv",
			mimeType: "text/csv",
			bytes: bytes(
				'name,phone,email,note\nAlice,"+7 999 123-45-67",a@example.test,"kept, text"\nBob,89991234567,b@example.test,second\nCarol,123,c@example.test,third',
			),
			previewLines: 3,
		});
		expect(inspection).toMatchObject({
			status: "preview",
			format: "csv",
			lines: 3,
			sensitiveFieldsDetected: ["phone", "email"],
			redactionApplied: true,
			truncated: true,
		});
		if (inspection.status === "preview") {
			expect(inspection.preview).toContain("Alice,[REDACTED],[REDACTED]");
			expect(inspection.preview).toContain('"kept, text"');
			expect(inspection.preview).not.toContain("999 123");
			expect(inspection.preview).not.toContain("example.test");
			expect(inspection.preview).not.toContain("Carol");
		}
	});

	test("keeps sensitive columns masked after quoted multiline fields", async () => {
		const inspection = await inspectDownloadedFile({
			name: "workers.csv",
			mimeType: "text/csv",
			bytes: bytes(
				'note,passport,region\n"first line\nsecond line",1234567890,west\nplain,9876543210,east',
			),
		});
		expect(inspection).toMatchObject({
			status: "preview",
			sensitiveFieldsDetected: ["passport"],
			redactionApplied: true,
			lines: 3,
		});
		if (inspection.status === "preview") {
			expect(inspection.preview).toContain("first line\\nsecond line");
			expect(inspection.preview).not.toContain("1234567890");
			expect(inspection.preview).not.toContain("9876543210");
		}
	});

	test("handles CR lines and a UTF-8 code point cut by the byte bound", async () => {
		const cr = await inspectDownloadedFile({
			name: "rows.txt",
			mimeType: "text/plain",
			bytes: bytes("one\rtwo\rthree"),
		});
		expect(cr).toMatchObject({ status: "preview", lines: 3 });

		const prefix = new Uint8Array(64 * 1024 + 2).fill(65);
		prefix[64 * 1024 - 1] = 0xe2;
		prefix[64 * 1024] = 0x82;
		prefix[64 * 1024 + 1] = 0xac;
		const split = await inspectDownloadedFile({
			name: "large.txt",
			mimeType: "text/plain",
			bytes: prefix,
		});
		expect(split).toMatchObject({ status: "preview", truncated: true });
	});

	test("classifies but does not claim syntax validation", async () => {
		expect(
			await inspectDownloadedFile({
				name: "broken.json",
				mimeType: "application/json",
				bytes: bytes("not json"),
			}),
		).toMatchObject({
			status: "preview",
			format: "json",
			decoded: true,
			syntaxValidated: false,
			preview: "not json",
		});
	});

	test("previews bounded xlsx sheets with PII redaction", async () => {
		const inspection = await inspectDownloadedFile({
			name: "rows.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			bytes: buildMinimalXlsxFixture({
				sheetName: "Dupes",
				headers: ["name", "email", "note"],
				rows: [
					["Alice", "a@example.test", "kept"],
					["Bob", "b@example.test", "second"],
				],
			}),
			previewLines: 2,
		});
		expect(inspection).toMatchObject({
			status: "preview",
			format: "spreadsheet",
			decoded: true,
			downloaded: true,
			inspected: true,
			sheets: ["Dupes"],
			activeSheet: "Dupes",
			headers: ["name", "email", "note"],
			sensitiveFieldsDetected: ["email"],
			redactionApplied: true,
		});
		if (inspection.status === "preview") {
			expect(inspection.preview).toContain("Alice,[REDACTED],kept");
			expect(inspection.preview).not.toContain("example.test");
			expect(inspection.rowCount).toBe(1);
		}
	});

	test("never claims images or legacy spreadsheets were read by default", async () => {
		expect(
			await inspectDownloadedFile({
				name: "screen.png",
				mimeType: "image/png",
				bytes: new Uint8Array([137, 80, 78, 71]),
			}),
		).toMatchObject({
			status: "not_interpreted",
			format: "image",
			interpreted: false,
			downloaded: true,
			inspected: false,
			reason: "external_image_reader_required",
		});
		expect(
			await inspectDownloadedFile({
				name: "rows.xls",
				mimeType: "application/vnd.ms-excel",
				bytes: new Uint8Array([80, 75, 3, 4]),
			}),
		).toMatchObject({
			status: "not_interpreted",
			format: "spreadsheet",
			interpreted: false,
			downloaded: true,
			inspected: false,
			reason: "external_spreadsheet_parser_required",
		});
		expect(
			await inspectDownloadedFile({
				name: "bad.txt",
				mimeType: "text/plain",
				bytes: new Uint8Array([65, 0, 66]),
			}),
		).toMatchObject({
			status: "not_interpreted",
			format: "binary",
			interpreted: false,
		});
	});

	test("opt-in OCR extractor yields low-trust text_extracted", async () => {
		const inspection = await inspectDownloadedFile({
			name: "screen.png",
			mimeType: "image/png",
			bytes: new Uint8Array([137, 80, 78, 71]),
			extractImageText: () => ({
				text: "duplicate charge 42",
				engine: "test-ocr",
			}),
		});
		expect(inspection).toEqual({
			status: "text_extracted",
			format: "image",
			trust: "low",
			source: "ocr",
			text: "duplicate charge 42",
			downloaded: true,
			inspected: true,
			engine: "test-ocr",
		});
	});

	test("previews xlsx workbooks whose ZIP entries exceed the soft 512KiB cap", async () => {
		const { buildLargeEntryXlsxFixture } = await import("./xlsx-preview.ts");
		const bytes = buildLargeEntryXlsxFixture({
			sharedStringsBytes: 600 * 1024,
			sheetPaddingBytes: 600 * 1024,
			headers: ["id", "status"],
			rows: [
				["1", "duplicate"],
				["2", "ok"],
			],
		});
		expect(bytes.byteLength).toBeGreaterThan(512 * 1024);
		const inspection = await inspectDownloadedFile({
			name: "large.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			bytes,
			previewLines: 3,
		});
		expect(inspection).toMatchObject({
			status: "preview",
			format: "spreadsheet",
			downloaded: true,
			inspected: true,
			headers: ["id", "status"],
		});
		if (inspection.status === "preview") {
			expect(inspection.preview).toContain("1,duplicate");
			expect(inspection.rowCount).toBeGreaterThanOrEqual(1);
		}
	});

	test("darwin OCR loader prefers an injected extractor over not_interpreted", async () => {
		const { createMacosVisionOcrExtractor, shouldUseMacosVisionOcr } =
			await import("./macos-ocr.ts");
		expect(
			shouldUseMacosVisionOcr({ MATTERMOST_OCR_MODULE: undefined }, "darwin"),
		).toBe(true);
		expect(
			shouldUseMacosVisionOcr(
				{ MATTERMOST_OCR_MODULE: "/tmp/ocr.js" },
				"darwin",
			),
		).toBe(false);
		expect(
			shouldUseMacosVisionOcr({ MATTERMOST_OCR_DISABLE_MACOS: "1" }, "darwin"),
		).toBe(false);
		expect(shouldUseMacosVisionOcr({}, "linux")).toBe(false);

		const extractor = createMacosVisionOcrExtractor({
			swiftBin: "false",
			timeoutMs: 100,
		});
		const failed = await extractor({
			name: "x.png",
			mimeType: "image/png",
			bytes: new Uint8Array([137, 80, 78, 71]),
		});
		expect(failed).toBeNull();
	});
});

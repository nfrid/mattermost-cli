import { describe, expect, test } from "bun:test";
import { inspectDownloadedFile } from "./file-inspect.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("bounded attachment inspection", () => {
	test("previews text and reports its format", () => {
		expect(
			inspectDownloadedFile({
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
		});
	});

	test("caps lines and characters without decoding the whole document", () => {
		const inspection = inspectDownloadedFile({
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
		});
		if (inspection.status === "preview") {
			expect([...inspection.preview].length).toBeLessThanOrEqual(8_000);
		}
	});

	test("redacts sensitive table columns and honors an explicit line cap", () => {
		const inspection = inspectDownloadedFile({
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

	test("keeps sensitive columns masked after quoted multiline fields", () => {
		const inspection = inspectDownloadedFile({
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

	test("handles CR lines and a UTF-8 code point cut by the byte bound", () => {
		const cr = inspectDownloadedFile({
			name: "rows.txt",
			mimeType: "text/plain",
			bytes: bytes("one\rtwo\rthree"),
		});
		expect(cr).toMatchObject({ status: "preview", lines: 3 });

		const prefix = new Uint8Array(64 * 1024 + 2).fill(65);
		prefix[64 * 1024 - 1] = 0xe2;
		prefix[64 * 1024] = 0x82;
		prefix[64 * 1024 + 1] = 0xac;
		const split = inspectDownloadedFile({
			name: "large.txt",
			mimeType: "text/plain",
			bytes: prefix,
		});
		expect(split).toMatchObject({ status: "preview", truncated: true });
	});

	test("classifies but does not claim syntax validation", () => {
		expect(
			inspectDownloadedFile({
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

	test("never claims images, spreadsheets, or disguised binary were read", () => {
		expect(
			inspectDownloadedFile({
				name: "screen.png",
				mimeType: "image/png",
				bytes: new Uint8Array([137, 80, 78, 71]),
			}),
		).toMatchObject({
			status: "not_interpreted",
			format: "image",
			interpreted: false,
			reason: "external_image_reader_required",
		});
		expect(
			inspectDownloadedFile({
				name: "rows.xlsx",
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				bytes: new Uint8Array([80, 75, 3, 4]),
			}),
		).toMatchObject({
			status: "not_interpreted",
			format: "spreadsheet",
			interpreted: false,
			reason: "external_spreadsheet_parser_required",
		});
		expect(
			inspectDownloadedFile({
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
});

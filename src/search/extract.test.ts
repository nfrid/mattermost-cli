import { describe, expect, test } from "bun:test";
import { extractEngineeringEntities, extractTicketKeys } from "./extract.ts";

describe("engineering entity extraction", () => {
	test("extracts conservative identifiers from realistic mixed-language text", () => {
		const entities = extractEngineeringEntities(
			"В repo payment-api и сервис billing-worker файл src/jobs/dispatch.ts вызывает scheduleRetry() для E_QUEUE_42. " +
				"Смотри PR #417, commit deadbeef, @alice и https://gitlab.example/example-org/worker-runtime/-/merge_requests/417",
		);
		expect(entities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "repository", value: "payment-api" }),
				expect.objectContaining({ kind: "service", value: "billing-worker" }),
				expect.objectContaining({
					kind: "repository",
					value: "example-org/worker-runtime",
				}),
				expect.objectContaining({
					kind: "file_path",
					value: "src/jobs/dispatch.ts",
				}),
				expect.objectContaining({ kind: "symbol", value: "scheduleRetry" }),
				expect.objectContaining({ kind: "error_code", value: "E_QUEUE_42" }),
				expect.objectContaining({ kind: "pull_request", value: "PR #417" }),
				expect.objectContaining({ kind: "commit", value: "deadbeef" }),
				expect.objectContaining({ kind: "username", value: "alice" }),
				expect.objectContaining({ kind: "url" }),
			]),
		);
	});

	test("does not classify ordinary Russian conversation as engineering metadata", () => {
		expect(
			extractEngineeringEntities(
				"После обеда созвонимся и обсудим, почему очередь снова растёт.",
			),
		).toEqual([]);
	});

	test("extracts unique tracker keys without depending on LLM packing", () => {
		expect(
			extractTicketKeys(
				"TECHSUPP-109 + https://tracker.example/BTBOLD-238 and btb-1870",
			),
		).toEqual(["BTB-1870", "BTBOLD-238", "TECHSUPP-109"]);
	});
});

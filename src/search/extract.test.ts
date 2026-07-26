import { describe, expect, test } from "bun:test";
import {
	extractEngineeringEntities,
	extractTicketKeys,
	isTrackerIssueHost,
} from "./extract.ts";

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

	test("isTrackerIssueHost allowlists tracker/Jira hosts only", () => {
		expect(isTrackerIssueHost("tracker.yandex.ru")).toBe(true);
		expect(isTrackerIssueHost("tracker.example")).toBe(true);
		expect(isTrackerIssueHost("jira.mygig.tech")).toBe(true);
		expect(isTrackerIssueHost("acme.atlassian.net")).toBe(true);
		expect(isTrackerIssueHost("youtrack.example.com")).toBe(true);
		expect(isTrackerIssueHost("kibana.mygig.tech")).toBe(false);
		expect(isTrackerIssueHost("chat.example.test")).toBe(false);
		expect(isTrackerIssueHost("gitlab.example")).toBe(false);
	});

	test("does not treat Kibana data-stream path segments as ticket keys", () => {
		const kibana =
			"https://kibana.mygig.tech/s/kubernetes-production/app/discover#/doc/409e20ae-c74a-4f59-8f5f-ccc6c78d3b43/.ds-prod-api-2026.24-2026.06.15-000001?id=AZ7LBwvBCAmQdXddylWO";
		expect(extractTicketKeys(kibana)).toEqual([]);
		expect(extractTicketKeys(`see logs ${kibana}`)).toEqual([]);
		expect(extractTicketKeys(`BTB-1281 see ${kibana}`)).toEqual(["BTB-1281"]);
		expect(
			extractTicketKeys("https://jira.mygig.tech/browse/PCRM-1555"),
		).toEqual(["PCRM-1555"]);
	});
});

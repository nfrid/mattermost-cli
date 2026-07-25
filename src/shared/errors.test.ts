import { describe, expect, test } from "bun:test";
import {
	unindexedConversationError,
	unknownConversationError,
} from "./errors.ts";

describe("unknownConversationError", () => {
	test("suggests the nearest alias and points at mm channels", () => {
		const error = unknownConversationError(
			["b2b-tem"],
			["b2b-team", "backend-zone", "tech-support-duty"],
		);

		expect(error.kind).toBe("unknown_conversation");
		expect(error.message).toContain("b2b-tem");
		expect(error.message).toContain("Did you mean: b2b-team?");
		expect(error.message).toContain("mm channels");
	});

	test("lists known aliases without a suggestion when nothing is close", () => {
		const error = unknownConversationError(
			["nonexistent"],
			["b2b-team", "backend-zone"],
		);

		expect(error.message).not.toContain("Did you mean");
		expect(error.message).toContain("Known aliases: b2b-team, backend-zone");
	});

	test("caps the listed aliases and reports the remainder", () => {
		const known = Array.from({ length: 15 }, (_, index) => `alias-${index}`);
		const error = unknownConversationError(["zzz"], known);

		expect(error.message).toContain("(+3 more)");
	});

	test("never suggests from an alias too short to mean anything", () => {
		const error = unknownConversationError(
			["i"],
			["ticket-support-and-infra-triage", "b2b-team"],
		);

		expect(error.message).not.toContain("Did you mean");
	});

	test("says so plainly when no conversation is configured", () => {
		const error = unknownConversationError(["payments"], []);

		expect(error.message).toContain("No conversations are configured");
	});
});

describe("unindexedConversationError", () => {
	test("names the sync command for a single configured-but-unindexed alias", () => {
		const error = unindexedConversationError(["b2b-team"]);

		expect(error.kind).toBe("unknown_conversation");
		expect(error.message).toContain("mm sync --channel b2b-team");
	});

	test("falls back to a plain sync for several aliases", () => {
		const error = unindexedConversationError(["b2b-team", "devops"]);

		expect(error.message).toContain("Run `mm sync` first.");
	});
});

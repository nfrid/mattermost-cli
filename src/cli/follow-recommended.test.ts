import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION } from "../shared/command-result.ts";
import { createProgram } from "./program.ts";

describe("context --follow-recommended", () => {
	test("accepts the flag with --agent and surfaces it on options", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const program = createProgram(async (command, _global, commandOptions) => {
			seen.push({ command, ...(commandOptions ?? {}) });
			return {
				command,
				schemaVersion: SCHEMA_VERSION,
				success: true,
				data: {},
				warnings: [],
			};
		});

		await program.parseAsync(
			["context", "BTB-1", "--agent", "--follow-recommended"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			command: "context",
			subject: "BTB-1",
			followRecommended: true,
		});
	});

	test("allows --navigate with ticket brief default (no CLI conflict)", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const program = createProgram(async (command, _global, commandOptions) => {
			seen.push({ command, ...(commandOptions ?? {}) });
			return {
				command,
				schemaVersion: SCHEMA_VERSION,
				success: true,
				data: {},
				warnings: [],
			};
		});

		await program.parseAsync(
			["context", "BTB-1", "--agent", "--navigate", "--brief"],
			{ from: "user" },
		);
		expect(seen.at(-1)).toMatchObject({
			navigate: true,
			brief: true,
		});
	});
});

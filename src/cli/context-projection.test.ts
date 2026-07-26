import { describe, expect, test } from "bun:test";
import { resolveContextAgentBrief } from "./context-projection.ts";

describe("resolveContextAgentBrief", () => {
	test("default-vs-flag matrix for ticket and non-ticket subjects", () => {
		const matrix: Array<{
			name: string;
			input: Parameters<typeof resolveContextAgentBrief>[0];
			brief: boolean;
		}> = [
			{
				name: "ticket --agent with no projection flag → brief",
				input: { agent: true, subject: "BTB-1" },
				brief: true,
			},
			{
				name: "ticket via --ticket under --agent → brief",
				input: { agent: true, subject: "payment fix", ticket: "BTB-1" },
				brief: true,
			},
			{
				name: "ticket --agent --full-posts → dense",
				input: { agent: true, subject: "BTB-1", fullPosts: true },
				brief: false,
			},
			{
				name: "ticket --agent --brief → brief",
				input: { agent: true, subject: "BTB-1", brief: true },
				brief: true,
			},
			{
				name: "ticket --agent --navigate → brief kept",
				input: { agent: true, subject: "BTB-1", navigate: true },
				brief: true,
			},
			{
				name: "ticket --agent --short → not brief",
				input: { agent: true, subject: "BTB-1", short: true },
				brief: false,
			},
			{
				name: "text --agent → dense (no auto brief)",
				input: { agent: true, subject: "payment timeout" },
				brief: false,
			},
			{
				name: "post id --agent → dense",
				input: {
					agent: true,
					subject: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
				},
				brief: false,
			},
			{
				name: "ticket without --agent → dense human default",
				input: { agent: false, subject: "BTB-1" },
				brief: false,
			},
			{
				name: "ticket without --agent but --brief → brief",
				input: { agent: false, subject: "BTB-1", brief: true },
				brief: true,
			},
			{
				name: "explicit --brief wins over --full-posts if both set",
				input: {
					agent: true,
					subject: "BTB-1",
					brief: true,
					fullPosts: true,
				},
				brief: true,
			},
		];

		for (const row of matrix) {
			expect(resolveContextAgentBrief(row.input), row.name).toBe(row.brief);
		}
	});
});

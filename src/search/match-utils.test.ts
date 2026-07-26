import { describe, expect, test } from "bun:test";
import {
	excerpt,
	redactCredentialExcerpts,
	truncateExcerpt,
} from "./match-utils.ts";

describe("credential excerpt redaction", () => {
	test("redacts login, password, and token phrases", () => {
		expect(
			redactCredentialExcerpts(
				"суперадмин login: eg@mygig.ru пароль: secret123 token: abcdEFGH",
			),
		).toBe("суперадмин login: [REDACTED] пароль: [REDACTED] token: [REDACTED]");
		expect(redactCredentialExcerpts("Bearer abcdefghijklmnop")).toBe(
			"Bearer [REDACTED]",
		);
	});

	test("applies redaction before truncating search excerpts", () => {
		const text = excerpt("password: hunter2 and more context around it");
		expect(text).toContain("password: [REDACTED]");
		expect(text).not.toContain("hunter2");
		expect(truncateExcerpt("login=admin", 40)).toBe("login: [REDACTED]");
	});
});

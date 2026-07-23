import { describe, expect, test } from "bun:test";
import { AppError } from "./errors.ts";
import { MattermostClient } from "./mattermost/client.ts";
import { stableError } from "./results.ts";

describe("standalone security boundaries", () => {
	test("Git ignores local credentials, databases, journals, and downloads", async () => {
		const paths = [
			".env",
			".mattermost/config.json",
			".mattermost/mattermost.sqlite3",
			".mattermost/mattermost.sqlite3-wal",
			"downloads/file.bin",
		];
		const ignored = Bun.spawnSync(["git", "check-ignore", ...paths], {
			cwd: new URL("..", import.meta.url).pathname,
		});
		expect(ignored.exitCode).toBe(0);
		expect(ignored.stdout.toString().trim().split("\n").sort()).toEqual(
			paths.sort(),
		);
	});

	test("the Mattermost client exposes named read operations only", () => {
		const methods = Object.getOwnPropertyNames(MattermostClient.prototype);
		for (const forbidden of [
			"request",
			"post",
			"put",
			"patch",
			"delete",
			"react",
			"getFile",
		]) {
			expect(methods).not.toContain(forbidden);
		}
		expect(methods).toContain("getFileInfo");
		expect(methods).toContain("downloadFile");
		expect(methods).toContain("searchTeamPosts");
	});

	test("stable errors redact resolved secrets from messages and details", () => {
		const token = "realistic-sensitive-value";
		const error = new AppError(
			`Request with ${token} failed`,
			"mattermost",
			"synthetic_failure",
			1,
			undefined,
			{ diagnostic: `header Bearer ${token}` },
		);
		expect(JSON.stringify(stableError(error, [token]))).not.toContain(token);
	});
});

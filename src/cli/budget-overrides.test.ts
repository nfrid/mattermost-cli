import { describe, expect, test } from "bun:test";
import { configFixture } from "../test-fixtures.ts";
import { applyBudgetOverrides } from "./execute.ts";

describe("applyBudgetOverrides", () => {
	test("leaves config unchanged when flags are omitted", () => {
		const config = configFixture();
		expect(applyBudgetOverrides(config, {})).toBe(config);
		expect(config.budgets.defaultMaxThreads).toBe(3);
	});

	test("overrides only the named budget fields", () => {
		const config = configFixture();
		const next = applyBudgetOverrides(config, {
			maxThreads: 5,
			perThreadCharacters: 7_000,
		});
		expect(next.budgets.defaultMaxThreads).toBe(5);
		expect(next.budgets.defaultPerThreadCharacters).toBe(7_000);
		expect(next.budgets.defaultMaxCharacters).toBe(
			config.budgets.defaultMaxCharacters,
		);
		expect(config.budgets.defaultMaxThreads).toBe(3);
	});

	test("rejects out-of-range overrides", () => {
		const config = configFixture();
		expect(() => applyBudgetOverrides(config, { maxThreads: 0 })).toThrow(
			/max-threads/i,
		);
		expect(() => applyBudgetOverrides(config, { maxThreads: 21 })).toThrow(
			/max-threads/i,
		);
		expect(() => applyBudgetOverrides(config, { maxCharacters: 100 })).toThrow(
			/max-characters/i,
		);
		expect(() =>
			applyBudgetOverrides(config, { perThreadCharacters: 100 }),
		).toThrow(/per-thread-characters/i);
	});
});

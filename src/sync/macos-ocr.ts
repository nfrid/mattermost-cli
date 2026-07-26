/**
 * Built-in macOS Vision OCR backend for image inspect.
 *
 * Used when `MATTERMOST_OCR_MODULE` is unset on Darwin. Spawns a small Swift
 * Vision helper with size/time caps; failures yield `undefined` so callers keep
 * `not_interpreted`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageTextExtractor } from "./image-text.ts";

const MAX_OCR_BYTES = 12 * 1024 * 1024;
const OCR_TIMEOUT_MS = 20_000;

/** Absolute path to the Swift Vision helper shipped with the repo. */
export function macosOcrScriptPath(from = import.meta.dir): string {
	return join(from, "macos-ocr.swift");
}

/**
 * Vision-backed extractor. Returns `null` on empty text, timeout, or spawn
 * failure so inspect falls back to `not_interpreted`.
 */
export function createMacosVisionOcrExtractor(input?: {
	scriptPath?: string;
	swiftBin?: string;
	timeoutMs?: number;
	maxBytes?: number;
}): ImageTextExtractor {
	const scriptPath = input?.scriptPath ?? macosOcrScriptPath();
	const swiftBin = input?.swiftBin ?? "swift";
	const timeoutMs = input?.timeoutMs ?? OCR_TIMEOUT_MS;
	const maxBytes = input?.maxBytes ?? MAX_OCR_BYTES;

	return async ({ name, bytes }) => {
		if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
		const extension = name.split(".").pop()?.toLowerCase() || "png";
		const dir = await mkdtemp(join(tmpdir(), "mm-ocr-"));
		const imagePath = join(dir, `image.${extension}`);
		try {
			await writeFile(imagePath, bytes);
			const proc = Bun.spawn([swiftBin, scriptPath, imagePath], {
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});
			const timedOut = await Promise.race([
				proc.exited.then(() => false),
				Bun.sleep(timeoutMs).then(() => true),
			]);
			if (timedOut) {
				try {
					proc.kill();
				} catch {
					// ignore
				}
				return null;
			}
			const exitCode = await proc.exited;
			if (exitCode !== 0) return null;
			const text = (await new Response(proc.stdout).text()).trim();
			if (!text) return null;
			return { text, engine: "macos-vision" };
		} catch {
			return null;
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	};
}

/** True when the process can attempt the built-in Darwin Vision path. */
export function shouldUseMacosVisionOcr(
	env: Record<string, string | undefined> = Bun.env,
	platform = process.platform,
): boolean {
	if (platform !== "darwin") return false;
	if (env.MATTERMOST_OCR_MODULE?.trim()) return false;
	if (env.MATTERMOST_OCR_DISABLE_MACOS === "1") return false;
	return true;
}

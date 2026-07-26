#!/usr/bin/env swift
import Foundation
import Vision
import AppKit

// Bounded macOS Vision OCR helper for mm file --inspect.
// Usage: macos-ocr.swift <image-path>
// Prints UTF-8 text to stdout; exits 0 on success (possibly empty), 2 on usage/IO,
// 3 when Vision fails.

let args = CommandLine.arguments
guard args.count >= 2 else {
	fputs("usage: macos-ocr.swift <image-path>\n", stderr)
	exit(2)
}

let path = args[1]
let url = URL(fileURLWithPath: path)
guard let image = NSImage(contentsOf: url) else {
	fputs("failed to load image\n", stderr)
	exit(2)
}
guard let tiff = image.tiffRepresentation,
	let rep = NSBitmapImageRep(data: tiff),
	let cgImage = rep.cgImage
else {
	fputs("failed to decode image bitmap\n", stderr)
	exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
// Prefer Latin + Cyrillic when the OS supports them; ignore unknown codes.
request.recognitionLanguages = ["en-US", "ru-RU", "en", "ru"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
	try handler.perform([request])
} catch {
	fputs("vision failed: \(error.localizedDescription)\n", stderr)
	exit(3)
}

let observations = request.results ?? []
var lines: [String] = []
for observation in observations {
	guard let candidate = observation.topCandidates(1).first else { continue }
	let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
	if !text.isEmpty { lines.append(text) }
}

print(lines.joined(separator: "\n"))

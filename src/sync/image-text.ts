/**
 * The pluggable image-OCR contract.
 *
 * A leaf module on purpose: both `file-inspect.ts` (which consumes an
 * extractor) and `macos-ocr.ts` (which implements one) need this type, and
 * declaring it in either made the two import each other.
 */
export type ImageTextExtractor = (input: {
	name: string;
	mimeType: string;
	bytes: Uint8Array;
}) =>
	| { text: string; engine?: string; truncated?: true }
	| null
	| undefined
	| Promise<
			{ text: string; engine?: string; truncated?: true } | null | undefined
	  >;

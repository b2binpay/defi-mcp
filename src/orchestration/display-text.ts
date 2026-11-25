/**
 * C0/C1 controls (newlines included) and the Unicode format characters that reorder or hide text — bidi
 * embeddings/overrides/isolates, zero-width characters, the BOM. Rendered as visible escapes, so backend- or
 * proposer-written text cannot push content off-screen or display in a different order than it is stored.
 */
const HIDDEN_OR_REORDERING = /[\p{Cc}؜​-‏‪-‮⁠-⁩﻿]/gu;

const HEX_RADIX = 16;

/** `confirm` is built only from ids, numbers, addresses, hex and fixed text, so it is always printable ASCII. */
const PRINTABLE_ASCII_LINE = /^[ -~]*$/;

/** Text from outside the server, made safe to show: hidden and reordering characters become `\u{…}` escapes. */
export function toDisplayText(value: string): string {
  return value.replace(HIDDEN_OR_REORDERING, (character) => `\\u{${character.codePointAt(0)?.toString(HEX_RADIX)}}`);
}

/** {@link toDisplayText} applied to every string key and value of a JSON-like value. */
export function toDisplayJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return toDisplayText(value);
  }
  if (Array.isArray(value)) {
    return value.map(toDisplayJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [toDisplayText(key), toDisplayJson(item)]));
  }
  return value;
}

/** Fail closed if anything non-printable or multi-line ever reaches the text the human approves. */
export function assertPrintableLine(text: string): void {
  if (!PRINTABLE_ASCII_LINE.test(text)) {
    throw new Error('Refusing to build a confirmation that is not a single line of printable ASCII');
  }
}

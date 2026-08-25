/**
 * Character pairs an OCR pass commonly confuses (see product principle 2.3).
 * This is documentation/UI-warning data only — it must never be used to
 * "correct" a captured identifier before matching. Matching always compares
 * the identifier exactly as normalized (whitespace/case only).
 */
export const OCR_AMBIGUOUS_CHARACTER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["O", "0"],
  ["I", "1"],
  ["S", "5"],
  ["B", "8"],
];

/**
 * Normalizes an identifier for exact-match comparison: trims surrounding
 * whitespace and upper-cases it. This does not fix OCR character confusion
 * (O/0, I/1, S/5, B/8) — those remain distinct values and a mismatch on them
 * simply fails to match, which is the desired behavior (principle 2.3).
 */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Validates the check digit of an EAN-8 or EAN-13 barcode using the
 * standard GS1 algorithm: starting from the rightmost digit before the
 * check digit, weights alternate 3, 1, 3, 1, ...
 */
export function isValidEanChecksum(value: string): boolean {
  if (!/^\d{8}$|^\d{13}$/.test(value)) return false;

  const digits = value.split("").map(Number);
  const checkDigit = digits.pop() as number;

  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const positionFromRight = digits.length - i;
    const weight = positionFromRight % 2 === 1 ? 3 : 1;
    sum += digits[i] * weight;
  }

  const computedCheckDigit = (10 - (sum % 10)) % 10;
  return computedCheckDigit === checkDigit;
}

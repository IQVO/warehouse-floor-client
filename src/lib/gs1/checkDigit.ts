/**
 * GS1 mod-10 check digit, shared by GTIN-8/12/13/14 and SSCC-18.
 *
 * Working from the right, the digit before the check digit is weighted 3, the
 * next 1, alternating. The check digit brings the weighted sum to a multiple
 * of 10.
 */
export function computeCheckDigit(payload: string): number {
  let sum = 0;
  for (let i = payload.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += (payload.charCodeAt(i) - 48) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when `digits` is all digits, at least 2 long, and its last digit is the correct GS1 mod-10 check digit. */
export function hasValidCheckDigit(digits: string): boolean {
  return /^\d{2,}$/.test(digits) && computeCheckDigit(digits.slice(0, -1)) === digits.charCodeAt(digits.length - 1) - 48;
}

export interface IcoResult {
  ico: string;
  reason: string;
  valid: boolean;
}

const WHITESPACE = /\s+/g;
const CZ_PREFIX = /^cz/i;
const DIGITS = /^\d+$/;
const ICO_LENGTH = 8;
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2];
const MODULUS = 11;

export function validateIco(raw: unknown): IcoResult {
  if (typeof raw !== "string") {
    const asText = raw === null || raw === undefined ? "" : String(raw);
    return { ico: asText, reason: "not_digits", valid: false };
  }
  const cleaned = raw.replace(WHITESPACE, "").replace(CZ_PREFIX, "");
  if (cleaned === "" || !DIGITS.test(cleaned)) {
    return { ico: cleaned, reason: "not_digits", valid: false };
  }
  if (cleaned.length > ICO_LENGTH) {
    return { ico: cleaned, reason: "too_long", valid: false };
  }
  const ico = cleaned.padStart(ICO_LENGTH, "0");
  let sum = 0;
  for (let i = 0; i < WEIGHTS.length; i += 1) {
    sum += Number(ico[i]) * WEIGHTS[i];
  }
  const r = sum % MODULUS;
  let check = MODULUS - r;
  if (r === 0) {
    check = 1;
  } else if (r === 1) {
    check = 0;
  }
  const ok = check === Number(ico[ICO_LENGTH - 1]);
  return { ico, reason: ok ? "ok" : "checksum", valid: ok };
}

export function validateInput(input: unknown): { results: IcoResult[] } {
  if (typeof input !== "object" || input === null || !("ico" in input)) {
    throw new Error("Missing field: ico");
  }
  const list = (input as { ico: unknown }).ico;
  if (!Array.isArray(list)) {
    throw new Error("ico must be an array of strings");
  }
  if (list.length === 0) {
    throw new Error("ico must not be empty");
  }
  return { results: list.map((item) => validateIco(item)) };
}

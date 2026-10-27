/** Python identifiers, including Unicode names and numeric JSON path segments. */
export const PYTHON_IDENTIFIER_PATTERN = String.raw`[_\p{XID_Start}][_\p{XID_Continue}]*`;
export const PYTHON_IDENTIFIER_RE = new RegExp(PYTHON_IDENTIFIER_PATTERN, 'u');
export const PYTHON_IDENTIFIER_GLOBAL_RE = new RegExp(PYTHON_IDENTIFIER_PATTERN, 'gu');
const identifier = new RegExp(`^(?:${PYTHON_IDENTIFIER_PATTERN})$`, 'u');
const continuation = /[_\p{XID_Continue}]/u;

export function isPythonIdentifier(value: string): boolean {
  return identifier.test(value);
}

export function lookupKeywordStart(text: string): number {
  let end = text.length;
  while (end > 0) {
    const low = text.charCodeAt(end - 1);
    const width = low >= 0xdc00 && low <= 0xdfff && end > 1 ? 2 : 1;
    if (!continuation.test(text.slice(end - width, end))) break;
    end -= width;
  }
  return end;
}

/** Content offset of the open single-line Python string at the cursor. */
export function openStringContentStart(text: string): number | undefined {
  let quote: string | undefined;
  let start: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote && char === '\\') { i++; continue; }
    if (quote && char === quote) { quote = undefined; start = undefined; }
    else if (!quote && (char === '"' || char === "'")) { quote = char; start = i + 1; }
    else if (!quote && char === '#') return undefined;
  }
  return start;
}

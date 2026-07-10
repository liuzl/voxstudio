export const sentenceEnders = "。！？；!?;.;।॥؟۔។៕။";

const clauseBreaks = new Set(Array.from("，、,：:；;—–…،؛၊"));
const closers = new Set(Array.from("\"'”’)）」』】》»"));
const abbreviations = new Set("mr mrs ms dr prof st vs etc fig no vol jr sr approx cf al".split(" "));
const joiners = new Set(["‌", "‍"]);

const charsPerSecond: Record<string, number> = {
  Latin: 18.3,
  Greek: 16.4,
  Cyrillic: 16.1,
  Myanmar: 15.2,
  Lao: 14.6,
  Devanagari: 14.4,
  Thai: 14.0,
  Khmer: 13.6,
  Hebrew: 12.5,
  Arabic: 11.0,
  Hangul: 7.9,
  Kana: 6.3,
  Han: 5.7,
};
const defaultRate = Math.min(...Object.values(charsPerSecond));

type Range = readonly [number, number];
const scriptRanges: ReadonlyArray<readonly [string, ReadonlyArray<Range>]> = [
  ["Han", [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2fa1f]]],
  ["Kana", [[0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9d]]],
  ["Hangul", [[0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7ff]]],
  ["Latin", [[0x0041, 0x024f], [0x1e00, 0x1eff], [0x2c60, 0x2c7f], [0xa720, 0xa7ff], [0xff21, 0xff3a], [0xff41, 0xff5a]]],
  ["Cyrillic", [[0x0400, 0x052f], [0x2de0, 0x2dff], [0xa640, 0xa69f]]],
  ["Greek", [[0x0370, 0x03ff], [0x1f00, 0x1fff]]],
  ["Arabic", [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]]],
  ["Hebrew", [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]]],
  ["Devanagari", [[0x0900, 0x097f], [0xa8e0, 0xa8ff]]],
  ["Thai", [[0x0e00, 0x0e7f]]],
  ["Lao", [[0x0e80, 0x0eff]]],
  ["Khmer", [[0x1780, 0x17ff], [0x19e0, 0x19ff]]],
  ["Myanmar", [[0x1000, 0x109f], [0xa9e0, 0xa9ff], [0xaa60, 0xaa7f]]],
];

const letterOrMark = /^[\p{L}\p{M}]$/u;
const mark = /^\p{M}$/u;
const alphanumeric = /^[\p{L}\p{N}]$/u;
const alphabetic = /^\p{L}$/u;
const digit = /^\p{Nd}$/u;
const droppedCategory = /^[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{So}\p{Sk}]$/u;

function isWhitespace(char: string): boolean {
  // Python's str.isspace includes NEL and the ASCII information separators;
  // ECMAScript's \s omits them.
  return /^[\s\u001c-\u001f\u0085]$/u.test(char);
}

function scriptOf(char: string): string | null {
  if (!letterOrMark.test(char)) return null;
  const point = char.codePointAt(0);
  if (point === undefined) return null;
  for (const [name, ranges] of scriptRanges) {
    if (ranges.some(([start, end]) => point >= start && point <= end)) return name;
  }
  return mark.test(char) ? null : "Other";
}

export function charSeconds(input: string): number[] {
  const chars = Array.from(input);
  const seconds = Array<number>(chars.length).fill(0);
  const unresolved: number[] = [];
  let current: string | null = null;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as string;
    const script = scriptOf(char);
    if (script === null) {
      if (current === null) unresolved.push(index);
      else seconds[index] = 1 / (charsPerSecond[current] ?? defaultRate);
      continue;
    }
    const rate = charsPerSecond[script] ?? defaultRate;
    for (const pending of unresolved) seconds[pending] = 1 / rate;
    unresolved.length = 0;
    current = script;
    seconds[index] = 1 / rate;
  }
  for (const pending of unresolved) seconds[pending] = 1 / defaultRate;
  return seconds;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/gu, "")
    .split(/[\s\u001c-\u001f\u0085]+/u)
    .filter(Boolean)
    .join(" ");
}

export function estSeconds(input: string): number {
  return charSeconds(normalizeWhitespace(input)).reduce((sum, value) => sum + value, 0);
}

function isVariationSelector(char: string): boolean {
  const point = char.codePointAt(0) ?? 0;
  return (point >= 0xfe00 && point <= 0xfe0f) || (point >= 0xe0100 && point <= 0xe01ef);
}

function joinsLetters(chars: string[], index: number): boolean {
  if (index === 0 || index + 1 === chars.length) return false;
  return letterOrMark.test(chars[index - 1] as string)
    && letterOrMark.test(chars[index + 1] as string);
}

export interface SanitizedText {
  text: string;
  dropped: string[];
}

export function sanitizeForTts(input: string): SanitizedText {
  const chars = Array.from(input);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as string;
    const keepJoiner = joiners.has(char) && joinsLetters(chars, index);
    const speakable = !isVariationSelector(char)
      && (isWhitespace(char) || !droppedCategory.test(char));
    (keepJoiner || speakable ? kept : dropped).push(char);
  }
  return { text: kept.join(""), dropped };
}

function periodEndsSentence(chars: string[], index: number): boolean {
  const next = chars[index + 1] ?? "";
  if (digit.test(next) || next === ".") return false;
  if (next && !isWhitespace(next) && !closers.has(next)) return false;

  let cursor = index - 1;
  while (cursor >= 0 && (alphanumeric.test(chars[cursor] as string) || chars[cursor] === ".")) {
    cursor -= 1;
  }
  const token = chars.slice(cursor + 1, index).join("");
  if (token.includes(".")) return false;
  if (Array.from(token).length === 1 && alphabetic.test(token)) return false;
  return !abbreviations.has(token.toLowerCase());
}

function sentenceBounds(chars: string[], enders: Set<string>): Array<readonly [number, number]> {
  const bounds: Array<readonly [number, number]> = [];
  let start = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as string;
    if (!enders.has(char) || (char === "." && !periodEndsSentence(chars, index))) continue;
    let end = index + 1;
    while (end < chars.length && closers.has(chars[end] as string)) end += 1;
    bounds.push([start, end]);
    start = end;
  }
  if (start < chars.length) bounds.push([start, chars.length]);
  return bounds;
}

function safeCut(chars: string[], position: number, initial: number): number {
  let index = initial;
  while (position < index && index < chars.length
      && (mark.test(chars[index] as string) || joiners.has(chars[index - 1] as string))) {
    index -= 1;
  }
  return Math.max(position + 1, index);
}

function breakIndex(chars: string[], position: number, high: number): number {
  const floor = position + Math.max(1, Math.floor((high - position) / 2));
  for (let index = high; index > floor; index -= 1) {
    if (clauseBreaks.has(chars[index - 1] as string)) return index;
  }
  for (let index = high; index > floor; index -= 1) {
    if (isWhitespace(chars[index - 1] as string)) return index - 1;
  }
  return safeCut(chars, position, high);
}

function bisectRight(values: number[], target: number, low: number, high: number): number {
  let lo = low;
  let hi = high;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (target < (values[middle] as number)) hi = middle;
    else lo = middle + 1;
  }
  return lo;
}

const spanTolerance = 1e-9;

export interface ChunkOptions {
  maxSeconds?: number;
  firstMaxSeconds?: number;
  growth?: number;
  enders?: string;
}

export function chunkText(input: string, options: ChunkOptions = {}): string[] {
  const text = normalizeWhitespace(input);
  if (!text) return [];
  const chars = Array.from(text);
  const maxSeconds = options.maxSeconds ?? 15;
  const growth = options.growth ?? 2;
  const enders = new Set(Array.from(options.enders ?? sentenceEnders));
  const costs = charSeconds(text);
  const prefix = [0];
  for (const cost of costs) prefix.push((prefix[prefix.length - 1] as number) + cost);
  const span = (start: number, end: number): number =>
    (prefix[end] as number) - (prefix[start] as number);
  const firstCap = options.firstMaxSeconds
    ? Math.min(options.firstMaxSeconds, maxSeconds)
    : maxSeconds;

  const chunks: string[] = [];
  let start: number | null = null;
  let previous = 0;
  const emit = (from: number, to: number): void => {
    chunks.push(chars.slice(from, to).join(""));
    previous = span(from, to);
  };
  const limit = (): number => chunks.length === 0
    ? firstCap
    : Math.min(maxSeconds, growth * previous);
  const exceeds = (value: number, cap: number): boolean =>
    value > cap * (1 + spanTolerance);
  const cutIndex = (position: number, end: number, cap: number): number => {
    let high = bisectRight(
      prefix,
      (prefix[position] as number) + cap * (1 + spanTolerance),
      position,
      end + 1,
    ) - 1;
    high = Math.min(Math.max(high, position + 1), end);
    return high >= end ? end : breakIndex(chars, position, high);
  };

  for (const [sentenceStart, sentenceEnd] of sentenceBounds(chars, enders)) {
    let position = sentenceStart;
    while (position < sentenceEnd) {
      if (start !== null) {
        if (!exceeds(span(start, sentenceEnd), limit())) break;
        emit(start, position);
        start = null;
        continue;
      }
      if (!exceeds(span(position, sentenceEnd), limit())) {
        start = position;
        break;
      }
      const cut = cutIndex(position, sentenceEnd, limit());
      emit(position, cut);
      position = cut;
    }
  }
  if (start !== null) emit(start, chars.length);
  return chunks;
}

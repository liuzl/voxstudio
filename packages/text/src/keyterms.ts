/**
 * Conservative post-ASR keyterm correction. ASR mishears product terms — voice ids
 * above all ("zliu" arrives as "li", "zf_001" as "ZF001" or "zf 001") — and the fix
 * belongs after the engine, not inside it: engine-agnostic, testable, and honest.
 *
 * Only ASCII-ish token spans are candidates (Chinese prose is never touched), and a
 * correction fires only when unambiguous:
 *   1. normalized equality (case/separator-insensitive): ZF001, "zf 001" -> zf_001;
 *   2. a short span (2–3 chars) contained in exactly one keyterm: zli -> zliu —
 *      contained in several ("li" with both zliu and legendliu in the bank) corrects
 *      nothing: ambiguity is the model's job to resolve by asking;
 *   3. a longer span within a tight edit distance (1 for ≥4 chars, 2 for ≥8) of
 *      exactly one keyterm.
 */

export interface KeytermCorrection {
  from: string;
  to: string;
}

const spanPattern = /[A-Za-z0-9]+(?:[ _\-.][A-Za-z0-9]+)*/g;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[ _\-.]/g, "");
}

/** Damerau (OSA) distance: adjacent transpositions cost 1 — the classic mishearing shape. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) (matrix[i] as number[])[0] = i;
  for (let j = 0; j < cols; j += 1) (matrix[0] as number[])[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (matrix[i - 1] as number[])[j] as number + 1,
        (matrix[i] as number[])[j - 1] as number + 1,
        (matrix[i - 1] as number[])[j - 1] as number + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (matrix[i - 2] as number[])[j - 2] as number + 1);
      }
      (matrix[i] as number[])[j] = value;
    }
  }
  return (matrix[rows - 1] as number[])[cols - 1] as number;
}

export function correctKeyterms(
  text: string,
  keyterms: string[],
): { text: string; corrections: KeytermCorrection[] } {
  const canonical = new Map<string, string>();
  for (const term of keyterms) {
    const key = normalize(term);
    if (key && !canonical.has(key)) canonical.set(key, term);
  }
  if (canonical.size === 0) return { text, corrections: [] };

  const corrections: KeytermCorrection[] = [];
  const corrected = text.replace(spanPattern, span => {
    const norm = normalize(span);
    if (norm.length < 2) return span;
    let target: string | undefined;
    const exact = canonical.get(norm);
    if (exact !== undefined) {
      target = exact;
    } else if (norm.length <= 3) {
      const containing = [...canonical.entries()].filter(([key]) => key.includes(norm));
      if (containing.length === 1) target = (containing[0] as [string, string])[1];
    } else {
      const budget = norm.length >= 8 ? 2 : 1;
      const near = [...canonical.entries()].filter(([key]) => editDistance(norm, key) <= budget);
      if (near.length === 1) target = (near[0] as [string, string])[1];
    }
    if (target === undefined || target === span) return span;
    corrections.push({ from: span, to: target });
    return target;
  });
  return { text: corrected, corrections };
}

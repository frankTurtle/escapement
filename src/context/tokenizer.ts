/**
 * The tokenizer port (ADR-0008).
 *
 * `exact` is the field that matters. A packer that does not know whether its
 * token counts are estimates will happily fill the window to 100% and get a
 * context-length error from the provider. Ours reads this flag and keeps a
 * safety margin when it is false.
 */
export type Tokenizer = {
  readonly name: string;
  /** True only for a real BPE tokenizer for the target model. */
  readonly exact: boolean;
  count(text: string): number;
  /** Longest prefix of `text` that counts at or below `maxTokens`. */
  truncate(text: string, maxTokens: number): string;
};

/**
 * Rough BPE-shaped estimate, with no dependency and no download.
 *
 * The model behind it: BPE merges runs of letters into subwords of roughly four
 * characters, while punctuation, symbols and digits usually stand alone. So we
 * count word-ish runs as `ceil(length / 4)` and charge one token per other
 * non-space character.
 *
 * **We do not claim an error bound.** We have not measured this against a real
 * BPE vocabulary, which is exactly why `exact` is `false` and why the packer
 * holds back a safety margin. If you need the window filled to the last token,
 * inject a real tokenizer — that is what the port is for.
 */
export const heuristicTokenizer: Tokenizer = {
  name: "heuristic",
  exact: false,
  count: countHeuristic,
  truncate: (text, maxTokens) => truncateBySearch(text, maxTokens, countHeuristic),
};

const WORDISH = /[A-Za-zÀ-ɏ]+/g;

function countHeuristic(text: string): number {
  if (text.length === 0) return 0;
  let tokens = 0;
  let wordChars = 0;

  for (const match of text.matchAll(WORDISH)) {
    wordChars += match[0].length;
    tokens += Math.ceil(match[0].length / 4);
  }

  // Everything that is not a letter and not whitespace: punctuation, digits,
  // braces, operators. BPE rarely merges these into neighbours, so one each.
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;
    if (isSpace) continue;
    other += 1;
  }
  other -= wordChars;

  return Math.max(1, tokens + Math.max(0, other));
}

/**
 * Binary search on the cut point. Works for any `count`, including an injected
 * exact tokenizer, and never overshoots — which is the only property the packer
 * actually depends on.
 */
export function truncateBySearch(text: string, maxTokens: number, count: (t: string) => number): string {
  if (maxTokens <= 0) return "";
  if (count(text) <= maxTokens) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (count(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** Wrap a raw counting function as a Tokenizer. The adapter seam for tiktoken. */
export function tokenizerFrom(name: string, count: (text: string) => number, exact = true): Tokenizer {
  return { name, exact, count, truncate: (text, max) => truncateBySearch(text, max, count) };
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { heuristicTokenizer, tokenizerFrom, truncateBySearch } from "../../src/context/tokenizer.ts";

describe("heuristic tokenizer", () => {
  test("declares itself inexact, which is what makes the packer keep a margin", () => {
    assert.equal(heuristicTokenizer.exact, false);
  });

  test("counts nothing for the empty string", () => {
    assert.equal(heuristicTokenizer.count(""), 0);
  });

  test("is monotonic: more text is never fewer tokens", () => {
    let previous = 0;
    const text = "The escapement converts continuous energy into discrete ticks, one at a time.";
    for (let i = 1; i <= text.length; i++) {
      const current = heuristicTokenizer.count(text.slice(0, i));
      assert.ok(current >= previous, `count fell at index ${i}`);
      previous = current;
    }
  });

  test("charges dense punctuation more than prose of the same length", () => {
    const prose = "the quick brown fox jumped over the lazy dog again and again today";
    const json = '{"a":1,"b":[2,3],"c":{"d":true},"e":null,"f":"g","h":4,"i":5}';
    assert.equal(prose.length > json.length, true);
    assert.ok(
      heuristicTokenizer.count(json) > heuristicTokenizer.count(prose) * 0.8,
      "JSON is denser per character than prose and the estimate should reflect that",
    );
  });

  test("is in the right ballpark for English prose", () => {
    const text = "Escapement is a deterministic agent orchestrator with a token budgeted context assembler.";
    const count = heuristicTokenizer.count(text);
    // ~4 characters per token is the usual rule of thumb for English.
    assert.ok(count >= text.length / 6 && count <= text.length / 2.5, `got ${count} for ${text.length} chars`);
  });
});

describe("truncate", () => {
  test("never exceeds the limit", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve thirteen";
    for (let limit = 0; limit <= 30; limit++) {
      const cut = heuristicTokenizer.truncate(text, limit);
      assert.ok(heuristicTokenizer.count(cut) <= limit, `limit ${limit} exceeded by "${cut}"`);
    }
  });

  test("returns the whole string when it already fits", () => {
    const text = "short";
    assert.equal(heuristicTokenizer.truncate(text, 1000), text);
  });

  test("returns empty for a non-positive limit", () => {
    assert.equal(heuristicTokenizer.truncate("anything", 0), "");
    assert.equal(heuristicTokenizer.truncate("anything", -5), "");
  });

  test("keeps a prefix, not an arbitrary substring", () => {
    const text = "alpha beta gamma delta epsilon";
    const cut = heuristicTokenizer.truncate(text, 4);
    assert.ok(text.startsWith(cut), `"${cut}" is not a prefix`);
  });

  test("finds the longest fitting prefix, not merely a fitting one", () => {
    const count = (t: string) => t.length; // one token per character
    const cut = truncateBySearch("abcdefghij", 4, count);
    assert.equal(cut, "abcd");
  });
});

describe("injected exact tokenizer", () => {
  test("is trusted, and the packer will then use the whole window", () => {
    const exact = tokenizerFrom("fake-bpe", (t) => t.split(/\s+/).filter(Boolean).length);
    assert.equal(exact.exact, true);
    assert.equal(exact.count("one two three"), 3);
    // The cut is character-exact, so it keeps the longest prefix that fits —
    // trailing whitespace included, since it costs nothing under this counter.
    assert.equal(exact.truncate("one two three", 2).trimEnd(), "one two");
    assert.equal(exact.count(exact.truncate("one two three", 2)), 2);
  });
});

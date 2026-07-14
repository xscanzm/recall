import { describe, expect, it } from "vitest";
import { searchQueryTerms, toLiteralFtsQuery } from "./MemorySearchRepository";

describe("MemorySearchRepository query parsing", () => {
  it("removes question filler and keeps useful Chinese fragments", () => {
    const terms = searchQueryTerms("上周研究那个工具的结论是什么？");
    expect(terms).toContain("研究");
    expect(terms).toContain("工具");
    expect(terms).toContain("结论");
    expect(terms).not.toContain("上周");
  });

  it("keeps ASCII tokens and escapes literal FTS quotes", () => {
    expect(searchQueryTerms("Recall parser FTS5")).toEqual(["recall", "parser", "fts5"]);
    expect(toLiteralFtsQuery('parser "edge"')).toBe('"parser" AND """edge"""');
  });

  it("allows time-only questions to search within the parsed range", () => {
    expect(searchQueryTerms("我昨天做了什么？")).toEqual([]);
  });
});

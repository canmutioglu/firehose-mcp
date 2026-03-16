import { describe, expect, test } from "vitest";

import { explainFirehoseQuery, validateFirehoseQuery } from "../src/query-validation.js";

describe("validateFirehoseQuery", () => {
  test("flags malformed recent filter and unbalanced quotes", () => {
    const result = validateFirehoseQuery('title:"tesla AND recent:soon');

    expect(result.isValid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("unbalanced_quotes");
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_recent_filter");
  });

  test("warns about publish_time escaping and url wildcard escaping", () => {
    const result = validateFirehoseQuery(
      "publish_time:[2025-01-01T00:00:00 TO 2025-12-31T23:59:59] AND url:*\/category\/*",
    );

    expect(result.isValid).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain("publish_time_escape");
    expect(result.issues.map((issue) => issue.code)).toContain("url_wildcard_escape");
  });
});

describe("explainFirehoseQuery", () => {
  test("includes Firehose-specific guidance", () => {
    const explanation = explainFirehoseQuery('title:tesla AND url:/.*\\/page\\/[0-9]+.*/');

    expect(explanation.some((line) => line.includes("added field"))).toBe(true);
    expect(explanation.some((line) => line.includes("keyword fields"))).toBe(true);
    expect(explanation.some((line) => line.includes("\\/"))).toBe(true);
  });
});

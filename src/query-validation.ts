import { QueryValidationIssue, QueryValidationResult } from "./types.js";

const KEYWORD_FIELDS = new Set([
  "url",
  "domain",
  "publish_time",
  "page_category",
  "page_type",
  "language",
]);

const TEXT_FIELDS = new Set([
  "added",
  "removed",
  "added_anchor",
  "removed_anchor",
  "title",
]);

const ALL_FIELDS = new Set([...KEYWORD_FIELDS, ...TEXT_FIELDS, "recent"]);

const RECENT_PATTERN = /\brecent:(\d+)(h|d|mo)\b/g;
const FIELD_PATTERN = /\b([a-z_]+):/g;
const URL_WILDCARD_PATTERN = /\burl:([^\s"]*[?*][^\s"]*)/g;
const URL_REGEX_PATTERN = /\burl:(\/.*?\/)/g;
const PUBLISH_TIME_PATTERN =
  /\bpublish_time:(?:\[[^\]]+\]|\{[^}]+\}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s)]+)/g;

export function validateFirehoseQuery(query: string): QueryValidationResult {
  const issues: QueryValidationIssue[] = [];
  const detectedFields = collectFields(query);

  for (const field of detectedFields) {
    if (!ALL_FIELDS.has(field)) {
      issues.push({
        severity: "warning",
        code: "unknown_field",
        message: `Unknown field "${field}". Firehose may reject or ignore it.`,
      });
    }
  }

  if (hasUnbalancedQuotes(query)) {
    issues.push({
      severity: "error",
      code: "unbalanced_quotes",
      message: "The query has an unmatched double quote.",
    });
  }

  if (hasUnbalancedParentheses(query)) {
    issues.push({
      severity: "error",
      code: "unbalanced_parentheses",
      message: "The query has unbalanced parentheses.",
    });
  }

  const recentMatches = [...query.matchAll(RECENT_PATTERN)];
  if (query.includes("recent:") && recentMatches.length === 0) {
    issues.push({
      severity: "error",
      code: "invalid_recent_filter",
      message: 'The "recent" filter must use a positive integer followed by h, d, or mo.',
    });
  }

  for (const match of query.matchAll(PUBLISH_TIME_PATTERN)) {
    const snippet = match[0];
    if (snippet.includes(":") && !snippet.includes("\\:")) {
      issues.push({
        severity: "warning",
        code: "publish_time_escape",
        message:
          'publish_time values should escape colons as "\\:" in Lucene queries.',
      });
      break;
    }
  }

  for (const match of query.matchAll(URL_WILDCARD_PATTERN)) {
    const value = match[1] ?? "";
    if (value.includes("/") && !value.includes("\\/")) {
      issues.push({
        severity: "warning",
        code: "url_wildcard_escape",
        message:
          'Wildcard url queries should escape forward slashes as "\\/".',
      });
      break;
    }
  }

  for (const match of query.matchAll(URL_REGEX_PATTERN)) {
    const value = match[1] ?? "";
    if (value.includes("/") && !value.includes("\\/")) {
      issues.push({
        severity: "warning",
        code: "url_regex_escape",
        message:
          'Regex url queries should escape forward slashes as "\\/" inside /.../.',
      });
      break;
    }
  }

  if (query.includes("quality:false")) {
    issues.push({
      severity: "warning",
      code: "quality_in_query",
      message:
        'The "quality" flag is not part of the Lucene query. Set it on the rule object instead.',
    });
  }

  if (query.includes("nsfw:true") || query.includes("nsfw:false")) {
    issues.push({
      severity: "warning",
      code: "nsfw_in_query",
      message:
        'The "nsfw" flag is not part of the Lucene query. Set it on the rule object instead.',
    });
  }

  for (const field of detectedFields) {
    if (KEYWORD_FIELDS.has(field)) {
      issues.push({
        severity: "info",
        code: "keyword_field_case_sensitive",
        message: `Field "${field}" is keyword-based and must match exact case-sensitive values.`,
      });
    }
  }

  return {
    isValid: !issues.some((issue) => issue.severity === "error"),
    issues: dedupeIssues(issues),
    detectedFields,
  };
}

export function explainFirehoseQuery(query: string): string[] {
  const fields = collectFields(query);
  const lines = [
    "Bare terms search the added field by default.",
    "Text fields are tokenized and case-insensitive: added, removed, added_anchor, removed_anchor, title.",
    "Keyword fields are exact and case-sensitive: url, domain, publish_time, page_category, page_type, language.",
    'The recent filter is query-level syntax such as "recent:24h".',
  ];

  if (fields.some((field) => KEYWORD_FIELDS.has(field))) {
    lines.push(
      "This query uses keyword fields, so exact values and escaping matter.",
    );
  }

  if (query.includes("url:")) {
    lines.push(
      'For wildcard or regex URL queries, escape forward slashes as "\\/".',
    );
  }

  if (query.includes("publish_time:")) {
    lines.push(
      'For publish_time queries, escape colons in timestamps as "\\:".',
    );
  }

  if (!query.includes("recent:")) {
    lines.push(
      "No recency filter is present, so older matching pages may also be returned.",
    );
  }

  return lines;
}

function collectFields(query: string): string[] {
  return [...query.matchAll(FIELD_PATTERN)]
    .map((match) => match[1])
    .filter((field): field is string => Boolean(field))
    .filter((field, index, values) => values.indexOf(field) === index);
}

function hasUnbalancedQuotes(query: string): boolean {
  let escaped = false;
  let count = 0;
  for (const char of query) {
    if (char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === '"' && !escaped) {
      count += 1;
    }
    escaped = false;
  }
  return count % 2 !== 0;
}

function hasUnbalancedParentheses(query: string): boolean {
  let depth = 0;
  let escaped = false;
  let inQuotes = false;

  for (const char of query) {
    if (char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === '"' && !escaped) {
      inQuotes = !inQuotes;
    }
    if (!inQuotes) {
      if (char === "(") {
        depth += 1;
      }
      if (char === ")") {
        depth -= 1;
      }
      if (depth < 0) {
        return true;
      }
    }
    escaped = false;
  }

  return depth !== 0;
}

function dedupeIssues(issues: QueryValidationIssue[]): QueryValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}:${issue.code}:${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

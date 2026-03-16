#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { FirehoseClient } from "./firehose-client.js";
import { explainFirehoseQuery, validateFirehoseQuery } from "./query-validation.js";
import { FirehoseDocument, FirehoseSseEvent, ServerRuntimeConfig } from "./types.js";

const MAX_REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_REPLAY_WINDOW_LABEL = "24h";

const validationSchema = z.object({
  is_valid: z.boolean(),
  detected_fields: z.array(z.string()),
  issues: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      code: z.string(),
      message: z.string(),
    }),
  ),
});

const ruleSchema = z.object({
  id: z.string(),
  value: z.string(),
  tag: z.string().optional(),
  nsfw: z.boolean().optional(),
  quality: z.boolean().optional(),
});

const tapSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string().optional(),
  token_prefix: z.string().optional(),
  rules_count: z.number().optional(),
  last_used_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
});

const documentSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  publish_time: z.string().optional(),
  diff: z
    .object({
      chunks: z.array(
        z.object({
          typ: z.enum(["ins", "del"]),
          text: z.string(),
        }),
      ),
    })
    .optional(),
  page_category: z.array(z.string()).optional(),
  page_types: z.array(z.string()).optional(),
  language: z.string().optional(),
  markdown: z.string().optional(),
});

const streamUpdateSchema = z.object({
  id: z.string().optional(),
  tap_id: z.string(),
  query_id: z.string(),
  matched_at: z.string(),
  document: documentSchema,
});

export function buildServer(): McpServer {
  const credentials = {
    managementKey: normalizeEnv(process.env.FIREHOSE_MANAGEMENT_KEY),
    tapToken: normalizeEnv(process.env.FIREHOSE_TAP_TOKEN),
    defaultTapId: normalizeEnv(process.env.FIREHOSE_DEFAULT_TAP_ID),
  };

  const client = new FirehoseClient(credentials);
  const runtimeConfig: ServerRuntimeConfig = {
    credentials,
    availableAuthModes: [
      ...(client.hasManagementKey() ? (["management"] as const) : []),
      ...(client.hasTapToken() ? (["tap"] as const) : []),
    ],
  };

  const server = new McpServer({
    name: "firehose-mcp",
    version: "0.2.0",
  });

  registerUtilityTools(server, client, runtimeConfig);
  registerRulePrompts(server);

  if (client.hasManagementKey()) {
    registerTapTools(server, client);
  }

  if (client.hasManagementKey() || client.hasTapToken()) {
    registerRuleTools(server, client);
    registerStreamTool(server, client);
  }

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("firehose-mcp is running on stdio");
}

function registerUtilityTools(
  server: McpServer,
  client: FirehoseClient,
  runtimeConfig: ServerRuntimeConfig,
): void {
  server.registerTool(
    "server_status",
    {
      description:
        "Describe the current Firehose MCP configuration, available credentials, and enabled tools.",
      outputSchema: {
        available_auth_modes: z.array(z.enum(["management", "tap"])),
        default_tap_id: z.string().optional(),
        tap_resolution_strategy: z.string(),
        enabled_tools: z.array(z.string()),
        enabled_prompts: z.array(z.string()),
        stream_scope: z.string(),
      },
    },
    async () => {
      const enabledTools = [
        "server_status",
        "validate_query",
        "explain_query",
        ...(client.hasManagementKey()
          ? ["list_taps", "create_tap", "get_tap", "update_tap", "revoke_tap"]
          : []),
        ...(client.hasManagementKey() || client.hasTapToken()
          ? [
              "list_rules",
              "create_rule",
              "get_rule",
              "update_rule",
              "delete_rule",
              "stream_events",
            ]
          : []),
      ];
      const enabledPrompts = ["draft_firehose_rule", "debug_firehose_query"];

      const structuredContent = {
        available_auth_modes: runtimeConfig.availableAuthModes,
        default_tap_id: runtimeConfig.credentials.defaultTapId,
        tap_resolution_strategy: describeTapResolution(runtimeConfig),
        enabled_tools: enabledTools,
        enabled_prompts: enabledPrompts,
        stream_scope:
          "stream_events mirrors Firehose SSE and replay semantics only. It is not a durable match-history or analytics endpoint.",
      };

      return successResult(
        structuredContent,
        [
          `Auth modes: ${structuredContent.available_auth_modes.join(", ") || "none"}`,
          `Default tap id: ${structuredContent.default_tap_id ?? "not set"}`,
          `Tap resolution: ${structuredContent.tap_resolution_strategy}`,
          `Enabled tools: ${structuredContent.enabled_tools.join(", ")}`,
          `Enabled prompts: ${structuredContent.enabled_prompts.join(", ")}`,
          `Stream scope: ${structuredContent.stream_scope}`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "validate_query",
    {
      description:
        "Run local validation and heuristics for a Firehose Lucene query before creating or updating a rule.",
      inputSchema: {
        query: z.string().min(1).describe("Lucene query to validate."),
      },
      outputSchema: validationSchema,
    },
    async ({ query }) => {
      const result = validateFirehoseQuery(query);
      return successResult(
        {
          is_valid: result.isValid,
          detected_fields: result.detectedFields,
          issues: result.issues,
        },
        JSON.stringify(result, null, 2),
      );
    },
  );

  server.registerTool(
    "explain_query",
    {
      description:
        "Explain how Firehose will interpret a Lucene query, including exact-match fields and escaping caveats.",
      inputSchema: {
        query: z.string().min(1).describe("Lucene query to explain."),
      },
      outputSchema: {
        explanation: z.array(z.string()),
        validation: validationSchema,
      },
    },
    async ({ query }) => {
      const validation = validateFirehoseQuery(query);
      const explanation = explainFirehoseQuery(query);
      return successResult(
        {
          explanation,
          validation: {
            is_valid: validation.isValid,
            detected_fields: validation.detectedFields,
            issues: validation.issues,
          },
        },
        [...explanation, "", JSON.stringify(validation, null, 2)].join("\n"),
      );
    },
  );
}

function registerTapTools(server: McpServer, client: FirehoseClient): void {
  server.registerTool(
    "list_taps",
    {
      description:
        "List taps available to the management key. Tokens are redacted by default.",
      inputSchema: {
        include_tokens: z
          .boolean()
          .default(false)
          .describe("Include full tap tokens in the response."),
        force_fresh: z
          .boolean()
          .default(false)
          .describe("Bypass the short in-memory cache."),
      },
      outputSchema: {
        taps: z.array(tapSchema),
      },
    },
    async ({ include_tokens, force_fresh }) => {
      const taps = await client.listTaps(force_fresh);
      const structuredContent = {
        taps: taps.map((tap) =>
          include_tokens ? tap : { ...tap, token: undefined },
        ),
      };
      return successResult(structuredContent, JSON.stringify(structuredContent, null, 2));
    },
  );

  server.registerTool(
    "create_tap",
    {
      description: "Create a new Firehose tap.",
      inputSchema: {
        name: z.string().min(1).describe("Human-readable tap name."),
      },
      outputSchema: {
        tap: tapSchema.omit({ token: true, rules_count: true, last_used_at: true }),
        token: z.string().optional(),
      },
    },
    async ({ name }) => {
      const response = await client.createTap(name);
      return successResult(
        { tap: response.data, token: response.token },
        JSON.stringify({ tap: response.data, token: response.token }, null, 2),
      );
    },
  );

  server.registerTool(
    "get_tap",
    {
      description: "Get a single Firehose tap by id.",
      inputSchema: {
        tap_id: z.string().min(1).describe("Tap UUID."),
        include_token: z
          .boolean()
          .default(false)
          .describe("Include the full tap token when available."),
      },
      outputSchema: {
        tap: tapSchema,
      },
    },
    async ({ tap_id, include_token }) => {
      const tap = await client.getTap(tap_id, { includeToken: include_token });
      return successResult(
        { tap: include_token ? tap : { ...tap, token: undefined } },
        JSON.stringify(include_token ? tap : { ...tap, token: undefined }, null, 2),
      );
    },
  );

  server.registerTool(
    "update_tap",
    {
      description: "Rename an existing Firehose tap.",
      inputSchema: {
        tap_id: z.string().min(1).describe("Tap UUID."),
        name: z.string().min(1).describe("New tap name."),
      },
      outputSchema: {
        tap: tapSchema.omit({ token: true }),
      },
    },
    async ({ tap_id, name }) => {
      const tap = await client.updateTap(tap_id, name);
      return successResult({ tap }, JSON.stringify(tap, null, 2));
    },
  );

  server.registerTool(
    "revoke_tap",
    {
      description: "Revoke a Firehose tap permanently.",
      inputSchema: {
        tap_id: z.string().min(1).describe("Tap UUID."),
      },
      outputSchema: {
        revoked: z.boolean(),
        tap_id: z.string(),
      },
    },
    async ({ tap_id }) => {
      await client.revokeTap(tap_id);
      return successResult(
        { revoked: true, tap_id },
        `Tap ${tap_id} was revoked.`,
      );
    },
  );
}

function registerRuleTools(server: McpServer, client: FirehoseClient): void {
  server.registerTool(
    "list_rules",
    {
      description:
        "List rules for a tap. If no tap_id is supplied, the server uses FIREHOSE_TAP_TOKEN or resolves a single/default tap via management key.",
      inputSchema: {
        tap_id: z.string().optional().describe("Tap UUID to target."),
      },
      outputSchema: {
        tap_id: z.string().optional(),
        resolved_via: z.enum(["env", "management_key"]),
        count: z.number().optional(),
        rules: z.array(ruleSchema),
      },
    },
    async ({ tap_id }) => {
      const { rules, tap, count } = await client.listRules(tap_id);
      return successResult(
        {
          tap_id: tap.tapId,
          resolved_via: tap.source,
          count,
          rules,
        },
        JSON.stringify({ tap, count, rules }, null, 2),
      );
    },
  );

  server.registerTool(
    "create_rule",
    {
      description: "Create a Firehose Lucene rule for a tap.",
      inputSchema: {
        tap_id: z.string().optional().describe("Tap UUID to target."),
        value: z.string().min(1).describe("Lucene query."),
        tag: z.string().max(255).optional().describe("Optional label."),
        nsfw: z
          .boolean()
          .default(false)
          .describe("Include adult content in results."),
        quality: z
          .boolean()
          .default(true)
          .describe("Apply Firehose quality filters."),
        validate_query: z
          .boolean()
          .default(true)
          .describe("Run local query validation before sending the request."),
      },
      outputSchema: {
        tap_id: z.string().optional(),
        resolved_via: z.enum(["env", "management_key"]),
        validation: validationSchema.optional(),
        rule: ruleSchema,
      },
    },
    async ({ tap_id, value, tag, nsfw, quality, validate_query }) => {
      const validation = maybeValidate(value, validate_query);
      const { rule, tap } = await client.createRule(
        { value, tag, nsfw, quality },
        tap_id,
      );
      return successResult(
        {
          tap_id: tap.tapId,
          resolved_via: tap.source,
          validation,
          rule,
        },
        JSON.stringify({ tap, validation, rule }, null, 2),
      );
    },
  );

  server.registerTool(
    "get_rule",
    {
      description: "Get a single Firehose rule by id.",
      inputSchema: {
        tap_id: z.string().optional().describe("Tap UUID to target."),
        rule_id: z.string().min(1).describe("Rule id."),
      },
      outputSchema: {
        tap_id: z.string().optional(),
        resolved_via: z.enum(["env", "management_key"]),
        rule: ruleSchema,
      },
    },
    async ({ tap_id, rule_id }) => {
      const { rule, tap } = await client.getRule(rule_id, tap_id);
      return successResult(
        {
          tap_id: tap.tapId,
          resolved_via: tap.source,
          rule,
        },
        JSON.stringify({ tap, rule }, null, 2),
      );
    },
  );

  server.registerTool(
    "update_rule",
    {
      description: "Update one or more fields on a Firehose rule.",
      inputSchema: {
        tap_id: z.string().optional().describe("Tap UUID to target."),
        rule_id: z.string().min(1).describe("Rule id."),
        value: z.string().min(1).optional().describe("Updated Lucene query."),
        tag: z.string().max(255).optional().describe("Updated label."),
        nsfw: z.boolean().optional().describe("Updated nsfw flag."),
        quality: z.boolean().optional().describe("Updated quality flag."),
        validate_query: z
          .boolean()
          .default(true)
          .describe("Run local query validation when value is supplied."),
      },
      outputSchema: {
        tap_id: z.string().optional(),
        resolved_via: z.enum(["env", "management_key"]),
        validation: validationSchema.optional(),
        rule: ruleSchema,
      },
    },
    async ({ tap_id, rule_id, value, tag, nsfw, quality, validate_query }) => {
      if (
        value === undefined &&
        tag === undefined &&
        nsfw === undefined &&
        quality === undefined
      ) {
        throw new Error("At least one field must be supplied to update_rule.");
      }

      const validation = value ? maybeValidate(value, validate_query) : undefined;
      const { rule, tap } = await client.updateRule(
        rule_id,
        { value, tag, nsfw, quality },
        tap_id,
      );
      return successResult(
        {
          tap_id: tap.tapId,
          resolved_via: tap.source,
          validation,
          rule,
        },
        JSON.stringify({ tap, validation, rule }, null, 2),
      );
    },
  );

  server.registerTool(
    "delete_rule",
    {
      description: "Delete a Firehose rule.",
      inputSchema: {
        tap_id: z.string().optional().describe("Tap UUID to target."),
        rule_id: z.string().min(1).describe("Rule id."),
      },
      outputSchema: {
        deleted: z.boolean(),
        tap_id: z.string().optional(),
        resolved_via: z.enum(["env", "management_key"]),
        rule_id: z.string(),
      },
    },
    async ({ tap_id, rule_id }) => {
      const tap = await client.deleteRule(rule_id, tap_id);
      return successResult(
        {
          deleted: true,
          tap_id: tap.tapId,
          resolved_via: tap.source,
          rule_id,
        },
        `Rule ${rule_id} was deleted.`,
      );
    },
  );
}

function registerStreamTool(server: McpServer, client: FirehoseClient): void {
  server.registerTool(
    "stream_events",
    {
      description:
        "Read a bounded Firehose SSE batch. This mirrors Firehose stream and replay behavior only; it is not a durable history endpoint.",
      inputSchema: {
        tap_id: z.string().optional().describe("Tap UUID to target."),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(30)
          .describe("Server-side SSE timeout in seconds."),
        since: z
          .string()
          .optional()
          .describe(
            'Replay buffered events from a relative window up to "24h", such as "5m", "1h", or "24h". This is Firehose replay, not durable history.',
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Start from an exact Kafka offset."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(100)
          .describe("Close the stream after this many matching events."),
        last_event_id: z
          .string()
          .optional()
          .describe('Resume from the next event after an SSE id like "0-43368".'),
        include_markdown: z
          .boolean()
          .default(false)
          .describe("Include page markdown in returned update payloads."),
        markdown_max_chars: z
          .number()
          .int()
          .min(128)
          .max(50000)
          .default(4000)
          .describe("Maximum markdown characters when include_markdown is true."),
      },
      outputSchema: {
        tap_id: z.string().optional(),
        resolved_via: z.enum(["env", "management_key"]),
        next_cursor: z.string().optional(),
        replay_mode: z.enum(["live", "since", "offset", "last_event_id"]),
        scope_note: z.string(),
        connected_events: z.number(),
        update_count: z.number(),
        error_count: z.number(),
        end_events: z.number(),
        errors: z.array(
          z.object({
            id: z.string().optional(),
            message: z.string(),
          }),
        ),
        updates: z.array(streamUpdateSchema),
      },
    },
    async ({
      tap_id,
      timeout_seconds,
      since,
      offset,
      limit,
      last_event_id,
      include_markdown,
      markdown_max_chars,
    }) => {
      if (since) {
        validateReplayWindow(since);
      }

      const { events, tap, nextCursor } = await client.streamEvents({
        tapId: tap_id,
        timeoutSeconds: timeout_seconds,
        since,
        offset,
        limit,
        lastEventId: last_event_id,
      });

      const connectedEvents = events.filter((event) => event.event === "connected").length;
      const errorEvents = events.filter((event) => event.event === "error");
      const endEvents = events.filter((event) => event.event === "end").length;
      const updateEvents = events
        .filter(
          (event): event is Extract<FirehoseSseEvent, { event: "update" }> =>
            event.event === "update",
        )
        .map((event) => ({
          id: event.id,
          tap_id: event.data.tap_id,
          query_id: event.data.query_id,
          matched_at: event.data.matched_at,
          document: sanitizeDocument(
            event.data.document,
            include_markdown,
            markdown_max_chars,
          ),
        }));

      const structuredContent = {
        tap_id: tap.tapId,
        resolved_via: tap.source,
        next_cursor: nextCursor,
        replay_mode: last_event_id
          ? "last_event_id"
          : offset !== undefined
            ? "offset"
            : since
              ? "since"
              : "live",
        scope_note:
          "This output is a bounded Firehose stream read. Empty replay results mean the replay buffer did not return events for that request; they do not prove durable historical absence.",
        connected_events: connectedEvents,
        update_count: updateEvents.length,
        error_count: errorEvents.length,
        end_events: endEvents,
        errors: errorEvents.map((event) => ({
          id: event.id,
          message: event.data.message,
        })),
        updates: updateEvents,
      };

      return successResult(
        structuredContent,
        JSON.stringify(structuredContent, null, 2),
      );
    },
  );
}

function registerRulePrompts(server: McpServer): void {
  server.registerPrompt(
    "draft_firehose_rule",
    {
      description: "Help the model draft a Firehose rule from a monitoring goal.",
      argsSchema: {
        goal: z.string().describe("What should the rule catch?"),
        domains: z
          .string()
          .optional()
          .describe("Optional exact domains to include or exclude."),
        recency: z
          .string()
          .optional()
          .describe('Optional recent filter like "24h" or "7d".'),
      },
    },
    async ({ goal, domains, recency }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Draft a Firehose Lucene rule.",
              `Goal: ${goal}`,
              domains ? `Domain hints: ${domains}` : undefined,
              recency ? `Preferred recency: ${recency}` : undefined,
              "Use Firehose semantics: bare terms search added, keyword fields are exact/case-sensitive, recent is query syntax, quality/nsfw are rule object fields.",
              "Return a proposed query, why it works, likely false positives, and one stricter variant.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "debug_firehose_query",
    {
      description:
        "Help the model debug a Firehose rule that is too broad, too narrow, or not matching.",
      argsSchema: {
        query: z.string().describe("Current Firehose Lucene query."),
        symptom: z.string().describe("What is going wrong with the query?"),
        sample_url: z
          .string()
          .optional()
          .describe("Optional example URL that should match or be excluded."),
      },
    },
    async ({ query, symptom, sample_url }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Debug this Firehose Lucene query.",
              `Query: ${query}`,
              `Symptom: ${symptom}`,
              sample_url ? `Sample URL: ${sample_url}` : undefined,
              "Check Firehose-specific pitfalls: keyword field exactness, URL slash escaping, publish_time colon escaping, recent syntax, and the fact that quality/nsfw are rule flags not Lucene terms.",
              "Return: diagnosis, corrected query, and a short explanation of the fix.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );
}

function maybeValidate(value: string, shouldValidate: boolean) {
  if (!shouldValidate) {
    return undefined;
  }

  const validation = validateFirehoseQuery(value);
  if (!validation.isValid) {
    throw new Error(
      [
        "Local query validation failed.",
        ...validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `- ${issue.message}`),
      ].join("\n"),
    );
  }

  return {
    is_valid: validation.isValid,
    detected_fields: validation.detectedFields,
    issues: validation.issues,
  };
}

function successResult<T extends Record<string, unknown>>(
  structuredContent: T,
  text: string,
) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function normalizeEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function describeTapResolution(config: ServerRuntimeConfig): string {
  if (config.credentials.tapToken) {
    return "Use FIREHOSE_TAP_TOKEN by default; fall back to management key resolution when a tap_id override is supplied.";
  }
  if (config.credentials.managementKey) {
    return "Resolve tap tokens through the management key. If multiple taps exist, use FIREHOSE_DEFAULT_TAP_ID or pass tap_id.";
  }
  return "No Firehose credentials configured. Only local query helper tools are available.";
}

function sanitizeDocument(
  document: FirehoseDocument,
  includeMarkdown: boolean,
  markdownMaxChars: number,
): FirehoseDocument {
  const markdown = document.markdown
    ? includeMarkdown
      ? truncate(document.markdown, markdownMaxChars)
      : undefined
    : undefined;

  return {
    ...document,
    markdown,
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function validateReplayWindow(since: string): number {
  const sinceMs = relativeDurationToMs(since);

  if (!sinceMs) {
    throw new Error('since must be a positive relative duration such as "10m", "1h", or "24h".');
  }

  if (sinceMs > MAX_REPLAY_WINDOW_MS) {
    throw new Error(
      `since must be ${MAX_REPLAY_WINDOW_LABEL} or less because Firehose's replay buffer currently supports up to ${MAX_REPLAY_WINDOW_LABEL} of history for replay requests.`,
    );
  }

  return sinceMs;
}

function relativeDurationToMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)(mo|m|h|d)$/i);
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isInteger(amount) || amount <= 0) {
    return undefined;
  }

  switch (unit) {
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    case "d":
      return amount * 86_400_000;
    case "mo":
      return amount * 30 * 86_400_000;
    default:
      return undefined;
  }
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error("firehose-mcp failed:", error);
    process.exit(1);
  });
}

function isEntrypoint(moduleUrl: string): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  return pathToFileURL(entryArg).href === moduleUrl;
}

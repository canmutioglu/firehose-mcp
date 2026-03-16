import { afterEach, describe, expect, test, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../src/index.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(
  events: Array<{ event: string; data: unknown; id?: string }>,
): Response {
  const body = events
    .map((event) =>
      [
        event.id ? `id: ${event.id}` : undefined,
        `event: ${event.event}`,
        `data: ${JSON.stringify(event.data)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  return new Response(`${body}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function connectServer() {
  const server = buildServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { server, client };
}

describe.sequential("buildServer", () => {
  afterEach(() => {
    delete process.env.FIREHOSE_MANAGEMENT_KEY;
    delete process.env.FIREHOSE_TAP_TOKEN;
    delete process.env.FIREHOSE_DEFAULT_TAP_ID;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("exposes only utility tools with no credentials", async () => {
    const { server, client } = await connectServer();

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toEqual(["server_status", "validate_query", "explain_query"]);

    await client.close();
    await server.close();
  });

  test("exposes tap, rule, and raw stream tools with the narrowed scope", async () => {
    process.env.FIREHOSE_MANAGEMENT_KEY = "fhm_key";
    process.env.FIREHOSE_TAP_TOKEN = "fh_token";

    const { server, client } = await connectServer();

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toEqual([
      "server_status",
      "validate_query",
      "explain_query",
      "list_taps",
      "create_tap",
      "get_tap",
      "update_tap",
      "revoke_tap",
      "list_rules",
      "create_rule",
      "get_rule",
      "update_rule",
      "delete_rule",
      "stream_events",
    ]);

    const status = await client.callTool({
      name: "server_status",
      arguments: {},
    });

    expect(status.isError).toBeFalsy();
    expect(status.structuredContent).toMatchObject({
      available_auth_modes: ["management", "tap"],
      enabled_tools: expect.arrayContaining(["stream_events"]),
      stream_scope:
        "stream_events mirrors Firehose SSE and replay semantics only. It is not a durable match-history or analytics endpoint.",
    });

    await client.close();
    await server.close();
  });

  test("lists taps through the MCP interface with redacted tokens by default", async () => {
    process.env.FIREHOSE_MANAGEMENT_KEY = "fhm_key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/taps")) {
          return jsonResponse({
            data: [
              {
                id: "tap-1",
                name: "Brand Links",
                token: "fh_full_token",
                token_prefix: "fh_pref",
                rules_count: 3,
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { server, client } = await connectServer();
    const result = await client.callTool({
      name: "list_taps",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      taps: [
        {
          id: "tap-1",
          name: "Brand Links",
          token_prefix: "fh_pref",
          rules_count: 3,
        },
      ],
    });

    await client.close();
    await server.close();
  });

  test("lists rules through the MCP interface when a tap token is configured", async () => {
    process.env.FIREHOSE_TAP_TOKEN = "fh_env_token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/rules")) {
          return jsonResponse({
            data: [{ id: "1", value: "tesla", tag: "brand" }],
            meta: { count: 1 },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { server, client } = await connectServer();
    const result = await client.callTool({
      name: "list_rules",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      resolved_via: "env",
      count: 1,
      rules: [{ id: "1", value: "tesla", tag: "brand" }],
    });

    await client.close();
    await server.close();
  });

  test("create_rule runs local validation before sending the request", async () => {
    process.env.FIREHOSE_TAP_TOKEN = "fh_env_token";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/rules")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(
          JSON.stringify({
            value: 'title:"openai"',
            tag: "brand",
            nsfw: false,
            quality: true,
          }),
        );
        return jsonResponse({
          data: {
            id: "rule-1",
            value: 'title:"openai"',
            tag: "brand",
            nsfw: false,
            quality: true,
          },
        }, 201);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, client } = await connectServer();
    const result = await client.callTool({
      name: "create_rule",
      arguments: {
        value: 'title:"openai"',
        tag: "brand",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      resolved_via: "env",
      rule: {
        id: "rule-1",
        value: 'title:"openai"',
        tag: "brand",
      },
      validation: {
        is_valid: true,
      },
    });

    await client.close();
    await server.close();
  });

  test("stream_events returns raw stream batches with explicit scope note", async () => {
    process.env.FIREHOSE_TAP_TOKEN = "fh_env_token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/stream?timeout=30&since=10m&limit=2")) {
          return sseResponse([
            { event: "connected", data: {} },
            {
              id: "0-10",
              event: "update",
              data: {
                tap_id: "tap-1",
                query_id: "rule-1",
                matched_at: "2026-03-16T12:00:00Z",
                document: {
                  url: "https://example.com/a",
                  title: "Example",
                  markdown: "hello world",
                },
              },
            },
            {
              id: "0-11",
              event: "error",
              data: {
                message: "temporary error",
              },
            },
            { event: "end", data: {} },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { server, client } = await connectServer();
    const result = await client.callTool({
      name: "stream_events",
      arguments: {
        since: "10m",
        limit: 2,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      resolved_via: "env",
      replay_mode: "since",
      scope_note:
        "This output is a bounded Firehose stream read. Empty replay results mean the replay buffer did not return events for that request; they do not prove durable historical absence.",
      connected_events: 1,
      update_count: 1,
      error_count: 1,
      end_events: 1,
      errors: [{ id: "0-11", message: "temporary error" }],
      updates: [
        {
          id: "0-10",
          query_id: "rule-1",
          document: {
            url: "https://example.com/a",
            title: "Example",
          },
        },
      ],
    });
    expect(
      (result.structuredContent as { updates: Array<{ document: { markdown?: string } }> }).updates[0]?.document
        .markdown,
    ).toBeUndefined();

    await client.close();
    await server.close();
  });

  test("stream_events can include truncated markdown", async () => {
    process.env.FIREHOSE_TAP_TOKEN = "fh_env_token";
    const markdown = "a".repeat(140);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/stream?timeout=30&limit=1")) {
          return sseResponse([
            {
              id: "0-10",
              event: "update",
              data: {
                tap_id: "tap-1",
                query_id: "rule-1",
                matched_at: "2026-03-16T12:00:00Z",
                document: {
                  url: "https://example.com/a",
                  markdown,
                },
              },
            },
          ]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { server, client } = await connectServer();
    const result = await client.callTool({
      name: "stream_events",
      arguments: {
        limit: 1,
        include_markdown: true,
        markdown_max_chars: 128,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { updates: Array<{ document: { markdown?: string } }> }).updates[0]?.document
        .markdown,
    ).toBe(`${"a".repeat(128)}\n...[truncated]`);

    await client.close();
    await server.close();
  });

  test("stream_events rejects replay windows above 24h before fetching", async () => {
    process.env.FIREHOSE_TAP_TOKEN = "fh_env_token";
    const fetchMock = vi.fn(async () => {
      throw new Error("Unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server, client } = await connectServer();
    const result = await client.callTool({
      name: "stream_events",
      arguments: {
        since: "7d",
      },
    });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain("since must be 24h or less");

    await client.close();
    await server.close();
  });
});

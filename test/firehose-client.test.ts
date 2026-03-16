import { describe, expect, test, vi } from "vitest";

import {
  FirehoseApiError,
  FirehoseClient,
  parseSseChunk,
  parseSseResponse,
} from "../src/firehose-client.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FirehoseClient.resolveTapToken", () => {
  test("prefers FIREHOSE_TAP_TOKEN when no tap id is requested", async () => {
    const client = new FirehoseClient({
      tapToken: "fh_env_token",
    });

    await expect(client.resolveTapToken()).resolves.toEqual({
      tapToken: "fh_env_token",
      tapId: undefined,
      source: "env",
    });
  });

  test("resolves tap token from management key and default tap id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "tap-1",
            name: "Primary",
            token: "fh_from_mgmt",
            token_prefix: "fh_abc",
          },
        ],
      }),
    );

    const client = new FirehoseClient(
      {
        managementKey: "fhm_key",
        defaultTapId: "tap-1",
      },
      fetchMock,
    );

    await expect(client.resolveTapToken()).resolves.toEqual({
      tapId: "tap-1",
      tapToken: "fh_from_mgmt",
      source: "management_key",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("errors when multiple taps exist and no tap id can be inferred", async () => {
    const client = new FirehoseClient(
      { managementKey: "fhm_key" },
      vi.fn(async () =>
        jsonResponse({
          data: [
            { id: "tap-1", name: "A", token: "fh_a" },
            { id: "tap-2", name: "B", token: "fh_b" },
          ],
        }),
      ),
    );

    await expect(client.resolveTapToken()).rejects.toMatchObject<Partial<FirehoseApiError>>({
      code: "configuration",
    });
  });
});

describe("SSE parsing", () => {
  test("parses a single update event chunk", () => {
    const event = parseSseChunk(
      [
        "id: 0-43368",
        "event: update",
        'data: {"query_id":"1","matched_at":"2026-02-13T08:06:32Z","tap_id":"tap-1","document":{"url":"https://example.com/page","markdown":"Hello"}}',
      ].join("\n"),
    );

    expect(event).toEqual({
      id: "0-43368",
      event: "update",
      data: {
        query_id: "1",
        matched_at: "2026-02-13T08:06:32Z",
        tap_id: "tap-1",
        document: {
          url: "https://example.com/page",
          markdown: "Hello",
        },
      },
    });
  });

  test("parses a response containing multiple SSE events", async () => {
    const response = new Response(
      [
        "event: connected",
        "data: {}",
        "",
        "id: 0-1",
        "event: end",
        "data: {}",
        "",
      ].join("\n"),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );

    await expect(parseSseResponse(response)).resolves.toEqual([
      { event: "connected", data: {} },
      { id: "0-1", event: "end", data: {} },
    ]);
  });
});

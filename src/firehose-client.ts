import {
  FIREHOSE_API_BASE_URL,
  FirehoseApiEnvelope,
  FirehoseCredentials,
  FirehoseErrorCode,
  FirehoseResolvedTap,
  FirehoseRule,
  FirehoseRuleMutation,
  FirehoseSseEvent,
  FirehoseTap,
} from "./types.js";

type FetchLike = typeof fetch;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

type RequestOptions = {
  method?: string;
  body?: JsonValue;
  token: string;
  headers?: Record<string, string>;
};

type StreamEventsOptions = {
  tapId?: string | undefined;
  timeoutSeconds?: number | undefined;
  since?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  lastEventId?: string | undefined;
};

type TapCache = {
  fetchedAt: number;
  taps: FirehoseTap[];
};

const DEFAULT_CACHE_TTL_MS = 15_000;

export class FirehoseApiError extends Error {
  readonly code: FirehoseErrorCode;
  readonly status: number | undefined;
  readonly details: unknown;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: {
      code: FirehoseErrorCode;
      status?: number | undefined;
      details?: unknown;
      retryAfterSeconds?: number | undefined;
    },
  ) {
    super(message);
    this.name = "FirehoseApiError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class FirehoseClient {
  private readonly fetchImpl: FetchLike;
  private tapCache: TapCache | undefined;

  constructor(
    private readonly credentials: FirehoseCredentials,
    fetchImpl: FetchLike = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  hasManagementKey(): boolean {
    return isNonEmptyString(this.credentials.managementKey);
  }

  hasTapToken(): boolean {
    return isNonEmptyString(this.credentials.tapToken);
  }

  async listTaps(forceFresh = false): Promise<FirehoseTap[]> {
    const token = this.credentials.managementKey;
    if (!token) {
      throw new FirehoseApiError(
        "FIREHOSE_MANAGEMENT_KEY is required for tap management.",
        { code: "configuration" },
      );
    }

    if (!forceFresh && this.tapCache && Date.now() - this.tapCache.fetchedAt < DEFAULT_CACHE_TTL_MS) {
      return this.tapCache.taps;
    }

    const response = await this.requestJson<FirehoseApiEnvelope<FirehoseTap[]>>(
      "/v1/taps",
      { token },
    );
    this.tapCache = { taps: response.data, fetchedAt: Date.now() };
    return response.data;
  }

  async createTap(name: string): Promise<{ data: FirehoseTap; token?: string }> {
    const token = this.credentials.managementKey;
    if (!token) {
      throw new FirehoseApiError(
        "FIREHOSE_MANAGEMENT_KEY is required to create taps.",
        { code: "configuration" },
      );
    }

    const response = await this.requestJson<
      FirehoseApiEnvelope<FirehoseTap> & { token?: string }
    >("/v1/taps", {
      method: "POST",
      token,
      body: { name },
    });
    this.tapCache = undefined;
    return response;
  }

  async getTap(
    tapId: string,
    options?: { includeToken?: boolean },
  ): Promise<FirehoseTap> {
    const token = this.credentials.managementKey;
    if (!token) {
      throw new FirehoseApiError(
        "FIREHOSE_MANAGEMENT_KEY is required to get taps.",
        { code: "configuration" },
      );
    }

    const response = await this.requestJson<FirehoseApiEnvelope<FirehoseTap>>(
      `/v1/taps/${encodeURIComponent(tapId)}`,
      { token },
    );

    if (!options?.includeToken || response.data.token) {
      return response.data;
    }

    const taps = await this.listTaps(true);
    const tapWithToken = taps.find((tap) => tap.id === tapId);
    return tapWithToken ? { ...response.data, token: tapWithToken.token } : response.data;
  }

  async updateTap(tapId: string, name: string): Promise<FirehoseTap> {
    const token = this.credentials.managementKey;
    if (!token) {
      throw new FirehoseApiError(
        "FIREHOSE_MANAGEMENT_KEY is required to update taps.",
        { code: "configuration" },
      );
    }

    const response = await this.requestJson<FirehoseApiEnvelope<FirehoseTap>>(
      `/v1/taps/${encodeURIComponent(tapId)}`,
      {
        method: "PUT",
        token,
        body: { name },
      },
    );
    this.tapCache = undefined;
    return response.data;
  }

  async revokeTap(tapId: string): Promise<void> {
    const token = this.credentials.managementKey;
    if (!token) {
      throw new FirehoseApiError(
        "FIREHOSE_MANAGEMENT_KEY is required to revoke taps.",
        { code: "configuration" },
      );
    }

    await this.requestNoContent(`/v1/taps/${encodeURIComponent(tapId)}`, {
      method: "DELETE",
      token,
    });
    this.tapCache = undefined;
  }

  async listRules(tapId?: string): Promise<{
    rules: FirehoseRule[];
    tap: FirehoseResolvedTap;
    count: number | undefined;
  }> {
    const tap = await this.resolveTapToken(tapId);
    const response = await this.requestJson<FirehoseApiEnvelope<FirehoseRule[]>>(
      "/v1/rules",
      { token: tap.tapToken },
    );
    return {
      rules: response.data,
      tap,
      count: typeof response.meta?.count === "number" ? response.meta.count : undefined,
    };
  }

  async createRule(
    input: FirehoseRuleMutation & { value: string },
    tapId?: string,
  ): Promise<{ rule: FirehoseRule; tap: FirehoseResolvedTap }> {
    const tap = await this.resolveTapToken(tapId);
    const response = await this.requestJson<FirehoseApiEnvelope<FirehoseRule>>(
      "/v1/rules",
      {
        method: "POST",
        token: tap.tapToken,
        body: input,
      },
    );
    return { rule: response.data, tap };
  }

  async getRule(
    ruleId: string,
    tapId?: string,
  ): Promise<{ rule: FirehoseRule; tap: FirehoseResolvedTap }> {
    const tap = await this.resolveTapToken(tapId);
    const response = await this.requestJson<FirehoseApiEnvelope<FirehoseRule>>(
      `/v1/rules/${encodeURIComponent(ruleId)}`,
      { token: tap.tapToken },
    );
    return { rule: response.data, tap };
  }

  async updateRule(
    ruleId: string,
    input: FirehoseRuleMutation,
    tapId?: string,
  ): Promise<{ rule: FirehoseRule; tap: FirehoseResolvedTap }> {
    const tap = await this.resolveTapToken(tapId);
    const response = await this.requestJson<FirehoseApiEnvelope<FirehoseRule>>(
      `/v1/rules/${encodeURIComponent(ruleId)}`,
      {
        method: "PUT",
        token: tap.tapToken,
        body: input,
      },
    );
    return { rule: response.data, tap };
  }

  async deleteRule(ruleId: string, tapId?: string): Promise<FirehoseResolvedTap> {
    const tap = await this.resolveTapToken(tapId);
    await this.requestNoContent(`/v1/rules/${encodeURIComponent(ruleId)}`, {
      method: "DELETE",
      token: tap.tapToken,
    });
    return tap;
  }

  async streamEvents(options: StreamEventsOptions): Promise<{
    events: FirehoseSseEvent[];
    tap: FirehoseResolvedTap;
    nextCursor: string | undefined;
  }> {
    const tap = await this.resolveTapToken(options.tapId);
    const url = new URL("/v1/stream", FIREHOSE_API_BASE_URL);

    if (options.timeoutSeconds !== undefined) {
      url.searchParams.set("timeout", String(options.timeoutSeconds));
    }
    if (options.since) {
      url.searchParams.set("since", options.since);
    }
    if (options.offset !== undefined) {
      url.searchParams.set("offset", String(options.offset));
    }
    if (options.limit !== undefined) {
      url.searchParams.set("limit", String(options.limit));
    }

    const headers = new Headers({
      Authorization: `Bearer ${tap.tapToken}`,
      Accept: "text/event-stream",
    });
    if (options.lastEventId) {
      headers.set("Last-Event-ID", options.lastEventId);
    }

    const response = await this.fetchImpl(url, { method: "GET", headers });
    if (!response.ok) {
      throw await this.toApiError(response);
    }
    if (!response.body) {
      throw new FirehoseApiError("Firehose stream response had no body.", {
        code: "transport",
      });
    }

    const events = await parseSseResponse(response);
    return {
      events,
      tap,
      nextCursor: [...events].reverse().find((event) => event.id)?.id,
    };
  }

  async resolveTapToken(tapId?: string): Promise<FirehoseResolvedTap> {
    const requestedTapId = tapId ?? this.credentials.defaultTapId;

    if (!requestedTapId && this.credentials.tapToken) {
      return {
        tapToken: this.credentials.tapToken,
        tapId: this.credentials.defaultTapId,
        source: "env",
      };
    }

    if (!this.credentials.managementKey) {
      if (requestedTapId) {
        throw new FirehoseApiError(
          "A management key is required when resolving a tap by tapId.",
          { code: "configuration" },
        );
      }

      throw new FirehoseApiError(
        "A tap token or management key is required for this operation.",
        { code: "configuration" },
      );
    }

    const taps = await this.listTaps();
    if (requestedTapId) {
      const tap = taps.find((entry) => entry.id === requestedTapId);
      if (!tap) {
        throw new FirehoseApiError(`Tap "${requestedTapId}" was not found.`, {
          code: "not_found",
        });
      }
      if (!tap.token) {
        throw new FirehoseApiError(
          `Tap "${requestedTapId}" did not include a token in the management API response.`,
          { code: "transport" },
        );
      }
      return {
        tapId: tap.id,
        tapToken: tap.token,
        source: "management_key",
      };
    }

    if (taps.length === 0) {
      throw new FirehoseApiError(
        "No taps exist yet. Create a tap first or configure FIREHOSE_TAP_TOKEN.",
        { code: "configuration" },
      );
    }

    if (taps.length > 1) {
      throw new FirehoseApiError(
        "Multiple taps exist. Pass tapId explicitly or configure FIREHOSE_TAP_TOKEN / FIREHOSE_DEFAULT_TAP_ID.",
        { code: "configuration", details: taps.map((tap) => ({ id: tap.id, name: tap.name })) },
      );
    }

    const [tap] = taps;
    if (!tap?.token) {
      throw new FirehoseApiError(
        `Tap "${tap?.id ?? "unknown"}" did not include a token in the management API response.`,
        { code: "transport" },
      );
    }

    return {
      tapId: tap.id,
      tapToken: tap.token,
      source: "management_key",
    };
  }

  private async requestJson<T>(path: string, options: RequestOptions): Promise<T> {
    const response = await this.fetchImpl(
      new URL(path, FIREHOSE_API_BASE_URL),
      buildRequestInit(
        options.method ?? "GET",
        this.buildHeaders(options.token, options.body, options.headers),
        options.body,
      ),
    );

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private async requestNoContent(path: string, options: RequestOptions): Promise<void> {
    const response = await this.fetchImpl(
      new URL(path, FIREHOSE_API_BASE_URL),
      buildRequestInit(
        options.method ?? "DELETE",
        this.buildHeaders(options.token, options.body, options.headers),
        options.body,
      ),
    );

    if (!response.ok) {
      throw await this.toApiError(response);
    }
  }

  private buildHeaders(
    token: string,
    hasBody?: JsonValue,
    extraHeaders?: Record<string, string>,
  ): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...extraHeaders,
    });
    if (hasBody !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    return headers;
  }

  private async toApiError(response: Response): Promise<FirehoseApiError> {
    let payload: unknown;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    const text = await response.text();

    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text || undefined;
    }

    const message = extractMessage(payload) ?? `Firehose API request failed with status ${response.status}.`;

    return new FirehoseApiError(message, {
      code: statusToErrorCode(response.status),
      status: response.status,
      details: payload,
      ...(Number.isFinite(retryAfterSeconds)
        ? { retryAfterSeconds }
        : {}),
    });
  }
}

export async function parseSseResponse(response: Response): Promise<FirehoseSseEvent[]> {
  if (!response.body) {
    return [];
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: FirehoseSseEvent[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const event = parseSseChunk(chunk);
      if (event) {
        events.push(event);
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseChunk(buffer);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

export function parseSseChunk(chunk: string): FirehoseSseEvent | undefined {
  const lines = chunk.split(/\r?\n/);
  let eventName = "message";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice("id:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const rawData = dataLines.join("\n");
  const parsed = rawData ? (JSON.parse(rawData) as unknown) : [];
  if (
    eventName !== "connected" &&
    eventName !== "update" &&
    eventName !== "error" &&
    eventName !== "end"
  ) {
    return undefined;
  }

  return {
    id,
    event: eventName,
    data: parsed as FirehoseSseEvent["data"],
  } as FirehoseSseEvent;
}

function statusToErrorCode(status: number): FirehoseErrorCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 422:
      return "validation";
    case 429:
      return "rate_limit";
    default:
      return "unknown";
  }
}

function extractMessage(payload: unknown): string | undefined {
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
    const errors = (payload as { errors?: unknown }).errors;
    if (errors && typeof errors === "object") {
      const firstValue = Object.values(errors as Record<string, unknown>)[0];
      if (Array.isArray(firstValue) && typeof firstValue[0] === "string") {
        return firstValue[0];
      }
      if (typeof firstValue === "string") {
        return firstValue;
      }
    }
  }
  return undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function buildRequestInit(
  method: string,
  headers: Headers,
  body?: JsonValue,
): RequestInit {
  if (body === undefined) {
    return { method, headers };
  }

  return {
    method,
    headers,
    body: JSON.stringify(body),
  };
}

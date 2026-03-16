export const FIREHOSE_API_BASE_URL = "https://api.firehose.com";

export type FirehoseCredentials = {
  managementKey?: string | undefined;
  tapToken?: string | undefined;
  defaultTapId?: string | undefined;
};

export type FirehoseErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "rate_limit"
  | "configuration"
  | "transport"
  | "unknown";

export type FirehoseApiEnvelope<T> = {
  data: T;
  meta?: Record<string, unknown>;
};

export type FirehoseTap = {
  id: string;
  name: string;
  token?: string | undefined;
  token_prefix?: string | undefined;
  rules_count?: number | undefined;
  last_used_at?: string | null | undefined;
  created_at?: string | undefined;
};

export type FirehoseRule = {
  id: string;
  value: string;
  tag?: string | undefined;
  nsfw?: boolean | undefined;
  quality?: boolean | undefined;
};

export type FirehoseDiffChunk = {
  typ: "ins" | "del";
  text: string;
};

export type FirehoseDocument = {
  url: string;
  title?: string | undefined;
  publish_time?: string | undefined;
  diff?: {
    chunks: FirehoseDiffChunk[];
  } | undefined;
  page_category?: string[] | undefined;
  page_types?: string[] | undefined;
  language?: string | undefined;
  markdown?: string | undefined;
};

export type FirehoseUpdateEvent = {
  tap_id: string;
  query_id: string;
  matched_at: string;
  document: FirehoseDocument;
};

export type FirehoseSseEvent =
  | {
      id?: string | undefined;
      event: "connected";
      data: [] | Record<string, never>;
    }
  | {
      id?: string | undefined;
      event: "update";
      data: FirehoseUpdateEvent;
    }
  | {
      id?: string | undefined;
      event: "error";
      data: {
        message: string;
      };
    }
  | {
      id?: string | undefined;
      event: "end";
      data: [] | Record<string, never>;
    };

export type FirehoseResolvedTap = {
  tapId?: string | undefined;
  tapToken: string;
  source: "env" | "management_key";
};

export type FirehoseRuleMutation = {
  value?: string | undefined;
  tag?: string | undefined;
  nsfw?: boolean | undefined;
  quality?: boolean | undefined;
};

export type QueryValidationIssue = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
};

export type QueryValidationResult = {
  isValid: boolean;
  issues: QueryValidationIssue[];
  detectedFields: string[];
};

export type ServerRuntimeConfig = {
  credentials: FirehoseCredentials;
  availableAuthModes: Array<"management" | "tap">;
};

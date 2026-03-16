# firehose-mcp

[![CI](https://github.com/canmutioglu/firehose-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/canmutioglu/firehose-mcp/actions/workflows/ci.yml)

MCP server for [Firehose](https://firehose.com) tap management, rule management, Lucene query helpers, and raw SSE access.

This project is built for Firehose, but it is not an official Firehose package.

## Scope

`firehose-mcp` is intentionally narrow. It exposes:

- tap management with a Firehose management key
- rule CRUD with a tap token or a management key
- raw bounded stream access through `stream_events`
- local query validation and explanation before writing rules
- reusable prompts for drafting and debugging Firehose queries

It does not expose replay-derived analytics, historical match search, dashboards, or persistence.

`stream_events` mirrors Firehose stream semantics only. It is useful for live tailing, bounded replay, and cursor-based resume workflows. It is not a durable history endpoint.

## Quick Start

### Prerequisites

- Node.js 20+
- Firehose access
- one or both of:
  - `FIREHOSE_MANAGEMENT_KEY`
  - `FIREHOSE_TAP_TOKEN`

### Install with `npx`

Most MCP clients can run the server directly with `npx`.

### Codex

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.firehose]
command = "npx"
args = ["-y", "firehose-mcp"]

[mcp_servers.firehose.env]
FIREHOSE_MANAGEMENT_KEY = "fhm_..."
FIREHOSE_TAP_TOKEN = "fh_..."
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "firehose": {
      "command": "npx",
      "args": ["-y", "firehose-mcp"],
      "env": {
        "FIREHOSE_MANAGEMENT_KEY": "fhm_...",
        "FIREHOSE_TAP_TOKEN": "fh_..."
      }
    }
  }
}
```

### Cursor

Edit `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "firehose": {
      "command": "npx",
      "args": ["-y", "firehose-mcp"],
      "env": {
        "FIREHOSE_MANAGEMENT_KEY": "fhm_...",
        "FIREHOSE_TAP_TOKEN": "fh_..."
      }
    }
  }
}
```

### VS Code

Edit `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "firehose": {
      "command": "npx",
      "args": ["-y", "firehose-mcp"],
      "env": {
        "FIREHOSE_MANAGEMENT_KEY": "fhm_...",
        "FIREHOSE_TAP_TOKEN": "fh_..."
      }
    }
  }
}
```

### Local installation

```bash
git clone https://github.com/canmutioglu/firehose-mcp.git
cd firehose-mcp
npm install
npm run build
```

Then point your MCP client at `dist/index.js`.

## Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `FIREHOSE_MANAGEMENT_KEY` | No | Enables tap management and can resolve tap tokens internally. |
| `FIREHOSE_TAP_TOKEN` | No | Gives direct rule and stream access to a single tap. |
| `FIREHOSE_DEFAULT_TAP_ID` | No | Used when multiple taps exist and you want a default target for rule and stream tools. |

If your organization has multiple taps, either set `FIREHOSE_DEFAULT_TAP_ID` or pass `tap_id` explicitly on rule and stream calls.

## Tools

### Utility tools

| Tool | Auth | What it does |
| --- | --- | --- |
| `server_status` | None | Shows enabled auth modes, available tools, and stream scope. |
| `validate_query` | None | Validates Firehose Lucene syntax heuristically. |
| `explain_query` | None | Explains how Firehose will interpret a query. |

### Tap tools

| Tool | Auth | What it does |
| --- | --- | --- |
| `list_taps` | management key | Lists taps, redacting tokens by default. |
| `create_tap` | management key | Creates a new tap. |
| `get_tap` | management key | Gets a single tap. |
| `update_tap` | management key | Renames a tap. |
| `revoke_tap` | management key | Deletes a tap permanently. |

### Rule tools

| Tool | Auth | What it does |
| --- | --- | --- |
| `list_rules` | tap token or management key | Lists rules for a tap. |
| `create_rule` | tap token or management key | Creates a rule. |
| `get_rule` | tap token or management key | Gets one rule. |
| `update_rule` | tap token or management key | Updates a rule. |
| `delete_rule` | tap token or management key | Deletes a rule. |

### Stream tool

| Tool | Auth | What it does |
| --- | --- | --- |
| `stream_events` | tap token or management key | Reads a bounded Firehose SSE batch and exposes replay metadata. |

`stream_events` accepts:

- `tap_id`
- `timeout_seconds`
- `since`
- `offset`
- `last_event_id`
- `limit`
- `include_markdown`
- `markdown_max_chars`

## Behavior Notes

- `stream_events` is bounded. It always terminates.
- Replay windows currently support up to `24h`, matching Firehose replay limits.
- `stream_events` does not create durable history. Empty replay results mean the replay buffer returned no events for that request; they do not prove durable historical absence.
- Cursor-based resume is exposed through `last_event_id`, but cursor persistence is the caller's responsibility.
- `include_markdown` is off by default to keep responses small.

## Example Prompts

- `Show my Firehose server status.`
- `List all taps and redact tokens.`
- `Create a new tap called "Brand Mentions".`
- `List rules for tap_id=...`
- `Validate this query: title:"openai" AND recent:24h`
- `Explain this query: url:*\\/category\\/* AND language:"tr"`
- `Create a Firehose rule for OpenAI news in English.`
- `Use stream_events for tap_id=... with timeout_seconds=30 and limit=10.`
- `Resume the stream from last_event_id=0-43368 and return the next updates.`

## Prompts

- `draft_firehose_rule`
- `debug_firehose_query`

## Install and Build

```bash
npm install
npm run check
npm test
npm run build
```

## Local Smoke Test

```bash
node dist/index.js
```

## Troubleshooting

### I have multiple taps and `list_rules` or `stream_events` fails

Set `FIREHOSE_DEFAULT_TAP_ID` or pass `tap_id` explicitly.

### I only configured a management key but rule tools still fail

Make sure the management key belongs to an organization that already has at least one tap. If multiple taps exist, add `FIREHOSE_DEFAULT_TAP_ID`.

### `stream_events` stops after a while

That is expected. The tool is bounded by `timeout_seconds` and `limit`.

### I expected historical matches

This server does not provide durable match history. `stream_events` only mirrors Firehose stream and replay behavior.

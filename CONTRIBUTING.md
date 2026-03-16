# Contributing

Thanks for contributing to `firehose-mcp`.

## Development Setup

```bash
npm install
npm run check
npm test
npm run build
```

## Development Principles

- Keep the server stdio-first unless transport changes are explicitly scoped and documented.
- Preserve Firehose semantics exactly. If docs and code disagree, prefer the official Firehose API documentation and update tests.
- Avoid introducing configuration that increases ambiguity for first-time users.

## Pull Requests

- Prefer focused PRs with one clear purpose.
- Update README and tests when public behavior changes.
- Keep tool names stable unless there is a strong compatibility reason to rename them.
- Run `npm run publish-preflight` before opening or merging a release-oriented PR.

## Documentation Expectations

- Any new environment variable must be documented in the README.
- Any new tool must be added to the tools reference table and prompt examples if user-facing.
- Troubleshooting guidance should be added for likely operator failures, not just code failures.

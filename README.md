# ntion

Token-efficient Notion CLI built for AI agents like Claude Code and Codex.

One command where the official MCP needs twelve. Compact JSON where others dump kilobytes of noise. Zero native dependencies — runs instantly via `npx`.

## Why ntion over the official Notion MCP?

The official Notion MCP server works, but it was designed for general-purpose access, not for token-constrained AI agents. Every extra byte in a response eats into your context window. Every extra round-trip adds latency and cost.

I benchmarked both tools side-by-side on real workflows:

### Individual operations

| Operation | ntion | MCP | Ratio |
|---|---|---|---|
| Search (tasks, pages only) | 743 B | 1,019 B | **1.4x smaller** |
| Schema (Tasks DB) | 1,868 B | 6,026 B | **3.2x smaller** |
| Page properties only | 1,004 B | n/a | ntion-only |
| Page + content (markdown) | 1,227 B | 1,263 B | ~1.0x (tie) |

### The real difference: workflows

A single "get all my tasks" workflow tells the whole story:

| Scale | ntion | MCP |
|---|---|---|
| 1 task | **1,938 B, 1 call** | 8,308 B, 3 calls (4.3x) |
| 10 tasks | **~5 KB, 1 call** | ~19.6 KB, 12 calls (3.9x) |
| 50 tasks | **~20 KB, 1 call** | ~70 KB, 52 calls (3.5x) |

### Where the savings come from

1. **Batch queries** — ntion returns N records in 1 call. The MCP requires 1 fetch per page. This is the dominant factor and it scales linearly.
2. **No schema bloat** — MCP's database fetch includes ~2 KB of SQLite DDL, ~800 B of XML boilerplate, and ~1.4 KB of base64 `collectionPropertyOption://` URLs that are never used for reads. ntion returns only actionable data.
3. **Markdown-first** — Page content defaults to markdown, matching what agents actually consume. No manual format negotiation needed.

### Operations the official MCP can't do

The official Notion MCP server has no block delete tool. ntion does:

```bash
ntion blocks delete --ids <block_id>
```

Delete one or many blocks in a single call — useful for cleaning up content, removing broken blocks, or precise page editing.

## Agent skill

ntion ships with an [agent skill](https://docs.anthropic.com/en/docs/claude-code/skills) that teaches AI agents how to use the CLI. Install it with:

```bash
npx skills add https://github.com/mbroton/notion-cli --skill ntion-cli
```

## Install

```bash
npm install -g ntion
```

Or run directly without installing:

```bash
npx ntion --help
```

No native compilation, no C++ toolchain required — installs in seconds.

## Quick start

### 1. Authenticate

Create an integration and grab your API key at [notion.so/profile/integrations](https://www.notion.so/profile/integrations).

```bash
ntion auth
# Paste your Notion integration token when prompted — done.

# Or pass it directly (e.g. in scripts):
ntion auth --token "secret_xxx"

# CI alternative — read token from an environment variable:
ntion auth --token-env NOTION_API_KEY
```

### 2. Go

```bash
# Find your databases
ntion data-sources list --query "tasks"

# Query all tasks in one call
ntion data-sources query --id <data_source_id> --view full

# Read a page with its content as markdown
ntion pages get --id <page_id> --include-content

# Search across your workspace
ntion search --query "release notes" --limit 25
```

## Commands

### Search

```bash
ntion search --query "release notes" --limit 25
ntion search --query "infra" --object page --created-after 2026-01-01T00:00:00Z
ntion search --query "oncall" --scope <page_or_data_source_id> --created-by <user_id>
```

### Data sources

```bash
ntion data-sources list --query "tasks"
ntion data-sources get --id <data_source_id> --view full
ntion data-sources schema --id <data_source_id>
ntion data-sources query --id <data_source_id> \
  --filter-json '{"property":"Status","status":{"equals":"In Progress"}}'
```

### Pages

```bash
ntion pages get --id <page_id>
ntion pages get --id <page_id> --include-content --content-format markdown

ntion pages create \
  --parent-data-source-id <data_source_id> \
  --properties-json '{"Name":"Ship CLI","Status":"In Progress"}'

ntion pages create-bulk \
  --parent-data-source-id <data_source_id> \
  --items-json '[{"properties":{"Name":"Task A"}},{"properties":{"Name":"Task B"}}]' \
  --concurrency 5

ntion pages update --id <page_id> --patch-json '{"Status":"Done"}'
ntion pages archive --id <page_id>
ntion pages unarchive --id <page_id>

ntion pages relate --from-id <page_id> --property Project --to-id <page_id>
ntion pages unrelate --from-id <page_id> --property Project --to-id <page_id>
```

### Blocks

```bash
# Read as markdown (default)
ntion blocks get --id <page_or_block_id> --depth 1
ntion blocks get --id <page_or_block_id> --format full
# blocks get uses --format (markdown|compact|full)

# Append markdown content
ntion blocks append --id <page_or_block_id> --markdown $'# Title\n\nHello'
ntion blocks append --id <page_or_block_id> --markdown-file ./notes.md

# Surgical insertion
ntion blocks insert --parent-id <page_or_block_id> --markdown "New intro" --position start
ntion blocks insert --parent-id <page_or_block_id> --markdown "After this" --after-id <block_id>

# Find and replace block ranges
ntion blocks select \
  --scope-id <page_or_block_id> \
  --selector-json '{"where":{"type":"paragraph","text_contains":"TODO"}}'

ntion blocks replace-range \
  --scope-id <page_or_block_id> \
  --start-selector-json '{"where":{"text_contains":"Start"}}' \
  --end-selector-json '{"where":{"text_contains":"End"}}' \
  --markdown "Replacement content"

# Delete blocks (not available in the official Notion MCP)
ntion blocks delete --ids <block_id>
ntion blocks delete --ids <id1> <id2> <id3>
```

### Health check

```bash
ntion doctor
```

## Output format

Every response follows the same envelope:

```json
{"ok": true, "data": {}, "meta": {"request_id": "..."}}
```

```json
{"ok": false, "error": {"code": "invalid_input", "message": "...", "retryable": false}, "meta": {"request_id": "..."}}
```

Compact, deterministic, easy to parse — by humans or machines.

## Design principles

- **Generic** — works with any Notion workspace, no hardcoded schema assumptions
- **Compact** — deterministic JSON envelopes, minimal bytes per response
- **Safe** — automatic idempotency for all mutations, built-in conflict detection and verify-first recovery
- **Fast** — zero native dependencies, internal schema caching, batch operations
- **Agent-friendly** — designed for AI agents that pay per token

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure |
| 2 | Invalid input |
| 3 | Not found |
| 4 | Conflict |
| 5 | Retryable upstream error |
| 6 | Auth/config error |

## Storage

Config and state are stored in `~/.config/ntion/` (or `$XDG_CONFIG_HOME/ntion/`):

- `config.json` — auth and defaults
- `idempotency.json` — short-lived mutation dedup cache (auto-pruned)
- `audit.log` — local mutation audit trail

## License

MIT

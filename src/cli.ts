#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { executeMutationWithIdempotency } from "./commands/mutation.js";
import { loadRuntime, parseCommaFields, parsePositiveInt } from "./commands/context.js";
import { runAction } from "./commands/output.js";
import { getConfigPath } from "./config/paths.js";
import { buildInitialAuthConfig, loadConfigOrNull, saveConfig } from "./config/store.js";
import { CliError } from "./errors/cli-error.js";
import { markdownToBlocks } from "./notion/markdown.js";
import {
  appendBlocks,
  archivePage,
  BlockInsertPosition,
  BlockReadFormat,
  BlockSelector,
  createPage,
  createPagesBulk,
  getBlocks,
  getDataSource,
  getDataSourceSchema,
  getPage,
  insertBlocks,
  listDataSources,
  queryDataSourcePages,
  replaceBlockRange,
  searchWorkspace,
  selectBlocks,
  setRelation,
  unarchivePage,
  updatePage,
} from "./notion/repository.js";
import { parseJsonOption } from "./utils/json.js";

interface CommonOptions {
  pretty?: boolean;
  timeoutMs?: string;
  view?: string;
  fields?: string;
  limit?: string;
  cursor?: string;
  filterJson?: string;
  sortJson?: string;
}

type ViewMode = "compact" | "full";

type SearchObjectType = "page" | "data_source";

const ROOT_HELP_EPILOG = [
  "",
  "Power Features:",
  "  pages create-bulk                           create up to 100 pages in one command",
  "  pages unarchive                             restore archived pages",
  "  pages get --include-content                 includes markdown content by default",
  "  blocks insert --position/--after-id         surgical insertion at start/end/or after a block",
  "  blocks replace-range --start/--end-selector replace a selected sibling range in place",
  "  blocks append --markdown|--markdown-file    append markdown without raw Notion block JSON",
  "  search --scope --created-after --created-before --edited-after --edited-before",
  "         --created-by --object --scan-limit",
  "",
  "Agent-First Quick Flows:",
  "  ntion data-sources list --query \"tasks\"",
  "  ntion data-sources schema --id <data_source_id>",
  "  ntion pages create-bulk --parent-data-source-id <id> --items-json '[{\"Name\":\"Task A\"}]'",
  "  ntion pages get --id <page_id> --include-content --content-depth 1",
  "  ntion search --query \"infra\" --object page --created-after 2026-01-01T00:00:00Z",
].join("\n");

const PAGES_HELP_EPILOG = [
  "",
  "Highlights:",
  "  pages create-bulk supports up to 100 items via --items-json and optional --concurrency.",
  "  pages unarchive restores archived pages.",
  "  Mutation commands support --return-view <compact|full> (default: full).",
  "  pages get can include block content in the same response via --include-content.",
  "  content format defaults to markdown; override with --content-format compact|full.",
].join("\n");

const SEARCH_HELP_EPILOG = [
  "",
  "Advanced Filtering At a Glance:",
  "  Scope:       --scope <page_or_data_source_id>",
  "  Created:     --created-after <iso> --created-before <iso>",
  "  Edited:      --edited-after <iso> --edited-before <iso>",
  "  Actor/type:  --created-by <user_id> --object <page|data_source>",
  "  Scan budget: --scan-limit <n>",
  "",
  "Examples:",
  "  ntion search --query \"release\" --scope <page_id> --object page",
  "  ntion search --query \"infra\" --created-after 2026-01-01T00:00:00Z --created-by <user_id>",
].join("\n");

const BLOCKS_APPEND_HELP_EPILOG = [
  "",
  "Input Modes:",
  "  Provide exactly one of --blocks-json, --markdown, or --markdown-file.",
  "",
  "Examples:",
  "  ntion blocks append --id <id> --markdown \"# Heading\\n\\nBody\"",
  "  ntion blocks append --id <id> --markdown-file ./notes.md",
].join("\n");

const BLOCKS_INSERT_HELP_EPILOG = [
  "",
  "Positioning:",
  "  --position end|start (default: end), or provide --after-id <block_id>.",
  "",
  "Examples:",
  "  ntion blocks insert --parent-id <page_id> --markdown \"New intro\" --position start",
  "  ntion blocks insert --parent-id <parent_block_id> --markdown \"Inserted\" --after-id <block_id>",
].join("\n");

const BLOCKS_SELECT_HELP_EPILOG = [
  "",
  "Selector JSON shape:",
  "  {\"where\":{\"type\":\"paragraph\",\"text_contains\":\"TODO\",\"parent_id\":\"...\"},\"nth\":1,\"from\":\"start\"}",
  "",
  "Notes:",
  "  - nth is optional; from defaults to start.",
  "  - when nth is omitted and multiple matches exist, selected is null and ambiguous is true.",
].join("\n");

const BLOCKS_REPLACE_RANGE_HELP_EPILOG = [
  "",
  "Range replacement:",
  "  Resolves start/end selectors within --scope-id, inserts new content, then deletes selected range.",
  "  v1 constraint: start and end must resolve to siblings under the same parent.",
  "",
  "Example:",
  "  ntion blocks replace-range --scope-id <page_id> \\",
  "    --start-selector-json '{\"where\":{\"text_contains\":\"Start\"}}' \\",
  "    --end-selector-json '{\"where\":{\"text_contains\":\"End\"}}' \\",
  "    --markdown \"Replacement body\"",
].join("\n");

function resolveView(input: string | undefined, fallback: ViewMode): ViewMode {
  const value = input ?? fallback;
  if (value === "compact" || value === "full") {
    return value;
  }
  throw new CliError("invalid_input", "View must be either compact or full.");
}

function resolveBlockReadFormat(input: string | undefined, fallback: BlockReadFormat): BlockReadFormat {
  const value = input ?? fallback;
  if (value === "markdown" || value === "compact" || value === "full") {
    return value;
  }
  throw new CliError("invalid_input", "Block format must be markdown, compact, or full.");
}

function parseSearchObject(raw: string | undefined): SearchObjectType | undefined {
  if (!raw) {
    return undefined;
  }
  if (raw === "page" || raw === "data_source") {
    return raw;
  }
  throw new CliError("invalid_input", "--object must be either page or data_source.");
}

function parseIsoTimestamp(raw: string | undefined, label: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new CliError("invalid_input", `${label} must be a valid ISO-8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function requireObjectJson(raw: string, label: string): Record<string, unknown> {
  const parsed = parseJsonOption<unknown>(label, raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("invalid_input", `${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requireArrayJson(raw: string, label: string): Array<Record<string, unknown>> {
  const parsed = parseJsonOption<unknown>(label, raw);
  if (!Array.isArray(parsed)) {
    throw new CliError("invalid_input", `${label} must be a JSON array.`);
  }
  return parsed as Array<Record<string, unknown>>;
}

function parseSortJson(raw: string | undefined): Array<Record<string, unknown>> | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = parseJsonOption<unknown>("sort-json", raw);
  if (Array.isArray(parsed)) {
    return parsed as Array<Record<string, unknown>>;
  }

  if (parsed && typeof parsed === "object") {
    return [parsed as Record<string, unknown>];
  }

  throw new CliError("invalid_input", "sort-json must be a JSON object or array of objects.");
}

function requireSelectorJson(raw: string, label: string): BlockSelector {
  const parsed = parseJsonOption<unknown>(label, raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("invalid_input", `${label} must be a JSON object.`);
  }
  return parsed as BlockSelector;
}

function resolveInsertPosition(rawPosition: string | undefined, afterId: string | undefined): BlockInsertPosition {
  if (afterId) {
    if (rawPosition && rawPosition !== "end") {
      throw new CliError("invalid_input", "--after-id cannot be combined with --position start.");
    }
    return {
      type: "after_block",
      after_block: {
        id: afterId,
      },
    };
  }

  const position = rawPosition ?? "end";
  if (position !== "start" && position !== "end") {
    throw new CliError("invalid_input", "--position must be either start or end.");
  }

  return {
    type: position,
  };
}

async function resolveBlocksInput(args: {
  blocksJson?: string;
  markdown?: string;
  markdownFile?: string;
}): Promise<Array<Record<string, unknown>>> {
  const providedInputs = [args.blocksJson, args.markdown, args.markdownFile].filter(
    (value) => typeof value === "string" && value.length > 0,
  );

  if (providedInputs.length !== 1) {
    throw new CliError(
      "invalid_input",
      "Provide exactly one of --blocks-json, --markdown, or --markdown-file.",
    );
  }

  if (args.blocksJson) {
    return requireArrayJson(args.blocksJson, "blocks-json");
  }

  if (args.markdown) {
    return markdownToBlocks(args.markdown);
  }

  const markdown = await readFile(String(args.markdownFile), "utf8");
  return markdownToBlocks(markdown);
}

function addCommonReadOptions(command: Command): Command {
  return command
    .option("--view <compact|full>", "response view mode")
    .option("--fields <csv>", "comma-separated fields to include in compact view")
    .option("--limit <n>", "max records to return")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--pretty", "pretty-print JSON output")
    .option("--timeout-ms <n>", "request timeout in milliseconds");
}

function addCommonMutationOptions(command: Command): Command {
  return command
    .option("--return-view <compact|full>", "mutation response view mode", "full")
    .option("--fields <csv>", "comma-separated fields to include when return-view=compact")
    .option("--pretty", "pretty-print JSON output")
    .option("--timeout-ms <n>", "request timeout in milliseconds");
}

function resolveReturnView(raw: string | undefined): ViewMode {
  return resolveView(raw, "full");
}

async function runInteractiveAuthSetup(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "invalid_input",
      "Interactive auth requires a TTY. Use `ntion auth --token <secret>` or `ntion auth --token-env <ENV_NAME>` in non-interactive environments.",
    );
  }

  const rl = createInterface({ input, output });
  try {
    const response = await rl.question("Paste your Notion integration token: ");
    const trimmed = response.trim();
    if (!trimmed) {
      throw new CliError("invalid_input", "Token cannot be empty.");
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

async function saveAuthConfig(token: string): Promise<{ config_path: string }> {
  const existing = await loadConfigOrNull();
  const nextConfig =
    existing ??
    buildInitialAuthConfig({
      notionApiKey: token,
    });

  nextConfig.notion_api_key = token;
  await saveConfig(nextConfig);

  return {
    config_path: getConfigPath(),
  };
}

async function saveAuthConfigEnv(tokenEnv: string): Promise<{ token_env: string; config_path: string }> {
  const existing = await loadConfigOrNull();
  const nextConfig =
    existing ??
    buildInitialAuthConfig({
      notionApiKeyEnv: tokenEnv,
    });

  nextConfig.notion_api_key_env = tokenEnv;
  await saveConfig(nextConfig);

  return {
    token_env: tokenEnv,
    config_path: getConfigPath(),
  };
}

const program = new Command();
program
  .name("ntion")
  .description("Token-efficient, workspace-agnostic Notion CLI")
  .showHelpAfterError()
  .addHelpText("after", ROOT_HELP_EPILOG);

program
  .command("auth")
  .description("Configure authentication (get your token at https://www.notion.so/profile/integrations)")
  .option("--token <secret>", "Notion integration token (direct)")
  .option("--token-env <name>", "API key environment variable name (CI)")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(async (options: { token?: string; tokenEnv?: string; pretty?: boolean; timeoutMs?: string }) => {
    await runAction(Boolean(options.pretty), async () => {
      if (options.token && options.tokenEnv) {
        throw new CliError("invalid_input", "Provide --token or --token-env, not both.");
      }

      // CI path: env-var indirection
      if (options.tokenEnv) {
        const saved = await saveAuthConfigEnv(options.tokenEnv);
        const tokenPresent = Boolean(process.env[options.tokenEnv]);

        if (!tokenPresent) {
          return {
            data: {
              ...saved,
              token_present: false,
              verified: false,
              message: `Set ${options.tokenEnv} in your environment to enable API calls.`,
            },
          };
        }

        const { notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        await notion.search({ page_size: 1 });

        return {
          data: {
            ...saved,
            token_present: true,
            verified: true,
            message: "Authentication verified.",
          },
        };
      }

      // Direct token: from flag or interactive prompt
      const token = options.token ?? (await runInteractiveAuthSetup());
      const saved = await saveAuthConfig(token);

      const timeoutMs = options.timeoutMs ? Number.parseInt(options.timeoutMs, 10) : 30000;
      const { NotionClientAdapter } = await import("./notion/client.js");
      const notion = new NotionClientAdapter(token, timeoutMs);
      await notion.search({ page_size: 1 });

      return {
        data: {
          ...saved,
          token_present: true,
          verified: true,
          message: "Authentication verified.",
        },
      };
    });
  });

const searchCommand = addCommonReadOptions(program.command("search").description("Workspace-wide search"))
  .requiredOption("--query <text>", "search query text")
  .option("--scope <id>", "limit to a specific parent/page scope")
  .option("--created-after <iso>", "only include records created on/after this timestamp")
  .option("--created-before <iso>", "only include records created on/before this timestamp")
  .option("--edited-after <iso>", "only include records edited on/after this timestamp")
  .option("--edited-before <iso>", "only include records edited on/before this timestamp")
  .option("--created-by <user_id>", "only include records created by this user")
  .option("--object <page|data_source>", "limit search object type")
  .option("--scan-limit <n>", "max upstream records to scan before returning")
  .action(
    async (
      options: CommonOptions & {
        query: string;
        scope?: string;
        createdAfter?: string;
        createdBefore?: string;
        editedAfter?: string;
        editedBefore?: string;
        createdBy?: string;
        object?: string;
        scanLimit?: string;
      },
    ) => {
      await runAction(Boolean(options.pretty), async () => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const { results, pagination, scan_count } = await searchWorkspace(notion, {
          query: options.query,
          limit: parsePositiveInt(options.limit, "limit", config.defaults.limit),
          cursor: options.cursor,
          scope: options.scope,
          createdAfter: parseIsoTimestamp(options.createdAfter, "created-after"),
          createdBefore: parseIsoTimestamp(options.createdBefore, "created-before"),
          editedAfter: parseIsoTimestamp(options.editedAfter, "edited-after"),
          editedBefore: parseIsoTimestamp(options.editedBefore, "edited-before"),
          createdBy: options.createdBy,
          object: parseSearchObject(options.object),
          scanLimit: parsePositiveInt(
            options.scanLimit,
            "scan-limit",
            config.defaults.search_scan_limit,
          ),
        });

        return {
          data: {
            results,
            scan_count,
          },
          pagination,
        };
      });
    },
  );
searchCommand.addHelpText("after", SEARCH_HELP_EPILOG);

const dataSourcesCommand = program.command("data-sources").description("Data source operations");

addCommonReadOptions(dataSourcesCommand.command("list").description("List accessible data sources"))
  .option("--query <text>", "search text for filtering data sources")
  .action(async (options: CommonOptions & { query?: string }) => {
    await runAction(Boolean(options.pretty), async () => {
      const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
      const { data_sources, pagination } = await listDataSources(notion, {
        query: options.query,
        limit: parsePositiveInt(options.limit, "limit", config.defaults.limit),
        cursor: options.cursor,
      });

      return {
        data: {
          data_sources,
        },
        pagination,
      };
    });
  });

addCommonReadOptions(dataSourcesCommand.command("get").description("Get a data source by ID"))
  .requiredOption("--id <data_source_id>", "Notion data source ID")
  .action(async (options: CommonOptions & { id: string }) => {
    await runAction(Boolean(options.pretty), async () => {
      const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
      const dataSource = await getDataSource(
        notion,
        options.id,
        resolveView(options.view, config.defaults.view),
      );

      return {
        data: {
          data_source: dataSource,
        },
      };
    });
  });

dataSourcesCommand
  .command("schema")
  .description("Get rich schema details for a data source")
  .requiredOption("--id <data_source_id>", "Notion data source ID")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(async (options: { id: string; pretty?: boolean; timeoutMs?: string }) => {
    await runAction(Boolean(options.pretty), async () => {
      const { notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
      const schema = await getDataSourceSchema(notion, options.id);
      return {
        data: {
          schema,
        },
      };
    });
  });

addCommonReadOptions(dataSourcesCommand.command("query").description("Query pages in a data source"))
  .requiredOption("--id <data_source_id>", "Notion data source ID")
  .option("--filter-json <json>", "Notion filter payload")
  .option("--sort-json <json>", "Notion sort payload")
  .action(
    async (
      options: CommonOptions & {
        id: string;
      },
    ) => {
      await runAction(Boolean(options.pretty), async () => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });

        const filter = options.filterJson
          ? requireObjectJson(options.filterJson, "filter-json")
          : undefined;

        const { records, pagination } = await queryDataSourcePages(
          {
            notion,
            config,
            saveConfig,
          },
          {
            dataSourceId: options.id,
            limit: parsePositiveInt(options.limit, "limit", config.defaults.limit),
            cursor: options.cursor,
            filter,
            sorts: parseSortJson(options.sortJson),
            view: resolveView(options.view, config.defaults.view),
            fields: parseCommaFields(options.fields),
          },
        );

        return {
          data: {
            records,
          },
          pagination,
        };
      });
    },
  );

const pagesCommand = program.command("pages").description("Page operations");
pagesCommand.addHelpText("after", PAGES_HELP_EPILOG);

addCommonReadOptions(pagesCommand.command("get").description("Get a page by ID"))
  .requiredOption("--id <page_id>", "Notion page ID")
  .option("--include-content", "include page block content in the same response")
  .option("--content-max-blocks <n>", "maximum block count when include-content is set")
  .option("--content-depth <n>", "block recursion depth when include-content is set")
  .option(
    "--content-format <markdown|compact|full>",
    "content format when include-content is set",
    "markdown",
  )
  .action(
    async (
      options: CommonOptions & {
        id: string;
        includeContent?: boolean;
        contentMaxBlocks?: string;
        contentDepth?: string;
        contentFormat?: string;
      },
    ) => {
      await runAction(Boolean(options.pretty), async () => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const view = resolveView(options.view, config.defaults.view);
        const page = await getPage(notion, options.id, view, parseCommaFields(options.fields));
        let content: Record<string, unknown> | null = null;

        if (options.includeContent) {
          const maxBlocks = parsePositiveInt(
            options.contentMaxBlocks,
            "content-max-blocks",
            config.defaults.max_blocks,
          );
          const depth = parsePositiveInt(options.contentDepth, "content-depth", 1);
          const contentFormat = resolveBlockReadFormat(options.contentFormat, "markdown");
          content = await getBlocks(notion, options.id, maxBlocks, depth, contentFormat);
        }

        return {
          data: {
            page,
            content,
          },
        };
      });
    },
  );

addCommonMutationOptions(pagesCommand.command("create").description("Create a page in a data source"))
  .requiredOption("--parent-data-source-id <id>", "Parent data source ID")
  .requiredOption("--properties-json <json>", "JSON object of property values")
  .action(
    async (
      options: {
        parentDataSourceId: string;
        propertiesJson: string;
        returnView?: string;
        fields?: string;
        pretty?: boolean;
        timeoutMs?: string;
      },
    ) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const propertiesPatch = requireObjectJson(options.propertiesJson, "properties-json");
        const view = resolveReturnView(options.returnView);
        const fields = parseCommaFields(options.fields);

        const page = await executeMutationWithIdempotency({
          commandName: "pages.create",
          requestId,
          requestShape: {
            parent_data_source_id: options.parentDataSourceId,
            properties: propertiesPatch,
            view,
            fields,
          },
          targetIds: [options.parentDataSourceId],
          run: () =>
            createPage(
              {
                notion,
                config,
                saveConfig,
              },
              {
                parentDataSourceId: options.parentDataSourceId,
                propertiesPatch,
                view,
                fields,
              },
            ),
        });

        return {
          data: {
            page,
          },
        };
      });
    },
  );

addCommonMutationOptions(
  pagesCommand.command("create-bulk").description("Create up to 100 pages in a data source"),
)
  .requiredOption("--parent-data-source-id <id>", "Parent data source ID")
  .requiredOption(
    "--items-json <json>",
    "JSON array of items. Each item may be { properties: {...} } or a direct properties object.",
  )
  .option("--concurrency <n>", "parallelism for create operations")
  .action(
    async (
      options: {
        parentDataSourceId: string;
        itemsJson: string;
        concurrency?: string;
        returnView?: string;
        fields?: string;
        pretty?: boolean;
        timeoutMs?: string;
      },
    ) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const parsedItems = parseJsonOption<unknown>("items-json", options.itemsJson);
        if (!Array.isArray(parsedItems)) {
          throw new CliError("invalid_input", "items-json must be a JSON array.");
        }

        const items = parsedItems.map((item, index) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new CliError("invalid_input", `items-json[${index}] must be an object.`);
          }
          const record = item as Record<string, unknown>;
          const properties =
            record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
              ? (record.properties as Record<string, unknown>)
              : record;

          return {
            propertiesPatch: properties,
          };
        });

        const view = resolveReturnView(options.returnView);
        const fields = parseCommaFields(options.fields);
        const concurrency = parsePositiveInt(
          options.concurrency,
          "concurrency",
          config.defaults.bulk_create_concurrency,
        );

        const result = await executeMutationWithIdempotency({
          commandName: "pages.create_bulk",
          requestId,
          requestShape: {
            parent_data_source_id: options.parentDataSourceId,
            items,
            view,
            fields,
            concurrency,
          },
          targetIds: [options.parentDataSourceId],
          run: () =>
            createPagesBulk(
              {
                notion,
                config,
                saveConfig,
              },
              {
                parentDataSourceId: options.parentDataSourceId,
                items,
                view,
                fields,
                concurrency,
              },
            ),
        });

        return {
          data: result,
        };
      });
    },
  );

addCommonMutationOptions(pagesCommand.command("update").description("Update a page"))
  .requiredOption("--id <page_id>", "Notion page ID")
  .requiredOption("--patch-json <json>", "JSON object of property changes")
  .action(
    async (
      options: {
        id: string;
        patchJson: string;
        returnView?: string;
        fields?: string;
        pretty?: boolean;
        timeoutMs?: string;
      },
    ) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const patch = requireObjectJson(options.patchJson, "patch-json");
        const view = resolveReturnView(options.returnView);
        const fields = parseCommaFields(options.fields);

        const page = await executeMutationWithIdempotency({
          commandName: "pages.update",
          requestId,
          requestShape: {
            page_id: options.id,
            patch,
            view,
            fields,
          },
          targetIds: [options.id],
          run: () =>
            updatePage(
              {
                notion,
                config,
                saveConfig,
              },
              {
                pageId: options.id,
                patch,
                view,
                fields,
              },
            ),
        });

        return {
          data: {
            page,
          },
        };
      });
    },
  );

addCommonMutationOptions(pagesCommand.command("archive").description("Archive a page"))
  .requiredOption("--id <page_id>", "Notion page ID")
  .action(
    async (options: {
      id: string;
      returnView?: string;
      fields?: string;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const view = resolveReturnView(options.returnView);
        const fields = parseCommaFields(options.fields);

        const page = await executeMutationWithIdempotency({
          commandName: "pages.archive",
          requestId,
          requestShape: {
            page_id: options.id,
            view,
            fields,
          },
          targetIds: [options.id],
          run: () =>
            archivePage(
              {
                notion,
                config,
                saveConfig,
              },
              {
                pageId: options.id,
                view,
                fields,
              },
            ),
        });

        return {
          data: {
            page,
          },
        };
      });
    },
  );

addCommonMutationOptions(pagesCommand.command("unarchive").description("Unarchive a page"))
  .requiredOption("--id <page_id>", "Notion page ID")
  .action(
    async (options: {
      id: string;
      returnView?: string;
      fields?: string;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const view = resolveReturnView(options.returnView);
        const fields = parseCommaFields(options.fields);

        const page = await executeMutationWithIdempotency({
          commandName: "pages.unarchive",
          requestId,
          requestShape: {
            page_id: options.id,
            view,
            fields,
          },
          targetIds: [options.id],
          run: () =>
            unarchivePage(
              {
                notion,
                config,
                saveConfig,
              },
              {
                pageId: options.id,
                view,
                fields,
              },
            ),
        });

        return {
          data: {
            page,
          },
        };
      });
    },
  );

addCommonMutationOptions(pagesCommand.command("relate").description("Add a relation link between pages"))
  .requiredOption("--from-id <page_id>", "Source page ID")
  .requiredOption("--property <property_name>", "Relation property name on source page")
  .requiredOption("--to-id <page_id>", "Target page ID")
  .action(
    async (options: {
      fromId: string;
      property: string;
      toId: string;
      returnView?: string;
      fields?: string;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const view = resolveReturnView(options.returnView);
        const fields = parseCommaFields(options.fields);

        const page = await executeMutationWithIdempotency({
          commandName: "pages.relate",
          requestId,
          requestShape: {
            from_id: options.fromId,
            property: options.property,
            to_id: options.toId,
            view,
            fields,
          },
          targetIds: [options.fromId, options.toId],
          run: () =>
            setRelation(
              {
                notion,
                config,
                saveConfig,
              },
              {
                fromId: options.fromId,
                toId: options.toId,
                property: options.property,
                mode: "add",
                view,
                fields,
              },
            ),
        });

        return {
          data: {
            page,
          },
        };
      });
    },
  );

addCommonMutationOptions(
  pagesCommand.command("unrelate").description("Remove a relation link between pages"),
)
  .requiredOption("--from-id <page_id>", "Source page ID")
  .requiredOption("--property <property_name>", "Relation property name on source page")
  .requiredOption("--to-id <page_id>", "Target page ID")
  .action(
    async (options: {
      fromId: string;
      property: string;
      toId: string;
      returnView?: string;
      fields?: string;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const view = resolveReturnView(options.returnView);
        const fields = parseCommaFields(options.fields);

        const page = await executeMutationWithIdempotency({
          commandName: "pages.unrelate",
          requestId,
          requestShape: {
            from_id: options.fromId,
            property: options.property,
            to_id: options.toId,
            view,
            fields,
          },
          targetIds: [options.fromId, options.toId],
          run: () =>
            setRelation(
              {
                notion,
                config,
                saveConfig,
              },
              {
                fromId: options.fromId,
                toId: options.toId,
                property: options.property,
                mode: "remove",
                view,
                fields,
              },
            ),
        });

        return {
          data: {
            page,
          },
        };
      });
    },
  );

const blocksCommand = program.command("blocks").description("Block operations");

blocksCommand
  .command("get")
  .description("Get blocks from a page or block")
  .requiredOption("--id <page_or_block_id>", "Notion page or block ID")
  .option("--max-blocks <n>", "Maximum block count")
  .option("--depth <n>", "Recursion depth", "1")
  .option("--format <markdown|compact|full>", "content format", "markdown")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(
    async (options: {
      id: string;
      maxBlocks?: string;
      depth?: string;
      format?: string;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async () => {
        const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const maxBlocks = parsePositiveInt(options.maxBlocks, "max-blocks", config.defaults.max_blocks);
        const depth = parsePositiveInt(options.depth, "depth", 1);
        const format = resolveBlockReadFormat(options.format, "markdown");

        const blocks = await getBlocks(notion, options.id, maxBlocks, depth, format);
        return {
          data: blocks,
        };
      });
    },
  );

const blocksAppendCommand = blocksCommand
  .command("append")
  .description("Append blocks to a page or block")
  .requiredOption("--id <page_or_block_id>", "Notion page or block ID")
  .option("--blocks-json <json>", "JSON array of block children")
  .option("--markdown <text>", "markdown content to convert and append")
  .option("--markdown-file <path>", "path to markdown file to convert and append")
  .option("--dry-run", "Return append plan without mutating")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(
    async (options: {
      id: string;
      blocksJson?: string;
      markdown?: string;
      markdownFile?: string;
      dryRun?: boolean;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const blocks = await resolveBlocksInput({
          blocksJson: options.blocksJson,
          markdown: options.markdown,
          markdownFile: options.markdownFile,
        });

        const result = await executeMutationWithIdempotency({
          commandName: options.dryRun ? "blocks.append.dry_run" : "blocks.append",
          requestId,
          requestShape: {
            id: options.id,
            blocks,
            dry_run: Boolean(options.dryRun),
          },
          targetIds: [options.id],
          run: () =>
            appendBlocks(notion, {
              parentId: options.id,
              blocks,
              dryRun: Boolean(options.dryRun),
            }),
        });

        return {
          data: result,
        };
      });
    },
  );
blocksAppendCommand.addHelpText("after", BLOCKS_APPEND_HELP_EPILOG);

const blocksInsertCommand = blocksCommand
  .command("insert")
  .description("Insert blocks at a specific position")
  .requiredOption("--parent-id <page_or_block_id>", "Notion page or block ID to insert into")
  .option("--position <start|end>", "insert position when --after-id is not used", "end")
  .option("--after-id <block_id>", "insert after an existing sibling block")
  .option("--blocks-json <json>", "JSON array of block children")
  .option("--markdown <text>", "markdown content to convert and insert")
  .option("--markdown-file <path>", "path to markdown file to convert and insert")
  .option("--dry-run", "Return insert plan without mutating")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(
    async (options: {
      parentId: string;
      position?: string;
      afterId?: string;
      blocksJson?: string;
      markdown?: string;
      markdownFile?: string;
      dryRun?: boolean;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const blocks = await resolveBlocksInput({
          blocksJson: options.blocksJson,
          markdown: options.markdown,
          markdownFile: options.markdownFile,
        });
        const position = resolveInsertPosition(options.position, options.afterId);

        const result = await executeMutationWithIdempotency({
          commandName: options.dryRun ? "blocks.insert.dry_run" : "blocks.insert",
          requestId,
          requestShape: {
            parent_id: options.parentId,
            position,
            blocks,
            dry_run: Boolean(options.dryRun),
          },
          targetIds: [options.parentId, options.afterId].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
          run: () =>
            insertBlocks(notion, {
              parentId: options.parentId,
              blocks,
              position,
              dryRun: Boolean(options.dryRun),
            }),
        });

        return {
          data: result,
        };
      });
    },
  );
blocksInsertCommand.addHelpText("after", BLOCKS_INSERT_HELP_EPILOG);

const blocksSelectCommand = blocksCommand
  .command("select")
  .description("Resolve selector matches within a page/block scope")
  .requiredOption("--scope-id <page_or_block_id>", "Notion page or block ID to search within")
  .requiredOption("--selector-json <json>", "selector JSON object")
  .option("--scan-max-blocks <n>", "maximum blocks to scan while resolving selectors")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(
    async (options: {
      scopeId: string;
      selectorJson: string;
      scanMaxBlocks?: string;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async () => {
        const { notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const selector = requireSelectorJson(options.selectorJson, "selector-json");
        const maxBlocks = parsePositiveInt(options.scanMaxBlocks, "scan-max-blocks", 5000);
        const result = await selectBlocks(notion, {
          scopeId: options.scopeId,
          selector,
          maxBlocks,
        });
        return {
          data: result,
        };
      });
    },
  );
blocksSelectCommand.addHelpText("after", BLOCKS_SELECT_HELP_EPILOG);

const blocksReplaceRangeCommand = blocksCommand
  .command("replace-range")
  .description("Replace a selector-defined block range with new content")
  .requiredOption("--scope-id <page_or_block_id>", "Notion page or block ID to search within")
  .requiredOption("--start-selector-json <json>", "start selector JSON object")
  .requiredOption("--end-selector-json <json>", "end selector JSON object")
  .option("--blocks-json <json>", "JSON array of replacement block children")
  .option("--markdown <text>", "markdown replacement content")
  .option("--markdown-file <path>", "path to markdown replacement content")
  .option("--scan-max-blocks <n>", "maximum blocks to scan while resolving selectors")
  .option("--no-inclusive-start", "exclude the start selector block from the replace range")
  .option("--no-inclusive-end", "exclude the end selector block from the replace range")
  .option("--dry-run", "Return replacement plan without mutating")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(
    async (options: {
      scopeId: string;
      startSelectorJson: string;
      endSelectorJson: string;
      blocksJson?: string;
      markdown?: string;
      markdownFile?: string;
      scanMaxBlocks?: string;
      inclusiveStart?: boolean;
      inclusiveEnd?: boolean;
      dryRun?: boolean;
      pretty?: boolean;
      timeoutMs?: string;
    }) => {
      await runAction(Boolean(options.pretty), async (requestId) => {
        const { notion } = await loadRuntime({ timeoutMs: options.timeoutMs });
        const blocks = await resolveBlocksInput({
          blocksJson: options.blocksJson,
          markdown: options.markdown,
          markdownFile: options.markdownFile,
        });
        const startSelector = requireSelectorJson(
          options.startSelectorJson,
          "start-selector-json",
        );
        const endSelector = requireSelectorJson(options.endSelectorJson, "end-selector-json");
        const maxBlocks = parsePositiveInt(options.scanMaxBlocks, "scan-max-blocks", 5000);

        const result = await executeMutationWithIdempotency({
          commandName: options.dryRun ? "blocks.replace_range.dry_run" : "blocks.replace_range",
          requestId,
          requestShape: {
            scope_id: options.scopeId,
            start_selector: startSelector,
            end_selector: endSelector,
            blocks,
            inclusive_start: options.inclusiveStart !== false,
            inclusive_end: options.inclusiveEnd !== false,
            scan_max_blocks: maxBlocks,
            dry_run: Boolean(options.dryRun),
          },
          targetIds: [options.scopeId],
          run: () =>
            replaceBlockRange(notion, {
              scopeId: options.scopeId,
              startSelector,
              endSelector,
              blocks,
              inclusiveStart: options.inclusiveStart !== false,
              inclusiveEnd: options.inclusiveEnd !== false,
              dryRun: Boolean(options.dryRun),
              maxBlocks,
            }),
        });

        return {
          data: result,
        };
      });
    },
  );
blocksReplaceRangeCommand.addHelpText("after", BLOCKS_REPLACE_RANGE_HELP_EPILOG);

program
  .command("doctor")
  .description("Validate config and auth quickly")
  .option("--pretty", "pretty-print JSON output")
  .option("--timeout-ms <n>", "request timeout in milliseconds")
  .action(async (options: { pretty?: boolean; timeoutMs?: string }) => {
    await runAction(Boolean(options.pretty), async () => {
      const { config, notion } = await loadRuntime({ timeoutMs: options.timeoutMs });

      await notion.search({ page_size: 1 });

      return {
        data: {
          config_path: getConfigPath(),
          notion_api_key_env: config.notion_api_key_env,
          status: "ok",
        },
      };
    });
  });

await program.parseAsync(process.argv);

import { AppConfig } from "../config/types.js";
import { CliError, toCliError } from "../errors/cli-error.js";
import { NotionClientAdapter } from "./client.js";
import {
  toCompactDataSource,
  toCompactPage,
  toFullDataSource,
  toFullPage,
  toSearchResult,
} from "./mappers.js";
import { buildPropertiesPayloadGeneric } from "./properties.js";

export interface PaginationResult {
  has_more: boolean;
  next_cursor: string | null;
  returned: number;
}

export interface QueryPagesInput {
  dataSourceId: string;
  limit: number;
  cursor?: string;
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
  view: "compact" | "full";
  fields?: string[];
}

export interface RepositoryContext {
  notion: NotionClientAdapter;
  config: AppConfig;
  saveConfig: (config: AppConfig) => Promise<void>;
}

export interface SearchWorkspaceInput {
  query: string;
  limit: number;
  cursor?: string;
  scope?: string;
  createdAfter?: string;
  createdBefore?: string;
  editedAfter?: string;
  editedBefore?: string;
  createdBy?: string;
  object?: "page" | "data_source";
  scanLimit: number;
}

export interface SearchWorkspaceResult {
  results: Record<string, unknown>[];
  pagination: PaginationResult;
  scan_count: number;
}

export interface CreateBulkInput {
  parentDataSourceId: string;
  items: Array<{
    propertiesPatch: Record<string, unknown>;
  }>;
  view: "compact" | "full";
  fields?: string[];
  concurrency: number;
}

function getStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new CliError("internal_error", "Expected object response from Notion API.");
  }
  return value as Record<string, unknown>;
}

function asPage(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record.object !== "page") {
    throw new CliError("invalid_input", "Expected a page object.");
  }
  return record;
}

function asDataSource(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record.object !== "data_source") {
    throw new CliError("invalid_input", "Expected a data source object.");
  }
  return record;
}

function parseTimestampMs(raw: string | undefined): number {
  if (!raw) {
    return Number.NaN;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function isSchemaStale(entry: { last_refreshed: string }, ttlHours: number): boolean {
  const refreshedAtMs = parseTimestampMs(entry.last_refreshed);
  if (Number.isNaN(refreshedAtMs)) {
    return true;
  }
  const ttlMs = ttlHours * 60 * 60 * 1000;
  return Date.now() - refreshedAtMs > ttlMs;
}

async function hydrateDataSourceSchema(
  ctx: RepositoryContext,
  dataSourceId: string,
  forceRefresh = false,
): Promise<Record<string, { id: string; type: string }>> {
  const cached = ctx.config.schema_cache[dataSourceId];
  if (!forceRefresh && cached && !isSchemaStale(cached, ctx.config.defaults.schema_ttl_hours)) {
    return cached.properties;
  }

  const dataSource = asDataSource(await ctx.notion.retrieveDataSource(dataSourceId));
  const properties = (dataSource.properties ?? {}) as Record<string, { id?: string; type?: string }>;

  const normalizedProperties: Record<string, { id: string; type: string }> = {};
  for (const [name, property] of Object.entries(properties)) {
    normalizedProperties[name] = {
      id: property.id ?? "",
      type: property.type ?? "unknown",
    };
  }

  ctx.config.schema_cache[dataSourceId] = {
    data_source_id: dataSourceId,
    last_refreshed: new Date().toISOString(),
    properties: normalizedProperties,
  };
  await ctx.saveConfig(ctx.config);

  return normalizedProperties;
}

async function buildPropertiesForDataSource(
  ctx: RepositoryContext,
  dataSourceId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let schema = await hydrateDataSourceSchema(ctx, dataSourceId);

  try {
    return buildPropertiesPayloadGeneric(patch, schema);
  } catch {
    schema = await hydrateDataSourceSchema(ctx, dataSourceId, true);
    return buildPropertiesPayloadGeneric(patch, schema);
  }
}

function extractParentDataSourceId(page: Record<string, unknown>): string | null {
  const parent = page.parent;
  if (!parent || typeof parent !== "object") {
    return null;
  }

  const record = parent as Record<string, unknown>;
  const type = record.type;
  if (type === "data_source_id" && typeof record.data_source_id === "string") {
    return record.data_source_id;
  }

  if (type === "database_id" && typeof record.database_id === "string") {
    return record.database_id;
  }

  return null;
}

function readRelationProperty(page: Record<string, unknown>, propertyName: string): string[] {
  const properties = page.properties;
  if (!properties || typeof properties !== "object") {
    throw new CliError("invalid_input", `Page does not include property ${propertyName}.`);
  }

  const property = (properties as Record<string, unknown>)[propertyName];
  if (!property || typeof property !== "object") {
    throw new CliError("invalid_input", `Property ${propertyName} was not found on the page.`);
  }

  const relation = property as { type?: unknown; relation?: Array<{ id?: string }> };
  if (relation.type !== "relation") {
    throw new CliError("invalid_input", `Property ${propertyName} is not a relation property.`);
  }

  return (relation.relation ?? [])
    .map((item) => item.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function withBestEffortPageMutation(
  ctx: RepositoryContext,
  pageId: string,
  apply: (currentPage: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const attempts = 2;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const currentPage = asPage(await ctx.notion.retrievePage(pageId));
    try {
      return await apply(currentPage);
    } catch (error) {
      const status = getStatus(error);
      if (status === 409 && attempt < attempts) {
        continue;
      }
      throw error;
    }
  }

  throw new CliError("conflict", "Could not apply mutation due to concurrent updates.");
}

function extractParentId(item: Record<string, unknown>): string | null {
  const parent = item.parent;
  if (!parent || typeof parent !== "object") {
    return null;
  }

  const record = parent as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  if (!type) {
    return null;
  }

  const value = record[type];
  return typeof value === "string" ? value : null;
}

function matchesDateConstraint(timestamp: string | undefined, after?: string, before?: string): boolean {
  const value = parseTimestampMs(timestamp);
  if (Number.isNaN(value)) {
    return false;
  }

  if (after) {
    const min = parseTimestampMs(after);
    if (!Number.isNaN(min) && value < min) {
      return false;
    }
  }

  if (before) {
    const max = parseTimestampMs(before);
    if (!Number.isNaN(max) && value > max) {
      return false;
    }
  }

  return true;
}

function matchesSearchFilters(item: Record<string, unknown>, input: SearchWorkspaceInput): boolean {
  if (input.object && item.object !== input.object) {
    return false;
  }

  if (input.scope) {
    const id = typeof item.id === "string" ? item.id : "";
    const parentId = extractParentId(item);
    if (id !== input.scope && parentId !== input.scope) {
      return false;
    }
  }

  if (input.createdBy) {
    const createdBy = item.created_by as { id?: unknown } | undefined;
    if (typeof createdBy?.id !== "string" || createdBy.id !== input.createdBy) {
      return false;
    }
  }

  if (input.createdAfter || input.createdBefore) {
    const createdTime = typeof item.created_time === "string" ? item.created_time : undefined;
    if (!matchesDateConstraint(createdTime, input.createdAfter, input.createdBefore)) {
      return false;
    }
  }

  if (input.editedAfter || input.editedBefore) {
    const editedTime =
      typeof item.last_edited_time === "string" ? item.last_edited_time : undefined;
    if (!matchesDateConstraint(editedTime, input.editedAfter, input.editedBefore)) {
      return false;
    }
  }

  return true;
}

export async function searchWorkspace(
  notion: NotionClientAdapter,
  input: SearchWorkspaceInput,
): Promise<SearchWorkspaceResult> {
  if (!input.query || input.query.trim().length === 0) {
    throw new CliError("invalid_input", "search requires a non-empty --query value.");
  }

  const limit = Math.min(Math.max(1, input.limit), 100);
  const scanLimit = Math.max(limit, input.scanLimit);
  const results: Record<string, unknown>[] = [];

  let scanned = 0;
  let cursor = input.cursor;
  let hasMore = false;
  let nextCursor: string | null = null;

  while (results.length < limit && scanned < scanLimit) {
    const remaining = limit - results.length;
    const remainingScanBudget = scanLimit - scanned;
    const payload: Record<string, unknown> = {
      query: input.query,
      page_size: Math.min(100, Math.max(1, Math.min(remaining, remainingScanBudget))),
    };
    if (cursor) {
      payload.start_cursor = cursor;
    }
    if (input.object) {
      payload.filter = {
        property: "object",
        value: input.object,
      };
    }

    const response = (await notion.search(payload)) as {
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    const batch = response.results ?? [];
    scanned += batch.length;

    for (const raw of batch) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const item = raw as Record<string, unknown>;
      if (matchesSearchFilters(item, input)) {
        results.push(toSearchResult(item));
      }
    }

    hasMore = Boolean(response.has_more);
    nextCursor = response.next_cursor ?? null;

    if (results.length >= limit) {
      break;
    }

    if (!hasMore || !nextCursor) {
      break;
    }

    if (scanned >= scanLimit) {
      break;
    }

    cursor = nextCursor;
  }

  return {
    results,
    pagination: {
      has_more: hasMore && nextCursor !== null,
      next_cursor: hasMore ? nextCursor : null,
      returned: results.length,
    },
    scan_count: scanned,
  };
}

export async function listDataSources(
  notion: NotionClientAdapter,
  input: { query?: string; limit: number; cursor?: string },
): Promise<{ data_sources: Record<string, unknown>[]; pagination: PaginationResult }> {
  const payload: Record<string, unknown> = {
    page_size: Math.min(Math.max(1, input.limit), 100),
    filter: {
      property: "object",
      value: "data_source",
    },
  };

  if (input.query && input.query.trim().length > 0) {
    payload.query = input.query;
  }

  if (input.cursor) {
    payload.start_cursor = input.cursor;
  }

  const response = (await notion.search(payload)) as {
    results?: unknown[];
    has_more?: boolean;
    next_cursor?: string | null;
  };

  const dataSources = (response.results ?? []).map((item) => toCompactDataSource(asDataSource(item)));

  return {
    data_sources: dataSources,
    pagination: {
      has_more: Boolean(response.has_more),
      next_cursor: response.next_cursor ?? null,
      returned: dataSources.length,
    },
  };
}

export async function getDataSource(
  notion: NotionClientAdapter,
  dataSourceId: string,
  view: "compact" | "full",
): Promise<Record<string, unknown>> {
  const dataSource = asDataSource(await notion.retrieveDataSource(dataSourceId));
  return view === "full" ? toFullDataSource(dataSource) : toCompactDataSource(dataSource);
}

export async function getDataSourceSchema(
  notion: NotionClientAdapter,
  dataSourceId: string,
): Promise<Record<string, unknown>> {
  const dataSource = asDataSource(await notion.retrieveDataSource(dataSourceId));
  const full = toFullDataSource(dataSource);
  return {
    data_source_id: full.id,
    name: full.name,
    properties: full.properties,
  };
}

export async function queryDataSourcePages(
  ctx: RepositoryContext,
  input: QueryPagesInput,
): Promise<{ records: Record<string, unknown>[]; pagination: PaginationResult }> {
  const payload: Record<string, unknown> = {
    data_source_id: input.dataSourceId,
    page_size: Math.min(Math.max(1, input.limit), 100),
  };

  if (input.cursor) {
    payload.start_cursor = input.cursor;
  }
  if (input.filter) {
    payload.filter = input.filter;
  }
  if (input.sorts && input.sorts.length > 0) {
    payload.sorts = input.sorts;
  }

  const response = (await ctx.notion.queryDataSource(payload)) as {
    results?: unknown[];
    has_more?: boolean;
    next_cursor?: string | null;
  };

  const pages = (response.results ?? []).map(asPage);
  const records =
    input.view === "full"
      ? pages.map((page) => toFullPage(page))
      : pages.map((page) => toCompactPage(page, input.fields));

  return {
    records,
    pagination: {
      has_more: Boolean(response.has_more),
      next_cursor: response.next_cursor ?? null,
      returned: records.length,
    },
  };
}

export async function getPage(
  notion: NotionClientAdapter,
  pageId: string,
  view: "compact" | "full",
  fields?: string[],
): Promise<Record<string, unknown>> {
  const page = asPage(await notion.retrievePage(pageId));
  return view === "full" ? toFullPage(page) : toCompactPage(page, fields);
}

export async function createPage(
  ctx: RepositoryContext,
  input: {
    parentDataSourceId: string;
    propertiesPatch: Record<string, unknown>;
    view: "compact" | "full";
    fields?: string[];
  },
): Promise<Record<string, unknown>> {
  const properties = await buildPropertiesForDataSource(
    ctx,
    input.parentDataSourceId,
    input.propertiesPatch,
  );

  const page = asPage(
    await ctx.notion.createPage({
      parent: { data_source_id: input.parentDataSourceId },
      properties,
    }),
  );

  return input.view === "full" ? toFullPage(page) : toCompactPage(page, input.fields);
}

export async function createPagesBulk(
  ctx: RepositoryContext,
  input: CreateBulkInput,
): Promise<Record<string, unknown>> {
  if (input.items.length === 0) {
    throw new CliError("invalid_input", "create-bulk requires at least one item.");
  }
  if (input.items.length > 100) {
    throw new CliError("invalid_input", "create-bulk supports at most 100 items per request.");
  }

  const concurrency = Math.min(Math.max(1, input.concurrency), 20);
  const results: Array<Record<string, unknown>> = new Array(input.items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= input.items.length) {
        return;
      }

      const item = input.items[index];
      try {
        const properties = await buildPropertiesForDataSource(
          ctx,
          input.parentDataSourceId,
          item.propertiesPatch,
        );

        const page = asPage(
          await ctx.notion.createPage({
            parent: { data_source_id: input.parentDataSourceId },
            properties,
          }),
        );

        results[index] = {
          index,
          ok: true,
          page:
            input.view === "full" ? toFullPage(page) : toCompactPage(page, input.fields),
        };
      } catch (error) {
        const cliError = toCliError(error);
        results[index] = {
          index,
          ok: false,
          error: {
            code: cliError.code,
            message: cliError.message,
          },
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, input.items.length) }, () => worker()));

  const created = results.filter((item) => item.ok === true).length;
  const failed = results.length - created;

  return {
    items: results,
    summary: {
      requested: results.length,
      created,
      failed,
    },
  };
}

export async function updatePage(
  ctx: RepositoryContext,
  input: {
    pageId: string;
    patch: Record<string, unknown>;
    view: "compact" | "full";
    fields?: string[];
  },
): Promise<Record<string, unknown>> {
  const updatedPage = await withBestEffortPageMutation(ctx, input.pageId, async (currentPage) => {
    const parentDataSourceId = extractParentDataSourceId(currentPage);
    if (!parentDataSourceId) {
      throw new CliError(
        "invalid_input",
        "Page is not part of a data source. This command currently supports data-source pages.",
      );
    }

    const properties = await buildPropertiesForDataSource(ctx, parentDataSourceId, input.patch);

    return asPage(
      await ctx.notion.updatePage({
        page_id: input.pageId,
        properties,
      }),
    );
  });

  return input.view === "full" ? toFullPage(updatedPage) : toCompactPage(updatedPage, input.fields);
}

export async function archivePage(
  ctx: RepositoryContext,
  input: {
    pageId: string;
    view: "compact" | "full";
    fields?: string[];
  },
): Promise<Record<string, unknown>> {
  const updatedPage = await withBestEffortPageMutation(ctx, input.pageId, async () =>
    asPage(
      await ctx.notion.updatePage({
        page_id: input.pageId,
        archived: true,
      }),
    ),
  );

  return input.view === "full" ? toFullPage(updatedPage) : toCompactPage(updatedPage, input.fields);
}

export async function unarchivePage(
  ctx: RepositoryContext,
  input: {
    pageId: string;
    view: "compact" | "full";
    fields?: string[];
  },
): Promise<Record<string, unknown>> {
  const updatedPage = await withBestEffortPageMutation(ctx, input.pageId, async () =>
    asPage(
      await ctx.notion.updatePage({
        page_id: input.pageId,
        archived: false,
      }),
    ),
  );

  return input.view === "full" ? toFullPage(updatedPage) : toCompactPage(updatedPage, input.fields);
}

export async function setRelation(
  ctx: RepositoryContext,
  args: {
    fromId: string;
    toId: string;
    property: string;
    mode: "add" | "remove";
    view: "compact" | "full";
    fields?: string[];
  },
): Promise<Record<string, unknown>> {
  const updatedPage = await withBestEffortPageMutation(ctx, args.fromId, async (currentPage) => {
    const currentIds = new Set<string>(readRelationProperty(currentPage, args.property));

    if (args.mode === "add") {
      currentIds.add(args.toId);
    } else {
      currentIds.delete(args.toId);
    }

    return asPage(
      await ctx.notion.updatePage({
        page_id: args.fromId,
        properties: {
          [args.property]: {
            relation: Array.from(currentIds).map((id) => ({ id })),
          },
        },
      }),
    );
  });

  return args.view === "full"
    ? toFullPage(updatedPage)
    : toCompactPage(updatedPage, args.fields);
}

export interface BlockSelector {
  where?: {
    type?: string;
    text_contains?: string;
    parent_id?: string;
  };
  nth?: number;
  from?: "start" | "end";
}

export type BlockInsertPosition =
  | {
      type: "start";
    }
  | {
      type: "end";
    }
  | {
      type: "after_block";
      after_block: {
        id: string;
      };
    };

interface FlatBlock {
  id: string;
  parent_id: string;
  type: string | null;
  text: string;
  has_children: boolean;
  last_edited_time: string | null;
  sibling_index: number;
  order_index: number;
}

export type BlockReadFormat = "compact" | "full" | "markdown";

function extractBlockText(block: Record<string, unknown>): string | null {
  const type = block.type;
  if (typeof type !== "string") {
    return null;
  }

  const typedData = block[type] as Record<string, unknown> | undefined;
  if (!typedData || typeof typedData !== "object") {
    return null;
  }

  const richText = typedData.rich_text;
  if (!Array.isArray(richText)) {
    return null;
  }

  return richText
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const plain = (item as { plain_text?: unknown }).plain_text;
      return typeof plain === "string" ? plain : "";
    })
    .join("");
}

function richTextToMarkdown(richTextArray: Array<Record<string, unknown>>): string {
  return richTextArray
    .map((item) => {
      if (!item || typeof item !== "object") return "";

      const plain = (item as { plain_text?: unknown }).plain_text;
      if (typeof plain !== "string") return "";

      const annotations = (item as { annotations?: Record<string, unknown> }).annotations;
      const href =
        (item as { href?: unknown }).href ??
        ((item as { text?: { link?: { url?: unknown } } }).text?.link?.url ?? null);

      let result = plain;

      if (annotations?.code) {
        result = `\`${result}\``;
      } else {
        if (annotations?.bold && annotations?.italic) {
          result = `***${result}***`;
        } else if (annotations?.bold) {
          result = `**${result}**`;
        } else if (annotations?.italic) {
          result = `*${result}*`;
        }
        if (annotations?.strikethrough) {
          result = `~~${result}~~`;
        }
      }

      if (typeof href === "string") {
        result = `[${result}](${href})`;
      }

      return result;
    })
    .join("");
}

function extractBlockMarkdown(block: Record<string, unknown>): string | null {
  const type = block.type;
  if (typeof type !== "string") return null;

  const typedData = block[type] as Record<string, unknown> | undefined;
  if (!typedData || typeof typedData !== "object") return null;

  const richText = typedData.rich_text;
  if (!Array.isArray(richText)) return null;

  return richTextToMarkdown(richText);
}

function toCompactBlock(block: Record<string, unknown>): Record<string, unknown> {
  return {
    id: block.id ?? null,
    type: block.type ?? null,
    has_children: Boolean(block.has_children),
    text: extractBlockText(block),
  };
}

function collectRenderableChildren(block: Record<string, unknown>): Array<Record<string, unknown>> {
  const children = block.children;
  if (!Array.isArray(children)) {
    return [];
  }

  return children.filter(
    (child): child is Record<string, unknown> => Boolean(child && typeof child === "object"),
  );
}

function getCodeLanguage(block: Record<string, unknown>): string {
  if (block.type !== "code") {
    return "";
  }

  const code = block.code;
  if (!code || typeof code !== "object") {
    return "";
  }

  const language = (code as { language?: unknown }).language;
  return typeof language === "string" ? language : "";
}

function getChildPageTitle(block: Record<string, unknown>): string {
  if (block.type !== "child_page") {
    return "";
  }

  const childPage = block.child_page;
  if (!childPage || typeof childPage !== "object") {
    return "";
  }

  const title = (childPage as { title?: unknown }).title;
  return typeof title === "string" ? title : "";
}

function isTodoChecked(block: Record<string, unknown>): boolean {
  if (block.type !== "to_do") {
    return false;
  }

  const todo = block.to_do;
  if (!todo || typeof todo !== "object") {
    return false;
  }

  return (todo as { checked?: unknown }).checked === true;
}

function renderQuoteMarkdown(text: string, indent: string): string {
  const lines = text.length > 0 ? text.split("\n") : [""];
  return lines.map((line) => `${indent}> ${line}`).join("\n");
}

function renderBlockToMarkdown(block: Record<string, unknown>, depth: number): string {
  const type = typeof block.type === "string" ? block.type : "unsupported";
  const text = extractBlockMarkdown(block) ?? "";
  const indent = "  ".repeat(depth);
  const children = collectRenderableChildren(block);
  const childMarkdown = children.length > 0 ? renderBlocksToMarkdown(children, depth + 1) : "";

  const withChildren = (head: string, inlineChildren = false): string => {
    if (!childMarkdown) {
      return head;
    }
    if (inlineChildren) {
      return `${head}\n${childMarkdown}`;
    }
    if (!head) {
      return childMarkdown;
    }
    return `${head}\n\n${childMarkdown}`;
  };

  switch (type) {
    case "heading_1":
      return withChildren(`${indent}# ${text}`);
    case "heading_2":
      return withChildren(`${indent}## ${text}`);
    case "heading_3":
      return withChildren(`${indent}### ${text}`);
    case "paragraph":
      return withChildren(`${indent}${text}`);
    case "bulleted_list_item":
      return withChildren(`${indent}- ${text}`, true);
    case "numbered_list_item":
      return withChildren(`${indent}1. ${text}`, true);
    case "to_do": {
      const checked = isTodoChecked(block) ? "x" : " ";
      return withChildren(`${indent}- [${checked}] ${text}`, true);
    }
    case "quote":
      return withChildren(renderQuoteMarkdown(text, indent), true);
    case "code": {
      const language = getCodeLanguage(block);
      const fence = `${indent}\`\`\`${language}`;
      const close = `${indent}\`\`\``;
      return withChildren(`${fence}\n${text}\n${close}`);
    }
    case "divider":
      return withChildren(`${indent}---`);
    case "child_page": {
      const title = getChildPageTitle(block) || "Untitled";
      return withChildren(`${indent}[${title}]`);
    }
    case "toggle":
      return withChildren(`${indent}- ${text}`, true);
    case "image": {
      const img = block.image as Record<string, unknown> | undefined;
      let imgUrl = "";
      if (img) {
        if (img.type === "external") {
          const ext = img.external as { url?: string } | undefined;
          imgUrl = ext?.url ?? "";
        } else {
          const file = img.file as { url?: string } | undefined;
          imgUrl = file?.url ?? "";
        }
      }
      const caption = img && Array.isArray(img.caption) ? richTextToMarkdown(img.caption) : "";
      return withChildren(`${indent}![${caption}](${imgUrl})`);
    }
    case "table": {
      const tbl = block.table as { has_column_header?: boolean } | undefined;
      const rows = children;
      const rowLines: string[] = [];
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const tr = row.table_row as { cells?: Array<Array<Record<string, unknown>>> } | undefined;
        if (!tr?.cells) continue;
        const cellTexts = tr.cells.map(
          (cell) => richTextToMarkdown(cell).replace(/\|/g, "\\|"),
        );
        rowLines.push(`${indent}| ${cellTexts.join(" | ")} |`);
        if (ri === 0 && tbl?.has_column_header) {
          rowLines.push(`${indent}| ${cellTexts.map(() => "---").join(" | ")} |`);
        }
      }
      return rowLines.join("\n");
    }
    case "table_row":
      return "";
    default: {
      const fallback = text.length > 0 ? text : `[${type}]`;
      return withChildren(`${indent}${fallback}`);
    }
  }
}

function renderBlocksToMarkdown(blocks: Array<Record<string, unknown>>, depth: number): string {
  return blocks
    .map((block) => renderBlockToMarkdown(block, depth))
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n\n");
}

function normalizeSelector(raw: BlockSelector, label: string): Required<Pick<BlockSelector, "where" | "from">> & {
  nth?: number;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("invalid_input", `${label} must be a JSON object.`);
  }

  const whereRaw = raw.where;
  const where =
    whereRaw && typeof whereRaw === "object" && !Array.isArray(whereRaw)
      ? (whereRaw as Record<string, unknown>)
      : {};

  const fromRaw = raw.from;
  const from = fromRaw === undefined ? "start" : fromRaw;
  if (from !== "start" && from !== "end") {
    throw new CliError("invalid_input", `${label}.from must be either start or end.`);
  }

  const nthRaw = raw.nth;
  if (nthRaw !== undefined && (!Number.isInteger(nthRaw) || nthRaw < 1)) {
    throw new CliError("invalid_input", `${label}.nth must be a positive integer when provided.`);
  }

  const type = where.type;
  if (type !== undefined && typeof type !== "string") {
    throw new CliError("invalid_input", `${label}.where.type must be a string.`);
  }

  const textContains = where.text_contains;
  if (textContains !== undefined && typeof textContains !== "string") {
    throw new CliError("invalid_input", `${label}.where.text_contains must be a string.`);
  }

  const parentId = where.parent_id;
  if (parentId !== undefined && typeof parentId !== "string") {
    throw new CliError("invalid_input", `${label}.where.parent_id must be a string.`);
  }

  return {
    where: {
      type: typeof type === "string" ? type : undefined,
      text_contains: typeof textContains === "string" ? textContains : undefined,
      parent_id: typeof parentId === "string" ? parentId : undefined,
    },
    from,
    nth: nthRaw,
  };
}

function matchesSelector(block: FlatBlock, selector: ReturnType<typeof normalizeSelector>): boolean {
  if (selector.where.type && block.type !== selector.where.type) {
    return false;
  }

  if (selector.where.parent_id && block.parent_id !== selector.where.parent_id) {
    return false;
  }

  if (selector.where.text_contains) {
    const needle = selector.where.text_contains.toLowerCase();
    if (!block.text.toLowerCase().includes(needle)) {
      return false;
    }
  }

  return true;
}

function resolveSelectorStrict(
  blocks: FlatBlock[],
  selectorRaw: BlockSelector,
  label: string,
): { selected: FlatBlock; matches: FlatBlock[]; selector: ReturnType<typeof normalizeSelector> } {
  const selector = normalizeSelector(selectorRaw, label);
  const matches = blocks.filter((block) => matchesSelector(block, selector));

  if (matches.length === 0) {
    throw new CliError("not_found", `${label} matched no blocks.`);
  }

  if (selector.nth === undefined) {
    if (matches.length > 1) {
      throw new CliError(
        "conflict",
        `${label} matched ${matches.length} blocks. Provide nth and/or where.parent_id to disambiguate.`,
      );
    }
    return {
      selected: matches[0],
      matches,
      selector,
    };
  }

  const index = selector.from === "start" ? selector.nth - 1 : matches.length - selector.nth;
  if (index < 0 || index >= matches.length) {
    throw new CliError("not_found", `${label} nth=${selector.nth} is out of range for ${matches.length} matches.`);
  }

  return {
    selected: matches[index],
    matches,
    selector,
  };
}

function toSelectionPayload(block: FlatBlock): Record<string, unknown> {
  return {
    id: block.id,
    parent_id: block.parent_id,
    type: block.type,
    text: block.text,
    has_children: block.has_children,
    last_edited_time: block.last_edited_time,
    sibling_index: block.sibling_index,
    order_index: block.order_index,
  };
}

async function listDirectChildren(
  notion: NotionClientAdapter,
  parentId: string,
): Promise<Array<Record<string, unknown>>> {
  let cursor: string | undefined;
  const items: Array<Record<string, unknown>> = [];

  while (true) {
    const payload: Record<string, unknown> = {
      block_id: parentId,
      page_size: 100,
    };
    if (cursor) {
      payload.start_cursor = cursor;
    }

    const response = (await notion.listBlockChildren(payload)) as {
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const raw of response.results ?? []) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      items.push(raw as Record<string, unknown>);
    }

    if (!response.has_more || !response.next_cursor) {
      break;
    }
    cursor = response.next_cursor;
  }

  return items;
}

async function flattenScopeBlocks(
  notion: NotionClientAdapter,
  scopeId: string,
  maxBlocks: number,
): Promise<{ blocks: FlatBlock[]; siblingsByParent: Map<string, FlatBlock[]> }> {
  const blocks: FlatBlock[] = [];
  const siblingsByParent = new Map<string, FlatBlock[]>();

  const walk = async (parentId: string): Promise<void> => {
    const siblingsRaw = await listDirectChildren(notion, parentId);
    const siblings: FlatBlock[] = [];

    for (const [siblingIndex, block] of siblingsRaw.entries()) {
      const id = typeof block.id === "string" ? block.id : "";
      if (!id) {
        continue;
      }

      if (blocks.length >= maxBlocks) {
        throw new CliError(
          "invalid_input",
          `Selection scan exceeded max blocks (${maxBlocks}). Increase scan_max_blocks.`,
        );
      }

      const flat: FlatBlock = {
        id,
        parent_id: parentId,
        type: typeof block.type === "string" ? block.type : null,
        text: extractBlockText(block) ?? "",
        has_children: block.has_children === true,
        last_edited_time:
          typeof block.last_edited_time === "string" ? block.last_edited_time : null,
        sibling_index: siblingIndex,
        order_index: blocks.length,
      };
      blocks.push(flat);
      siblings.push(flat);
    }

    siblingsByParent.set(parentId, siblings);

    for (const sibling of siblings) {
      if (sibling.has_children) {
        await walk(sibling.id);
      }
    }
  };

  await walk(scopeId);
  return {
    blocks,
    siblingsByParent,
  };
}

function siblingsFingerprint(siblings: FlatBlock[]): string {
  return siblings.map((block) => `${block.id}:${block.last_edited_time ?? ""}`).join("|");
}

async function collectChildren(
  notion: NotionClientAdapter,
  args: {
    blockId: string;
    depth: number;
    maxBlocks: number;
    view: "compact" | "full";
  },
  state: { count: number; truncated: boolean },
): Promise<Array<Record<string, unknown>>> {
  let cursor: string | undefined;
  const results: Array<Record<string, unknown>> = [];

  while (state.count < args.maxBlocks) {
    const payload: Record<string, unknown> = {
      block_id: args.blockId,
      page_size: 100,
    };
    if (cursor) {
      payload.start_cursor = cursor;
    }

    const response = (await notion.listBlockChildren(payload)) as {
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const rawBlock of response.results ?? []) {
      if (state.count >= args.maxBlocks) {
        state.truncated = true;
        break;
      }
      if (!rawBlock || typeof rawBlock !== "object") {
        continue;
      }

      state.count += 1;
      const block = rawBlock as Record<string, unknown>;
      const payloadBlock = args.view === "full" ? { ...block } : toCompactBlock(block);

      if (args.depth > 1 && block.has_children === true && typeof block.id === "string") {
        payloadBlock.children = await collectChildren(
          notion,
          {
            blockId: block.id,
            depth: args.depth - 1,
            maxBlocks: args.maxBlocks,
            view: args.view,
          },
          state,
        );
      }

      results.push(payloadBlock);
    }

    if (state.count >= args.maxBlocks) {
      if (response.has_more) {
        state.truncated = true;
      }
      break;
    }

    if (!response.has_more || !response.next_cursor) {
      break;
    }

    cursor = response.next_cursor;
  }

  return results;
}

export async function getBlocks(
  notion: NotionClientAdapter,
  pageOrBlockId: string,
  maxBlocks: number,
  depth: number,
  view: BlockReadFormat,
): Promise<Record<string, unknown>> {
  const state = { count: 0, truncated: false };
  const internalView = view === "markdown" ? "full" : view;
  const blocks = await collectChildren(
    notion,
    {
      blockId: pageOrBlockId,
      depth,
      maxBlocks,
      view: internalView,
    },
    state,
  );

  if (view === "markdown") {
    return {
      id: pageOrBlockId,
      content_markdown: renderBlocksToMarkdown(blocks, 0),
      returned_blocks: state.count,
      truncated: state.truncated,
      max_blocks: maxBlocks,
      depth,
      format: "markdown",
    };
  }

  return {
    id: pageOrBlockId,
    blocks,
    returned_blocks: state.count,
    truncated: state.truncated,
    max_blocks: maxBlocks,
    depth,
    format: view,
  };
}

function chunk<T>(items: T[], chunkSize: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    output.push(items.slice(index, index + chunkSize));
  }
  return output;
}

export async function insertBlocks(
  notion: NotionClientAdapter,
  args: {
    parentId: string;
    blocks: Array<Record<string, unknown>>;
    position: BlockInsertPosition;
    dryRun: boolean;
  },
): Promise<Record<string, unknown>> {
  if (args.blocks.length === 0) {
    throw new CliError("invalid_input", "At least one block is required.");
  }

  if (args.dryRun) {
    return {
      dry_run: true,
      parent_id: args.parentId,
      position: args.position,
      would_insert_count: args.blocks.length,
      block_types: args.blocks.map((block) => block.type ?? "unknown"),
    };
  }

  const chunks = chunk(args.blocks, 100);
  const insertedIds: string[] = [];
  let currentPosition: BlockInsertPosition = args.position;

  for (const children of chunks) {
    const payload: Record<string, unknown> = {
      block_id: args.parentId,
      children,
      position: currentPosition,
    };

    const response = (await notion.appendBlockChildren(payload)) as {
      results?: unknown[];
    };

    const chunkIds = (response.results ?? [])
      .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    insertedIds.push(...chunkIds);

    if (chunkIds.length > 0) {
      currentPosition = {
        type: "after_block",
        after_block: {
          id: chunkIds[chunkIds.length - 1],
        },
      };
    }
  }

  return {
    parent_id: args.parentId,
    position: args.position,
    inserted_count: args.blocks.length,
    inserted_ids: insertedIds,
  };
}

export async function appendBlocks(
  notion: NotionClientAdapter,
  args: {
    parentId: string;
    blocks: Array<Record<string, unknown>>;
    dryRun: boolean;
  },
): Promise<Record<string, unknown>> {
  const inserted = await insertBlocks(notion, {
    parentId: args.parentId,
    blocks: args.blocks,
    position: { type: "end" },
    dryRun: args.dryRun,
  });

  if (args.dryRun) {
    return {
      ...inserted,
      id: args.parentId,
      would_append_count: inserted.would_insert_count ?? args.blocks.length,
    };
  }

  return {
    id: args.parentId,
    appended_count: inserted.inserted_count ?? args.blocks.length,
    inserted_ids: inserted.inserted_ids ?? [],
  };
}

export async function selectBlocks(
  notion: NotionClientAdapter,
  args: {
    scopeId: string;
    selector: BlockSelector;
    maxBlocks: number;
  },
): Promise<Record<string, unknown>> {
  const selector = normalizeSelector(args.selector, "selector-json");
  const flattened = await flattenScopeBlocks(notion, args.scopeId, args.maxBlocks);
  const matches = flattened.blocks.filter((block) => matchesSelector(block, selector));

  if (matches.length === 0) {
    throw new CliError("not_found", "selector-json matched no blocks.");
  }

  let selected: FlatBlock | null = null;
  let ambiguous = false;

  if (selector.nth !== undefined) {
    const index = selector.from === "start" ? selector.nth - 1 : matches.length - selector.nth;
    if (index < 0 || index >= matches.length) {
      throw new CliError(
        "not_found",
        `selector-json nth=${selector.nth} is out of range for ${matches.length} matches.`,
      );
    }
    selected = matches[index];
  } else if (matches.length === 1) {
    selected = matches[0];
  } else {
    ambiguous = true;
  }

  return {
    scope_id: args.scopeId,
    selector,
    match_count: matches.length,
    ambiguous,
    selected: selected ? toSelectionPayload(selected) : null,
    matches: matches.map(toSelectionPayload),
  };
}

export async function replaceBlockRange(
  notion: NotionClientAdapter,
  args: {
    scopeId: string;
    startSelector: BlockSelector;
    endSelector: BlockSelector;
    blocks: Array<Record<string, unknown>>;
    inclusiveStart: boolean;
    inclusiveEnd: boolean;
    dryRun: boolean;
    maxBlocks: number;
  },
): Promise<Record<string, unknown>> {
  const flattened = await flattenScopeBlocks(notion, args.scopeId, args.maxBlocks);
  const start = resolveSelectorStrict(flattened.blocks, args.startSelector, "start-selector-json");
  const end = resolveSelectorStrict(flattened.blocks, args.endSelector, "end-selector-json");

  const startBlock = start.selected;
  const endBlock = end.selected;
  if (startBlock.parent_id !== endBlock.parent_id) {
    throw new CliError(
      "invalid_input",
      "start-selector-json and end-selector-json must resolve to siblings under the same parent block.",
    );
  }

  const siblings = flattened.siblingsByParent.get(startBlock.parent_id) ?? [];
  if (startBlock.sibling_index > endBlock.sibling_index) {
    throw new CliError(
      "invalid_input",
      "start-selector-json resolved after end-selector-json within the sibling order.",
    );
  }

  const replaceFrom = args.inclusiveStart ? startBlock.sibling_index : startBlock.sibling_index + 1;
  const replaceTo = args.inclusiveEnd ? endBlock.sibling_index : endBlock.sibling_index - 1;
  const blocksToDelete =
    replaceFrom <= replaceTo ? siblings.slice(replaceFrom, replaceTo + 1) : [];

  const insertPosition: BlockInsertPosition =
    replaceFrom === 0
      ? { type: "start" }
      : {
          type: "after_block",
          after_block: {
            id: siblings[replaceFrom - 1].id,
          },
        };

  const plan = {
    scope_id: args.scopeId,
    parent_id: startBlock.parent_id,
    start: toSelectionPayload(startBlock),
    end: toSelectionPayload(endBlock),
    inclusive_start: args.inclusiveStart,
    inclusive_end: args.inclusiveEnd,
    delete_ids: blocksToDelete.map((block) => block.id),
    delete_count: blocksToDelete.length,
    insert_position: insertPosition,
    insert_count: args.blocks.length,
  };

  if (args.dryRun) {
    return {
      dry_run: true,
      ...plan,
      block_types: args.blocks.map((block) => block.type ?? "unknown"),
    };
  }

  const beforeFingerprint = siblingsFingerprint(siblings);
  const currentSiblingsRaw = await listDirectChildren(notion, startBlock.parent_id);
  const currentSiblings: FlatBlock[] = currentSiblingsRaw
    .map((block, siblingIndex) => {
      const id = typeof block.id === "string" ? block.id : "";
      if (!id) {
        return null;
      }
      return {
        id,
        parent_id: startBlock.parent_id,
        type: typeof block.type === "string" ? block.type : null,
        text: extractBlockText(block) ?? "",
        has_children: block.has_children === true,
        last_edited_time:
          typeof block.last_edited_time === "string" ? block.last_edited_time : null,
        sibling_index: siblingIndex,
        order_index: siblingIndex,
      } satisfies FlatBlock;
    })
    .filter((item): item is FlatBlock => item !== null);

  const currentFingerprint = siblingsFingerprint(currentSiblings);
  if (beforeFingerprint !== currentFingerprint) {
    throw new CliError(
      "conflict",
      "Target block range changed during planning. Retry to re-resolve the selection.",
    );
  }

  const insertResult =
    args.blocks.length > 0
      ? await insertBlocks(notion, {
          parentId: startBlock.parent_id,
          blocks: args.blocks,
          position: insertPosition,
          dryRun: false,
        })
      : {
          inserted_count: 0,
          inserted_ids: [],
        };

  for (const block of blocksToDelete) {
    await notion.deleteBlock({
      block_id: block.id,
    });
  }

  return {
    ...plan,
    inserted_count: insertResult.inserted_count ?? 0,
    inserted_ids: insertResult.inserted_ids ?? [],
    deleted_count: blocksToDelete.length,
  };
}

export async function deleteBlocks(
  notion: NotionClientAdapter,
  args: { blockIds: string[] },
): Promise<Record<string, unknown>> {
  const deletedIds: string[] = [];
  for (const blockId of args.blockIds) {
    await notion.deleteBlock({ block_id: blockId });
    deletedIds.push(blockId);
  }
  return {
    deleted_count: deletedIds.length,
    deleted_ids: deletedIds,
  };
}

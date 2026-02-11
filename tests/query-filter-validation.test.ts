import { describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config/types.js";
import { queryDataSourcePages } from "../src/notion/repository.js";
import { NotionClientAdapter } from "../src/notion/client.js";

function runtimeConfig(): AppConfig {
  return {
    notion_api_key_env: "NOTION_API_KEY",
    defaults: {
      limit: 25,
      view: "compact",
      max_blocks: 200,
      timeout_ms: 30000,
      schema_ttl_hours: 24,
      bulk_create_concurrency: 5,
      search_scan_limit: 500,
    },
    schema_cache: {},
  };
}

function dataSourceFixture(): Record<string, unknown> {
  return {
    object: "data_source",
    id: "ds-1",
    title: [{ plain_text: "Tasks" }],
    properties: {
      "Task name": {
        id: "title",
        type: "title",
        title: {},
      },
      Status: {
        id: "status-id",
        type: "status",
        status: {},
      },
    },
  };
}

function pageFixture(): Record<string, unknown> {
  return {
    object: "page",
    id: "page-1",
    url: "https://notion.so/page-1",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-02T00:00:00.000Z",
    archived: false,
    parent: { type: "data_source_id", data_source_id: "ds-1" },
    properties: {
      "Task name": {
        type: "title",
        title: [{ plain_text: "Improve retrieval" }],
      },
      Status: {
        type: "status",
        status: { name: "In Progress" },
      },
    },
  };
}

describe("data source query filter validation", () => {
  it("fails early with property name suggestions", async () => {
    const retrieveDataSource = vi.fn().mockResolvedValue(dataSourceFixture());
    const queryDataSource = vi.fn();
    const notion = {
      retrieveDataSource,
      queryDataSource,
    } as unknown as NotionClientAdapter;

    await expect(
      queryDataSourcePages(
        {
          notion,
          config: runtimeConfig(),
          saveConfig: async () => undefined,
        },
        {
          dataSourceId: "ds-1",
          limit: 10,
          filter: {
            property: "Task",
            title: { equals: "Improve retrieval" },
          },
          view: "compact",
        },
      ),
    ).rejects.toThrow('Unknown filter property "Task"');

    expect(queryDataSource).not.toHaveBeenCalled();
  });

  it("accepts filter properties by property id", async () => {
    const retrieveDataSource = vi.fn().mockResolvedValue(dataSourceFixture());
    const queryDataSource = vi.fn().mockResolvedValue({
      results: [pageFixture()],
      has_more: false,
      next_cursor: null,
    });
    const notion = {
      retrieveDataSource,
      queryDataSource,
    } as unknown as NotionClientAdapter;

    const result = await queryDataSourcePages(
      {
        notion,
        config: runtimeConfig(),
        saveConfig: async () => undefined,
      },
      {
        dataSourceId: "ds-1",
        limit: 10,
        filter: {
          property: "title",
          title: { equals: "Improve retrieval" },
        },
        view: "compact",
      },
    );

    expect(result.records.length).toBe(1);
    expect(queryDataSource).toHaveBeenCalledTimes(1);
  });
});

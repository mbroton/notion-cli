import { describe, expect, it, vi } from "vitest";
import { getBlocks } from "../src/notion/repository.js";
import { NotionClientAdapter } from "../src/notion/client.js";

function paragraph(id: string): Record<string, unknown> {
  return {
    object: "block",
    id,
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [],
    },
  };
}

describe("getBlocks truncation metadata", () => {
  it("marks truncated when maxBlocks is reached and upstream has more pages", async () => {
    const notion = {
      listBlockChildren: vi
        .fn()
        .mockResolvedValueOnce({
          results: [paragraph("b1"), paragraph("b2")],
          has_more: true,
          next_cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          results: [paragraph("b3")],
          has_more: false,
          next_cursor: null,
        }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 2, 1, "compact");

    expect(result.returned_blocks).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("keeps truncated false when maxBlocks is reached exactly with no more results", async () => {
    const notion = {
      listBlockChildren: vi.fn().mockResolvedValueOnce({
        results: [paragraph("b1"), paragraph("b2")],
        has_more: false,
        next_cursor: null,
      }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 2, 1, "compact");

    expect(result.returned_blocks).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("returns markdown content when markdown format is requested", async () => {
    const notion = {
      listBlockChildren: vi
        .fn()
        .mockResolvedValueOnce({
          results: [
            {
              object: "block",
              id: "h1",
              type: "heading_1",
              has_children: false,
              heading_1: {
                rich_text: [{ plain_text: "Heading" }],
              },
            },
            {
              object: "block",
              id: "p1",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [{ plain_text: "Body text" }],
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 10, 1, "markdown");

    expect(result.format).toBe("markdown");
    expect(result.content_markdown).toContain("# Heading");
    expect(result.content_markdown).toContain("Body text");
    expect(result.returned_blocks).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("renders bold and italic annotations as markdown", async () => {
    const notion = {
      listBlockChildren: vi.fn().mockResolvedValueOnce({
        results: [
          {
            object: "block",
            id: "p1",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [
                { plain_text: "hello ", annotations: {} },
                { plain_text: "bold", annotations: { bold: true } },
                { plain_text: " and ", annotations: {} },
                { plain_text: "italic", annotations: { italic: true } },
              ],
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 10, 1, "markdown");
    expect(result.content_markdown).toContain("**bold**");
    expect(result.content_markdown).toContain("*italic*");
  });

  it("renders inline code and strikethrough annotations as markdown", async () => {
    const notion = {
      listBlockChildren: vi.fn().mockResolvedValueOnce({
        results: [
          {
            object: "block",
            id: "p1",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [
                { plain_text: "run ", annotations: {} },
                { plain_text: "npm install", annotations: { code: true } },
                { plain_text: " and ", annotations: {} },
                { plain_text: "removed", annotations: { strikethrough: true } },
              ],
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 10, 1, "markdown");
    expect(result.content_markdown).toContain("`npm install`");
    expect(result.content_markdown).toContain("~~removed~~");
  });

  it("renders links in rich text as markdown", async () => {
    const notion = {
      listBlockChildren: vi.fn().mockResolvedValueOnce({
        results: [
          {
            object: "block",
            id: "p1",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [
                { plain_text: "visit ", annotations: {} },
                {
                  plain_text: "Google",
                  annotations: {},
                  href: "https://google.com",
                  text: { link: { url: "https://google.com" } },
                },
              ],
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 10, 1, "markdown");
    expect(result.content_markdown).toContain("[Google](https://google.com)");
  });

  it("renders image blocks as markdown", async () => {
    const notion = {
      listBlockChildren: vi.fn().mockResolvedValueOnce({
        results: [
          {
            object: "block",
            id: "img1",
            type: "image",
            has_children: false,
            image: {
              type: "external",
              external: { url: "https://example.com/img.png" },
              caption: [{ plain_text: "my image", annotations: {} }],
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 10, 1, "markdown");
    expect(result.content_markdown).toContain("![my image](https://example.com/img.png)");
  });

  it("renders table blocks as markdown", async () => {
    const notion = {
      listBlockChildren: vi.fn().mockResolvedValueOnce({
        results: [
          {
            object: "block",
            id: "tbl1",
            type: "table",
            has_children: true,
            table: {
              table_width: 2,
              has_column_header: true,
            },
            children: [
              {
                object: "block",
                id: "row1",
                type: "table_row",
                has_children: false,
                table_row: {
                  cells: [
                    [{ plain_text: "Name", annotations: {} }],
                    [{ plain_text: "Age", annotations: {} }],
                  ],
                },
              },
              {
                object: "block",
                id: "row2",
                type: "table_row",
                has_children: false,
                table_row: {
                  cells: [
                    [{ plain_text: "Alice", annotations: {} }],
                    [{ plain_text: "30", annotations: {} }],
                  ],
                },
              },
            ],
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    } as unknown as NotionClientAdapter;

    const result = await getBlocks(notion, "page-1", 10, 1, "markdown");
    expect(result.content_markdown).toContain("| Name | Age |");
    expect(result.content_markdown).toContain("| --- | --- |");
    expect(result.content_markdown).toContain("| Alice | 30 |");
  });
});

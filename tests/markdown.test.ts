import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../src/notion/markdown.js";

function getRichText(block: Record<string, unknown>): Array<Record<string, unknown>> {
  const type = block.type as string;
  const inner = block[type] as Record<string, unknown>;
  return inner.rich_text as Array<Record<string, unknown>>;
}

function getTextContent(rt: Record<string, unknown>): string {
  return (rt.text as { content: string }).content;
}

describe("markdownToBlocks", () => {
  it("converts key markdown constructs into Notion blocks", () => {
    const markdown = [
      "# Title",
      "",
      "A paragraph.",
      "- bullet item",
      "1. numbered item",
      "- [x] done item",
      "---",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const blocks = markdownToBlocks(markdown);
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1",
      "paragraph",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "divider",
      "code",
    ]);
  });

  it("collapses contiguous quote lines into a single quote block", () => {
    const markdown = ["> line one", "> line two"].join("\n");
    const blocks = markdownToBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("quote");
  });

  describe("inline formatting", () => {
    it("parses **bold** text", () => {
      const blocks = markdownToBlocks("hello **bold** world");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(3);
      expect(getTextContent(rt[0])).toBe("hello ");
      expect(rt[0].annotations).toBeUndefined();
      expect(getTextContent(rt[1])).toBe("bold");
      expect(rt[1].annotations).toEqual({ bold: true });
      expect(getTextContent(rt[2])).toBe(" world");
    });

    it("parses *italic* text", () => {
      const blocks = markdownToBlocks("hello *italic* world");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(3);
      expect(getTextContent(rt[1])).toBe("italic");
      expect(rt[1].annotations).toEqual({ italic: true });
    });

    it("parses ***bold+italic*** text", () => {
      const blocks = markdownToBlocks("***both***");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(1);
      expect(getTextContent(rt[0])).toBe("both");
      expect(rt[0].annotations).toEqual({ bold: true, italic: true });
    });

    it("parses ~~strikethrough~~ text", () => {
      const blocks = markdownToBlocks("~~removed~~");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(1);
      expect(getTextContent(rt[0])).toBe("removed");
      expect(rt[0].annotations).toEqual({ strikethrough: true });
    });

    it("parses `inline code`", () => {
      const blocks = markdownToBlocks("run `npm install` now");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(3);
      expect(getTextContent(rt[1])).toBe("npm install");
      expect(rt[1].annotations).toEqual({ code: true });
    });

    it("parses [link](url)", () => {
      const blocks = markdownToBlocks("visit [Google](https://google.com) today");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(3);
      expect(getTextContent(rt[0])).toBe("visit ");
      expect(getTextContent(rt[1])).toBe("Google");
      expect((rt[1].text as { link?: { url: string } }).link).toEqual({
        url: "https://google.com",
      });
      expect(getTextContent(rt[2])).toBe(" today");
    });

    it("handles nested bold inside italic: *italic **bold** italic*", () => {
      const blocks = markdownToBlocks("*italic **bold** italic*");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(3);
      expect(getTextContent(rt[0])).toBe("italic ");
      expect(rt[0].annotations).toEqual({ italic: true });
      expect(getTextContent(rt[1])).toBe("bold");
      expect(rt[1].annotations).toEqual({ bold: true, italic: true });
      expect(getTextContent(rt[2])).toBe(" italic");
      expect(rt[2].annotations).toEqual({ italic: true });
    });

    it("handles multiple formatting in one line", () => {
      const blocks = markdownToBlocks("**bold** and *italic* and `code`");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(5);
      expect(getTextContent(rt[0])).toBe("bold");
      expect(rt[0].annotations).toEqual({ bold: true });
      expect(getTextContent(rt[1])).toBe(" and ");
      expect(getTextContent(rt[2])).toBe("italic");
      expect(rt[2].annotations).toEqual({ italic: true });
      expect(getTextContent(rt[3])).toBe(" and ");
      expect(getTextContent(rt[4])).toBe("code");
      expect(rt[4].annotations).toEqual({ code: true });
    });

    it("does not parse inline formatting inside code blocks", () => {
      const blocks = markdownToBlocks("```\n**not bold** *not italic*\n```");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(1);
      expect(getTextContent(rt[0])).toBe("**not bold** *not italic*");
      expect(rt[0].annotations).toBeUndefined();
    });

    it("inline formatting works in list items", () => {
      const blocks = markdownToBlocks("- item with **bold**");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(2);
      expect(getTextContent(rt[0])).toBe("item with ");
      expect(getTextContent(rt[1])).toBe("bold");
      expect(rt[1].annotations).toEqual({ bold: true });
    });

    it("inline formatting works in headings", () => {
      const blocks = markdownToBlocks("## heading with *emphasis*");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(2);
      expect(getTextContent(rt[0])).toBe("heading with ");
      expect(getTextContent(rt[1])).toBe("emphasis");
      expect(rt[1].annotations).toEqual({ italic: true });
    });

    it("treats unmatched delimiters as literal text", () => {
      const blocks = markdownToBlocks("a single * asterisk");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(1);
      expect(getTextContent(rt[0])).toBe("a single * asterisk");
    });

    it("handles bold link: [**text**](url)", () => {
      const blocks = markdownToBlocks("[**click here**](https://example.com)");
      const rt = getRichText(blocks[0]);

      expect(rt).toHaveLength(1);
      expect(getTextContent(rt[0])).toBe("click here");
      expect(rt[0].annotations).toEqual({ bold: true });
      expect((rt[0].text as { link?: { url: string } }).link).toEqual({
        url: "https://example.com",
      });
    });
  });

  describe("images", () => {
    it("parses ![alt](url) as an image block", () => {
      const blocks = markdownToBlocks("![my image](https://example.com/img.png)");

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("image");
      const img = blocks[0].image as Record<string, unknown>;
      expect(img.type).toBe("external");
      expect((img.external as { url: string }).url).toBe("https://example.com/img.png");
    });

    it("uses alt text as caption", () => {
      const blocks = markdownToBlocks("![a caption](https://example.com/img.png)");
      const img = blocks[0].image as Record<string, unknown>;
      const caption = img.caption as Array<Record<string, unknown>>;
      expect(caption).toHaveLength(1);
      expect(getTextContent(caption[0])).toBe("a caption");
    });

    it("does not treat image syntax mid-paragraph as image block", () => {
      const blocks = markdownToBlocks("text before ![img](https://example.com/img.png)");
      expect(blocks[0].type).toBe("paragraph");
    });
  });

  describe("tables", () => {
    it("parses a simple table", () => {
      const markdown = [
        "| Name | Age |",
        "| --- | --- |",
        "| Alice | 30 |",
        "| Bob | 25 |",
      ].join("\n");
      const blocks = markdownToBlocks(markdown);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("table");
      const table = blocks[0].table as Record<string, unknown>;
      expect(table.table_width).toBe(2);
      expect(table.has_column_header).toBe(true);
      const children = table.children as Array<Record<string, unknown>>;
      expect(children).toHaveLength(3);
    });

    it("parses table without header separator", () => {
      const markdown = [
        "| A | B |",
        "| C | D |",
      ].join("\n");
      const blocks = markdownToBlocks(markdown);

      const table = blocks[0].table as Record<string, unknown>;
      expect(table.has_column_header).toBe(false);
      const children = table.children as Array<Record<string, unknown>>;
      expect(children).toHaveLength(2);
    });

    it("preserves inline formatting in table cells", () => {
      const markdown = [
        "| **bold** | *italic* |",
        "| --- | --- |",
        "| plain | `code` |",
      ].join("\n");
      const blocks = markdownToBlocks(markdown);

      const table = blocks[0].table as Record<string, unknown>;
      const children = table.children as Array<Record<string, unknown>>;
      const headerRow = children[0].table_row as Record<string, unknown>;
      const cells = headerRow.cells as Array<Array<Record<string, unknown>>>;
      expect(getTextContent(cells[0][0])).toBe("bold");
      expect(cells[0][0].annotations).toEqual({ bold: true });
    });

    it("table followed by paragraph produces two blocks", () => {
      const markdown = [
        "| A | B |",
        "| --- | --- |",
        "| C | D |",
        "",
        "Some text",
      ].join("\n");
      const blocks = markdownToBlocks(markdown);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe("table");
      expect(blocks[1].type).toBe("paragraph");
    });
  });
});

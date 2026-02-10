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
});

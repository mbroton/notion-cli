const MAX_RICH_TEXT_CHARS = 1800;

function chunkText(content: string): string[] {
  if (content.length <= MAX_RICH_TEXT_CHARS) {
    return [content];
  }

  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += MAX_RICH_TEXT_CHARS) {
    chunks.push(content.slice(index, index + MAX_RICH_TEXT_CHARS));
  }
  return chunks;
}

interface InlineAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
}

interface InlineSegment {
  content: string;
  annotations: InlineAnnotations;
  link?: string;
}

const DEFAULT_ANNOTATIONS: InlineAnnotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  code: false,
};

function findClosingStar(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "*" && text[i + 1] !== "*" && text[i - 1] !== "*") {
      return i;
    }
  }
  return -1;
}

function parseInlineSegments(
  text: string,
  inherited: InlineAnnotations,
  linkUrl?: string,
): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let i = 0;
  let plain = "";

  const flush = (): void => {
    if (plain) {
      segments.push({ content: plain, annotations: { ...inherited }, link: linkUrl });
      plain = "";
    }
  };

  while (i < text.length) {
    // Inline code (no nesting inside)
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        flush();
        segments.push({
          content: text.slice(i + 1, close),
          annotations: { ...inherited, code: true },
          link: linkUrl,
        });
        i = close + 1;
        continue;
      }
    }

    // Link [text](url)
    if (text[i] === "[") {
      const bracketClose = text.indexOf("]", i + 1);
      if (bracketClose !== -1 && text[bracketClose + 1] === "(") {
        const parenClose = text.indexOf(")", bracketClose + 2);
        if (parenClose !== -1) {
          flush();
          const linkText = text.slice(i + 1, bracketClose);
          const url = text.slice(bracketClose + 2, parenClose);
          segments.push(...parseInlineSegments(linkText, inherited, url));
          i = parenClose + 1;
          continue;
        }
      }
    }

    // *** bold+italic
    if (text[i] === "*" && text[i + 1] === "*" && text[i + 2] === "*") {
      const close = text.indexOf("***", i + 3);
      if (close !== -1) {
        flush();
        segments.push(
          ...parseInlineSegments(
            text.slice(i + 3, close),
            { ...inherited, bold: true, italic: true },
            linkUrl,
          ),
        );
        i = close + 3;
        continue;
      }
    }

    // ** bold
    if (text[i] === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close !== -1) {
        flush();
        segments.push(
          ...parseInlineSegments(
            text.slice(i + 2, close),
            { ...inherited, bold: true },
            linkUrl,
          ),
        );
        i = close + 2;
        continue;
      }
    }

    // * italic
    if (text[i] === "*") {
      const close = findClosingStar(text, i + 1);
      if (close !== -1) {
        flush();
        segments.push(
          ...parseInlineSegments(
            text.slice(i + 1, close),
            { ...inherited, italic: true },
            linkUrl,
          ),
        );
        i = close + 1;
        continue;
      }
    }

    // ~~ strikethrough
    if (text[i] === "~" && text[i + 1] === "~") {
      const close = text.indexOf("~~", i + 2);
      if (close !== -1) {
        flush();
        segments.push(
          ...parseInlineSegments(
            text.slice(i + 2, close),
            { ...inherited, strikethrough: true },
            linkUrl,
          ),
        );
        i = close + 2;
        continue;
      }
    }

    plain += text[i];
    i++;
  }

  flush();
  return segments;
}

function segmentToRichText(segment: InlineSegment): Array<Record<string, unknown>> {
  return chunkText(segment.content).map((chunk) => {
    const textObj: Record<string, unknown> = { content: chunk };
    if (segment.link) {
      textObj.link = { url: segment.link };
    }

    const obj: Record<string, unknown> = { type: "text", text: textObj };

    const { bold, italic, strikethrough, code } = segment.annotations;
    if (bold || italic || strikethrough || code) {
      const annotations: Record<string, boolean> = {};
      if (bold) annotations.bold = true;
      if (italic) annotations.italic = true;
      if (strikethrough) annotations.strikethrough = true;
      if (code) annotations.code = true;
      obj.annotations = annotations;
    }

    return obj;
  });
}

function toRichText(content: string): Array<Record<string, unknown>> {
  const normalized = content.length > 0 ? content : " ";
  const segments = parseInlineSegments(normalized, DEFAULT_ANNOTATIONS);
  if (segments.length === 0) {
    return [{ type: "text", text: { content: " " } }];
  }
  return segments.flatMap(segmentToRichText);
}

function toPlainRichText(content: string): Array<Record<string, unknown>> {
  const normalized = content.length > 0 ? content : " ";
  return chunkText(normalized).map((chunk) => ({
    type: "text",
    text: { content: chunk },
  }));
}

function paragraphBlock(text: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: toRichText(text),
    },
  };
}

function headingBlock(level: 1 | 2 | 3, text: string): Record<string, unknown> {
  const type = `heading_${level}`;
  return {
    object: "block",
    type,
    [type]: {
      rich_text: toRichText(text),
    },
  };
}

function bulletedItemBlock(text: string): Record<string, unknown> {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: toRichText(text),
    },
  };
}

function numberedItemBlock(text: string): Record<string, unknown> {
  return {
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: {
      rich_text: toRichText(text),
    },
  };
}

function todoBlock(text: string, checked: boolean): Record<string, unknown> {
  return {
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: toRichText(text),
      checked,
    },
  };
}

function quoteBlock(text: string): Record<string, unknown> {
  return {
    object: "block",
    type: "quote",
    quote: {
      rich_text: toRichText(text),
    },
  };
}

function dividerBlock(): Record<string, unknown> {
  return {
    object: "block",
    type: "divider",
    divider: {},
  };
}

function normalizeCodeLanguage(raw: string): string {
  const language = raw.trim().toLowerCase();
  if (!language) {
    return "plain text";
  }

  switch (language) {
    case "ts":
    case "typescript":
      return "typescript";
    case "js":
    case "javascript":
      return "javascript";
    case "py":
    case "python":
      return "python";
    case "sh":
    case "bash":
    case "shell":
      return "shell";
    case "json":
      return "json";
    case "sql":
      return "sql";
    case "yaml":
    case "yml":
      return "yaml";
    case "md":
    case "markdown":
      return "markdown";
    case "html":
      return "html";
    case "css":
      return "css";
    case "go":
      return "go";
    case "java":
      return "java";
    case "ruby":
      return "ruby";
    case "rust":
      return "rust";
    default:
      return "plain text";
  }
}

function codeBlock(text: string, language: string): Record<string, unknown> {
  return {
    object: "block",
    type: "code",
    code: {
      rich_text: toPlainRichText(text),
      language,
    },
  };
}

function imageBlock(url: string, caption: string): Record<string, unknown> {
  return {
    object: "block",
    type: "image",
    image: {
      type: "external",
      external: { url },
      caption: toRichText(caption),
    },
  };
}

function parseMarkdownTable(
  lines: string[],
  startIndex: number,
): { block: Record<string, unknown>; linesConsumed: number } {
  const tableLines: string[] = [];
  let i = startIndex;
  while (i < lines.length && lines[i].trim().includes("|")) {
    tableLines.push(lines[i].trim());
    i++;
  }
  const linesConsumed = tableLines.length;

  const parseCells = (line: string): string[] => {
    let stripped = line;
    if (stripped.startsWith("|")) stripped = stripped.slice(1);
    if (stripped.endsWith("|")) stripped = stripped.slice(0, -1);
    return stripped.split("|").map((c) => c.trim());
  };

  const isSeparator = (line: string): boolean => {
    const cells = parseCells(line);
    return cells.every((c) => /^[-:]+$/.test(c));
  };

  const hasColumnHeader = tableLines.length >= 2 && isSeparator(tableLines[1]);

  const dataLines = tableLines.filter((_, idx) => !(hasColumnHeader && idx === 1));
  const tableWidth = dataLines.length > 0 ? parseCells(dataLines[0]).length : 0;

  const children = dataLines.map((line) => {
    const cells = parseCells(line);
    while (cells.length < tableWidth) cells.push("");
    return {
      object: "block",
      type: "table_row",
      table_row: {
        cells: cells.slice(0, tableWidth).map((c) => toRichText(c)),
      },
    };
  });

  return {
    block: {
      object: "block",
      type: "table",
      table: {
        table_width: tableWidth,
        has_column_header: hasColumnHeader,
        has_row_header: false,
        children,
      },
    },
    linesConsumed,
  };
}

function isDivider(trimmed: string): boolean {
  return trimmed === "---" || trimmed === "***" || trimmed === "___";
}

export function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: Array<Record<string, unknown>> = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }
    const text = paragraphLines.join("\n").trim();
    paragraphLines = [];
    if (text.length > 0) {
      blocks.push(paragraphBlock(text));
    }
  };

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const language = normalizeCodeLanguage(trimmed.slice(3));
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && lines[index].trim().startsWith("```")) {
        index += 1;
      }
      blocks.push(codeBlock(codeLines.join("\n"), language));
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (isDivider(trimmed)) {
      flushParagraph();
      blocks.push(dividerBlock());
      index += 1;
      continue;
    }

    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageMatch) {
      flushParagraph();
      blocks.push(imageBlock(imageMatch[2], imageMatch[1]));
      index += 1;
      continue;
    }

    if (trimmed.startsWith("|")) {
      flushParagraph();
      const result = parseMarkdownTable(lines, index);
      blocks.push(result.block);
      index += result.linesConsumed;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length as 1 | 2 | 3;
      blocks.push(headingBlock(level, headingMatch[2]));
      index += 1;
      continue;
    }

    const todoMatch = trimmed.match(/^[-*]\s+\[( |x|X)\]\s+(.+)$/);
    if (todoMatch) {
      flushParagraph();
      blocks.push(todoBlock(todoMatch[2], todoMatch[1].toLowerCase() === "x"));
      index += 1;
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      const quoteLines: string[] = [quoteMatch[1]];
      index += 1;
      while (index < lines.length) {
        const next = lines[index].trim();
        const nextMatch = next.match(/^>\s?(.*)$/);
        if (!nextMatch) {
          break;
        }
        quoteLines.push(nextMatch[1]);
        index += 1;
      }
      blocks.push(quoteBlock(quoteLines.join("\n")));
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push(bulletedItemBlock(bulletMatch[1]));
      index += 1;
      continue;
    }

    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push(numberedItemBlock(numberedMatch[1]));
      index += 1;
      continue;
    }

    paragraphLines.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runCli(args: string[]): string {
  const cliPath = resolve(process.cwd(), "src/cli.ts");
  return execFileSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("help discoverability", () => {
  it("surfaces advanced capabilities at the root help level", () => {
    const output = runCli(["--help"]);
    expect(output).toContain("Power Features:");
    expect(output).toContain("pages create-bulk");
    expect(output).toContain("pages unarchive");
    expect(output).toContain("pages get --include-content");
    expect(output).toContain("blocks append --markdown|--markdown-file");
    expect(output).toContain("--scope");
    expect(output).toContain("--created-after");
    expect(output).toContain("--edited-after");
    expect(output).toContain("--created-by");
    expect(output).toContain("--scan-limit");
  });

  it("surfaces page operation highlights in pages help", () => {
    const output = runCli(["pages", "--help"]);
    expect(output).toContain("create-bulk [options]");
    expect(output).toContain("unarchive [options]");
    expect(output).toContain("Highlights:");
    expect(output).toContain("--return-view <compact|full>");
    expect(output).toContain("--include-content");
    expect(output).toContain("--content-format compact|full");
  });

  it("surfaces advanced filtering guidance in search help", () => {
    const output = runCli(["search", "--help"]);
    expect(output).toContain("Advanced Filtering At a Glance:");
    expect(output).toContain("--scope <page_or_data_source_id>");
    expect(output).toContain("--created-after <iso>");
    expect(output).toContain("--edited-after <iso>");
    expect(output).toContain("--created-by <user_id>");
    expect(output).toContain("--object <page|data_source>");
    expect(output).toContain("--scan-limit <n>");
  });

  it("surfaces markdown input modes in blocks append help", () => {
    const output = runCli(["blocks", "append", "--help"]);
    expect(output).toContain("Input Modes:");
    expect(output).toContain("Provide exactly one of --blocks-json, --markdown, or --markdown-file.");
  });

  it("defaults blocks get to markdown format", () => {
    const output = runCli(["blocks", "get", "--help"]);
    expect(output).toContain("--view <markdown|compact|full>");
    expect(output).toContain("(default: \"markdown\")");
  });

  it("rejects deprecated blocks get --format with migration guidance", () => {
    const cliPath = resolve(process.cwd(), "src/cli.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "blocks", "get", "--id", "page-1", "--format", "full"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("\"code\":\"invalid_input\"");
    expect(result.stderr).toContain("Use --view <markdown|compact|full>");
  });
});

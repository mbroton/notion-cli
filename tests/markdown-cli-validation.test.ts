import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("markdown CLI validation", () => {
  it("fails fast when --markdown contains literal newline escapes", () => {
    const cliPath = resolve(process.cwd(), "src/cli.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "blocks", "append", "--id", "page-1", "--markdown", "Line one\\nLine two"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("\"code\":\"invalid_input\"");
    expect(result.stderr).toContain("literal \\\\n escapes");
  });
});

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("idempotency cross-process safety", () => {
  it("handles concurrent identical mutations without finalize failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ntion-idem-concurrency-"));
    tempDirs.push(dir);

    const script = `
      import { executeMutationWithIdempotency } from "./src/commands/mutation.ts";
      process.env.XDG_CONFIG_HOME = process.argv[1];
      const index = process.argv[2];
      await executeMutationWithIdempotency({
        commandName: "blocks.append",
        requestId: \`req-\${index}\`,
        requestShape: {
          id: "page-1",
          blocks: [{ type: "paragraph", paragraph: { rich_text: [] } }],
        },
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true };
        },
      });
    `;

    const workers = 20;
    await expect(
      Promise.all(
        Array.from({ length: workers }, (_, index) =>
          execFileAsync(process.execPath, ["--import", "tsx", "-e", script, dir, String(index)], {
            cwd: process.cwd(),
          }),
        ),
      ),
    ).resolves.toHaveLength(workers);
  }, 30000);
});

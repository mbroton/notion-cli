import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/audit/log.js", () => ({
  appendAuditLog: vi.fn(),
}));

import { appendAuditLog } from "../src/audit/log.js";
import { executeMutationWithIdempotency } from "../src/commands/mutation.js";

const mockedAppendAuditLog = vi.mocked(appendAuditLog);
const tempDirs: string[] = [];

afterEach(() => {
  mockedAppendAuditLog.mockReset();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("executeMutationWithIdempotency", () => {
  it("does not fail successful mutations when audit logging fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notcli-test-"));
    tempDirs.push(dir);

    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;

    mockedAppendAuditLog.mockRejectedValue(new Error("audit unavailable"));

    try {
      const result = await executeMutationWithIdempotency({
        commandName: "pages.update",
        requestId: "req-1",
        requestShape: { page_id: "p1", patch: { Name: "Done" } },
        run: async () => ({ ok: true }),
      });

      expect(result).toEqual({ ok: true });
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });

  it("preserves original mutation errors when audit logging also fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notcli-test-"));
    tempDirs.push(dir);

    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;

    mockedAppendAuditLog.mockRejectedValue(new Error("audit unavailable"));

    try {
      await expect(
        executeMutationWithIdempotency({
          commandName: "pages.update",
          requestId: "req-2",
          requestShape: { page_id: "p1", patch: { Name: "Done" } },
          run: async () => {
            throw new Error("upstream failure");
          },
        }),
      ).rejects.toThrow("upstream failure");
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });
});

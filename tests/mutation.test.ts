import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/audit/log.js", () => ({
  appendAuditLog: vi.fn(),
}));

import { appendAuditLog } from "../src/audit/log.js";
import { executeMutationWithIdempotency } from "../src/commands/mutation.js";
import { IdempotencyStore } from "../src/idempotency/store.js";

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
    const dir = mkdtempSync(join(tmpdir(), "ntion-test-"));
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
    const dir = mkdtempSync(join(tmpdir(), "ntion-test-"));
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

  it("returns success when persistence finalization fails after successful mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ntion-test-"));
    tempDirs.push(dir);

    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;

    const completeSpy = vi
      .spyOn(IdempotencyStore.prototype, "complete")
      .mockImplementation(() => {
        throw new Error("persistence failure");
      });

    try {
      const result = await executeMutationWithIdempotency({
        commandName: "blocks.append",
        requestId: "req-3",
        requestShape: { id: "page-1", blocks: [{ type: "paragraph" }] },
        run: async () => ({ ok: true }),
      });

      expect(result).toEqual({ ok: true });
      expect(mockedAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          idempotency_persist_degraded: true,
        }),
      );
    } finally {
      completeSpy.mockRestore();
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });

  it("returns recovered success for ambiguous upstream failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ntion-test-"));
    tempDirs.push(dir);

    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;

    try {
      const result = await executeMutationWithIdempotency({
        commandName: "pages.archive",
        requestId: "req-4",
        requestShape: { id: "page-1" },
        run: async () => {
          throw { code: "internal_error", message: "upstream ambiguity" };
        },
        recover: async () => ({ ok: true, recovered: true }),
      });

      expect(result).toEqual({ ok: true, recovered: true });
      expect(mockedAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          recovery_attempted: true,
          recovery_succeeded: true,
        }),
      );
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });

  it("returns uncertain retryable error when ambiguous failures cannot be confirmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ntion-test-"));
    tempDirs.push(dir);

    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;

    try {
      await expect(
        executeMutationWithIdempotency({
          commandName: "blocks.delete",
          requestId: "req-5",
          requestShape: { block_ids: ["b1"] },
          run: async () => {
            throw { status: 500, message: "Internal Server Error" };
          },
          recover: async () => null,
        }),
      ).rejects.toMatchObject({
        code: "retryable_upstream",
        message: "Mutation outcome could not be confirmed. Re-read before retrying.",
        retryable: true,
      });
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
    }
  });
});

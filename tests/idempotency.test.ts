import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInternalIdempotencyKey, IdempotencyStore } from "../src/idempotency/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("IdempotencyStore", () => {
  it("reserves once and replays after completion", () => {
    const dir = mkdtempSync(join(tmpdir(), "ntion-test-"));
    tempDirs.push(dir);

    const store = new IdempotencyStore(join(dir, "idem.json"));
    const first = store.reserve("k1", "pages.update", "h1");
    expect(first.kind).toBe("execute");

    const second = store.reserve("k1", "pages.update", "h1");
    expect(second.kind).toBe("pending");

    store.complete("k1", "pages.update", "h1", { ok: true, id: "t1" });

    const lookup = store.lookup("k1", "pages.update", "h1");
    expect(lookup.kind).toBe("replay");
    if (lookup.kind === "replay") {
      expect(lookup.response).toEqual({ ok: true, id: "t1" });
    }

    store.close();
  });

  it("prunes entries older than 3 minutes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ntion-test-"));
    tempDirs.push(dir);
    const filePath = join(dir, "idem.json");

    const store = new IdempotencyStore(filePath);
    store.reserve("k1", "pages.update", "h1");
    store.complete("k1", "pages.update", "h1", { ok: true });

    // Backdate the entry beyond 3 minutes
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    const key = Object.keys(data)[0];
    data[key].createdAt = Date.now() - 200_000;
    writeFileSync(filePath, JSON.stringify(data), "utf-8");

    // Next access triggers pruning — the old entry should be gone
    const lookup = store.lookup("k1", "pages.update", "h1");
    expect(lookup.kind).toBe("miss");
  });

  it("builds deterministic internal idempotency keys", () => {
    const keyA = buildInternalIdempotencyKey("pages.update", {
      a: 1,
      b: { c: 2, d: 3 },
    });

    const keyB = buildInternalIdempotencyKey("pages.update", {
      b: { d: 3, c: 2 },
      a: 1,
    });

    expect(keyA).toBe(keyB);
  });
});

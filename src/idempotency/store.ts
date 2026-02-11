import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { ensureConfigDir, getIdempotencyLockPath, getIdempotencyStorePath } from "../config/paths.js";
import { CliError } from "../errors/cli-error.js";
import { hashObject } from "../utils/json.js";

const PRUNE_TTL_MS = 180_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 35_000;
const LOCK_POLL_INTERVAL_MS = 30;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

interface StoreEntry {
  inputHash: string;
  responseJson: string;
  createdAt: number;
}

type StoreData = Record<string, StoreEntry>;

export type IdempotencyLookup =
  | { kind: "miss" }
  | { kind: "pending" }
  | { kind: "replay"; response: unknown }
  | { kind: "conflict"; storedHash: string };

export type IdempotencyReservation =
  | { kind: "execute" }
  | { kind: "pending" }
  | { kind: "replay"; response: unknown }
  | { kind: "conflict"; storedHash: string };

const PENDING_RESPONSE_JSON = JSON.stringify({ __notion_lite_pending: true });

function compositeKey(idempotencyKey: string, commandName: string): string {
  return `${idempotencyKey}\0${commandName}`;
}

export class IdempotencyStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath = getIdempotencyStorePath()) {
    ensureConfigDir();
    this.filePath = filePath;
    this.lockPath =
      filePath === getIdempotencyStorePath() ? getIdempotencyLockPath() : `${filePath}.lock`;
  }

  close(): void {
    // no-op — nothing to tear down for a JSON file store
  }

  lookup(idempotencyKey: string, commandName: string, inputHash: string): IdempotencyLookup {
    return this.withLock(() => {
      const data = this.loadDataUnlocked();
      const entry = data[compositeKey(idempotencyKey, commandName)];

      if (!entry) {
        return { kind: "miss" };
      }

      if (entry.inputHash !== inputHash) {
        return { kind: "conflict", storedHash: entry.inputHash };
      }

      if (entry.responseJson === PENDING_RESPONSE_JSON) {
        return { kind: "pending" };
      }

      try {
        return { kind: "replay", response: JSON.parse(entry.responseJson) };
      } catch {
        throw new CliError("internal_error", "Stored idempotency response is corrupt.");
      }
    });
  }

  reserve(idempotencyKey: string, commandName: string, inputHash: string): IdempotencyReservation {
    return this.withLock(() => {
      const data = this.loadDataUnlocked();
      const key = compositeKey(idempotencyKey, commandName);

      if (!data[key]) {
        data[key] = {
          inputHash,
          responseJson: PENDING_RESPONSE_JSON,
          createdAt: Date.now(),
        };
        this.saveDataUnlocked(data);
        return { kind: "execute" };
      }

      const entry = data[key];

      if (entry.inputHash !== inputHash) {
        return { kind: "conflict", storedHash: entry.inputHash };
      }

      if (entry.responseJson === PENDING_RESPONSE_JSON) {
        return { kind: "pending" };
      }

      try {
        return { kind: "replay", response: JSON.parse(entry.responseJson) };
      } catch {
        throw new CliError("internal_error", "Stored idempotency response is corrupt.");
      }
    });
  }

  complete(idempotencyKey: string, commandName: string, inputHash: string, response: unknown): void {
    this.withLock(() => {
      const data = this.loadDataUnlocked();
      const key = compositeKey(idempotencyKey, commandName);
      const entry = data[key];

      if (!entry) {
        data[key] = {
          inputHash,
          responseJson: JSON.stringify(response),
          createdAt: Date.now(),
        };
        this.saveDataUnlocked(data);
        return;
      }

      if (entry.inputHash !== inputHash) {
        throw new CliError(
          "internal_error",
          "Failed to finalize idempotency record for mutation replay.",
        );
      }

      entry.responseJson = JSON.stringify(response);
      entry.createdAt = Date.now();
      this.saveDataUnlocked(data);
    });
  }

  release(idempotencyKey: string, commandName: string, inputHash: string): void {
    this.withLock(() => {
      const data = this.loadDataUnlocked();
      const key = compositeKey(idempotencyKey, commandName);
      const entry = data[key];

      if (entry && entry.inputHash === inputHash && entry.responseJson === PENDING_RESPONSE_JSON) {
        delete data[key];
        this.saveDataUnlocked(data);
      }
    });
  }

  private withLock<T>(fn: () => T): T {
    const lockFd = this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock(lockFd);
    }
  }

  private acquireLock(): number {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf-8");
        return fd;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EEXIST") {
          throw new CliError("internal_error", "Failed to acquire idempotency store lock.", {
            details: error,
          });
        }

        this.tryClearStaleLock();
        this.sleepMs(LOCK_POLL_INTERVAL_MS + Math.floor(Math.random() * 20));
      }
    }

    throw new CliError("retryable_upstream", "Idempotency store is busy. Retry shortly.", {
      retryable: true,
    });
  }

  private releaseLock(lockFd: number): void {
    try {
      closeSync(lockFd);
    } catch {
      // best effort
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      // best effort
    }
  }

  private tryClearStaleLock(): void {
    try {
      const lockStat = statSync(this.lockPath);
      const ageMs = Date.now() - lockStat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // best effort
    }
  }

  private sleepMs(ms: number): void {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
  }

  private loadDataUnlocked(): StoreData {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return {};
    }

    let data: StoreData;
    try {
      data = JSON.parse(raw) as StoreData;
    } catch {
      this.saveDataUnlocked({});
      return {};
    }

    const now = Date.now();
    let pruned = false;
    for (const key of Object.keys(data)) {
      if (now - data[key].createdAt > PRUNE_TTL_MS) {
        delete data[key];
        pruned = true;
      }
    }

    if (pruned) {
      this.saveDataUnlocked(data);
    }

    return data;
  }

  private saveDataUnlocked(data: StoreData): void {
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(tempPath, JSON.stringify(data), "utf-8");
    renameSync(tempPath, this.filePath);
  }
}

export function buildInternalIdempotencyKey(commandName: string, requestShape: unknown): string {
  const bucket = Math.floor(Date.now() / 120000);
  const digest = hashObject({ commandName, requestShape });
  return `${commandName}:${bucket}:${digest}`;
}

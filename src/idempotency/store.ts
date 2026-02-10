import { readFileSync, writeFileSync } from "node:fs";
import { ensureConfigDir, getIdempotencyStorePath } from "../config/paths.js";
import { CliError } from "../errors/cli-error.js";
import { hashObject } from "../utils/json.js";

const PRUNE_TTL_MS = 180_000;

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

  constructor(filePath = getIdempotencyStorePath()) {
    ensureConfigDir();
    this.filePath = filePath;
  }

  close(): void {
    // no-op — nothing to tear down for a JSON file store
  }

  lookup(idempotencyKey: string, commandName: string, inputHash: string): IdempotencyLookup {
    const data = this.loadData();
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
  }

  reserve(idempotencyKey: string, commandName: string, inputHash: string): IdempotencyReservation {
    const data = this.loadData();
    const key = compositeKey(idempotencyKey, commandName);

    if (!data[key]) {
      data[key] = {
        inputHash,
        responseJson: PENDING_RESPONSE_JSON,
        createdAt: Date.now(),
      };
      this.saveData(data);
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
  }

  complete(idempotencyKey: string, commandName: string, inputHash: string, response: unknown): void {
    const data = this.loadData();
    const key = compositeKey(idempotencyKey, commandName);
    const entry = data[key];

    if (!entry || entry.inputHash !== inputHash) {
      throw new CliError(
        "internal_error",
        "Failed to finalize idempotency record for mutation replay.",
      );
    }

    entry.responseJson = JSON.stringify(response);
    entry.createdAt = Date.now();
    this.saveData(data);
  }

  release(idempotencyKey: string, commandName: string, inputHash: string): void {
    const data = this.loadData();
    const key = compositeKey(idempotencyKey, commandName);
    const entry = data[key];

    if (entry && entry.inputHash === inputHash && entry.responseJson === PENDING_RESPONSE_JSON) {
      delete data[key];
      this.saveData(data);
    }
  }

  private loadData(): StoreData {
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
      this.saveData(data);
    }

    return data;
  }

  private saveData(data: StoreData): void {
    writeFileSync(this.filePath, JSON.stringify(data), "utf-8");
  }
}

export function buildInternalIdempotencyKey(commandName: string, requestShape: unknown): string {
  const bucket = Math.floor(Date.now() / 120000);
  const digest = hashObject({ commandName, requestShape });
  return `${commandName}:${bucket}:${digest}`;
}

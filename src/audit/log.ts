import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ensureConfigDir, getAuditLogPath } from "../config/paths.js";

export interface AuditEvent {
  command: string;
  entity?: string;
  request_id: string;
  idempotency_key?: string;
  target_ids?: string[];
  ok: boolean;
  timestamp: string;
  recovery_attempted?: boolean;
  recovery_succeeded?: boolean;
  idempotency_persist_degraded?: boolean;
  outcome_uncertain?: boolean;
}

function hashKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return createHash("sha256").update(value).digest("hex");
}

export async function appendAuditLog(event: AuditEvent): Promise<void> {
  ensureConfigDir();
  const payload = {
    ...event,
    idempotency_key_hash: hashKey(event.idempotency_key),
  };
  delete (payload as { idempotency_key?: string }).idempotency_key;

  await appendFile(getAuditLogPath(), `${JSON.stringify(payload)}\n`, "utf8");
}

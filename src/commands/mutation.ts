import { appendAuditLog } from "../audit/log.js";
import { CliError } from "../errors/cli-error.js";
import { buildInternalIdempotencyKey, IdempotencyStore } from "../idempotency/store.js";
import { hashObject } from "../utils/json.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeAppendAuditLog(event: Parameters<typeof appendAuditLog>[0]): Promise<void> {
  try {
    await appendAuditLog(event);
  } catch {
    // Audit logging must not alter mutation outcomes.
  }
}

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isAmbiguousMutationError(
  error: unknown,
  override?: (error: unknown) => boolean,
): boolean {
  if (override) {
    return override(error);
  }

  if (error instanceof CliError && error.code === "retryable_upstream") {
    return true;
  }

  const status = getStatus(error);
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return true;
  }

  return getCode(error) === "internal_error";
}

export async function executeMutationWithIdempotency<T>(args: {
  commandName: string;
  requestId: string;
  requestShape: unknown;
  entity?: string;
  targetIds?: string[];
  run: () => Promise<T>;
  recover?: () => Promise<T | null>;
  isAmbiguousError?: (error: unknown) => boolean;
}): Promise<T> {
  const store = new IdempotencyStore();
  const requestHash = hashObject(args.requestShape);
  const idempotencyKey = buildInternalIdempotencyKey(args.commandName, args.requestShape);
  let ownsReservation = false;
  let recoveryAttempted = false;
  let recoverySucceeded = false;
  let idempotencyPersistDegraded = false;
  let outcomeUncertain = false;

  try {
    let lookup = store.reserve(idempotencyKey, args.commandName, requestHash);

    while (lookup.kind === "pending") {
      const deadline = Date.now() + 15000;
      let resolved = false;

      while (Date.now() < deadline) {
        await sleep(50);
        const current = store.lookup(idempotencyKey, args.commandName, requestHash);
        if (current.kind === "pending") {
          continue;
        }
        if (current.kind === "miss") {
          lookup = store.reserve(idempotencyKey, args.commandName, requestHash);
          resolved = true;
          break;
        }
        lookup = current;
        resolved = true;
        break;
      }

      if (resolved) {
        break;
      }

      lookup = store.reserve(idempotencyKey, args.commandName, requestHash);
      if (lookup.kind === "pending") {
        throw new CliError(
          "retryable_upstream",
          "A matching mutation is already in progress. Retry this request shortly.",
          { retryable: true },
        );
      }
    }

    if (lookup.kind === "conflict") {
      throw new CliError("idempotency_key_conflict", "Internal idempotency key collision.", {
        details: {
          command: args.commandName,
          stored_hash: lookup.storedHash,
          incoming_hash: requestHash,
        },
      });
    }

    if (lookup.kind === "replay") {
      await safeAppendAuditLog({
        command: args.commandName,
        entity: args.entity,
        request_id: args.requestId,
        idempotency_key: idempotencyKey,
        target_ids: args.targetIds,
        ok: true,
        timestamp: new Date().toISOString(),
      });
      return lookup.response as T;
    }

    ownsReservation = true;

    let response: T;
    try {
      response = await args.run();
    } catch (error) {
      if (!isAmbiguousMutationError(error, args.isAmbiguousError)) {
        throw error;
      }

      recoveryAttempted = true;

      if (args.recover) {
        try {
          const recovered = await args.recover();
          if (recovered !== null) {
            response = recovered;
            recoverySucceeded = true;
          } else {
            outcomeUncertain = true;
            throw new CliError(
              "retryable_upstream",
              "Mutation outcome could not be confirmed. Re-read before retrying.",
              { retryable: true },
            );
          }
        } catch {
          outcomeUncertain = true;
          throw new CliError(
            "retryable_upstream",
            "Mutation outcome could not be confirmed. Re-read before retrying.",
            { retryable: true },
          );
        }
      } else {
        outcomeUncertain = true;
        throw new CliError(
          "retryable_upstream",
          "Mutation outcome could not be confirmed. Re-read before retrying.",
          { retryable: true },
        );
      }
    }

    try {
      store.complete(idempotencyKey, args.commandName, requestHash, response);
    } catch {
      // Avoid surfacing internal idempotency persistence failures to callers
      // after the write has already succeeded or been verified.
      idempotencyPersistDegraded = true;
    }

    await safeAppendAuditLog({
      command: args.commandName,
      entity: args.entity,
      request_id: args.requestId,
      idempotency_key: idempotencyKey,
      target_ids: args.targetIds,
      ok: true,
      recovery_attempted: recoveryAttempted,
      recovery_succeeded: recoverySucceeded,
      idempotency_persist_degraded: idempotencyPersistDegraded,
      outcome_uncertain: false,
      timestamp: new Date().toISOString(),
    });

    return response;
  } catch (error) {
    if (ownsReservation) {
      store.release(idempotencyKey, args.commandName, requestHash);
    }

    await safeAppendAuditLog({
      command: args.commandName,
      entity: args.entity,
      request_id: args.requestId,
      idempotency_key: idempotencyKey,
      target_ids: args.targetIds,
      ok: false,
      recovery_attempted: recoveryAttempted,
      recovery_succeeded: recoverySucceeded,
      idempotency_persist_degraded: idempotencyPersistDegraded,
      outcome_uncertain: outcomeUncertain,
      timestamp: new Date().toISOString(),
    });
    throw error;
  } finally {
    store.close();
  }
}

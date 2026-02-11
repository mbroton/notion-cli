import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, "ntion");
  }
  return join(homedir(), ".config", "ntion");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getAuditLogPath(): string {
  return join(getConfigDir(), "audit.log");
}

export function getIdempotencyStorePath(): string {
  return join(getConfigDir(), "idempotency.json");
}

export function getIdempotencyLockPath(): string {
  return join(getConfigDir(), "idempotency.lock");
}

export function ensureConfigDir(): string {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

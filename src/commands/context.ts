import { loadConfig } from "../config/store.js";
import { AppConfig } from "../config/types.js";
import { CliError } from "../errors/cli-error.js";
import { NotionClientAdapter } from "../notion/client.js";

const AUTH_HINT = "Run `notcli auth` to configure your Notion API token.";

export interface CommonReadOptions {
  view?: "compact" | "full";
  fields?: string;
  limit?: string;
  cursor?: string;
  timeoutMs?: string;
}

export function parseCommaFields(fields: string | undefined): string[] | undefined {
  if (!fields) {
    return undefined;
  }
  return fields
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parsePositiveInt(value: string | undefined, label: string, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError("invalid_input", `${label} must be a positive integer.`);
  }
  return parsed;
}

export async function loadRuntime(options?: { timeoutMs?: string }): Promise<{
  config: AppConfig;
  notion: NotionClientAdapter;
}> {
  const config = await loadConfig();
  const apiKey = config.notion_api_key ?? process.env[config.notion_api_key_env];
  if (!apiKey) {
    throw new CliError(
      "auth_or_config",
      `No API token found. ${AUTH_HINT}`,
    );
  }

  const timeoutMs = parsePositiveInt(options?.timeoutMs, "timeout-ms", config.defaults.timeout_ms);

  return {
    config,
    notion: new NotionClientAdapter(apiKey, timeoutMs),
  };
}

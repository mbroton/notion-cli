import { z } from "zod";

export const DataSourcePropertySchema = z.object({
  id: z.string(),
  type: z.string(),
});

export const SchemaCacheEntrySchema = z.object({
  data_source_id: z.string().min(1),
  last_refreshed: z.string(),
  properties: z.record(z.string(), DataSourcePropertySchema),
});

export const AppConfigSchema = z.object({
  notion_api_key: z.string().optional(),
  notion_api_key_env: z.string().default("NOTION_API_KEY"),
  defaults: z
    .object({
      limit: z.number().int().positive().max(100).default(25),
      view: z.enum(["compact", "full"]).default("compact"),
      max_blocks: z.number().int().positive().max(2000).default(200),
      timeout_ms: z.number().int().positive().max(120000).default(30000),
      schema_ttl_hours: z.number().int().positive().max(720).default(24),
      bulk_create_concurrency: z.number().int().positive().max(20).default(5),
      search_scan_limit: z.number().int().positive().max(5000).default(500),
    })
    .default({}),
  schema_cache: z.record(z.string(), SchemaCacheEntrySchema).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export interface InitAuthConfigInput {
  notionApiKey?: string;
  notionApiKeyEnv?: string;
}

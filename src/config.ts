import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const DEFAULT_HOST = "https://cloud.langfuse.com"
const CONFIG_FILE_RELPATH = ".config/opencode-langfuse/config.json"

const pricingEntrySchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
})

const fileConfigSchema = z.object({
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
  host: z
    .string()
    .min(1)
    .refine((host) => host.startsWith("http://") || host.startsWith("https://"), {
      message: "host must start with http:// or https://",
    })
    .optional(),
  privacyPreset: z.enum(["metadata-only", "prompts-only", "conversations", "full-debug"]).optional(),
  pricing: z.record(z.string(), pricingEntrySchema).optional(),
})

export type FileConfig = z.infer<typeof fileConfigSchema>

export interface ResolvedConfig {
  source: "env" | "file"
  publicKey: string
  secretKey: string
  host: string
}

export interface UnresolvedConfig {
  source: "none"
  reason: string
}

export type CredentialConfig = ResolvedConfig | UnresolvedConfig

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}

async function readConfigFile(homeDir: string): Promise<{ config: FileConfig } | { reason: string }> {
  let raw: string
  try {
    raw = await readFile(join(homeDir, CONFIG_FILE_RELPATH), "utf8")
  } catch {
    return { reason: "config file not found" }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { reason: "config file is not valid JSON" }
  }
  const parsed = fileConfigSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue ? `${issue.path.join(".") || "config"}: ${issue.message}` : "unknown validation error"
    return { reason: `config file failed validation (${where})` }
  }
  return { config: parsed.data }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<CredentialConfig> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()

  const envPublicKey = env.LANGFUSE_PUBLIC_KEY
  const envSecretKey = env.LANGFUSE_SECRET_KEY
  if (nonEmpty(envPublicKey) && nonEmpty(envSecretKey)) {
    const baseUrl = nonEmpty(env.LANGFUSE_BASE_URL) ? env.LANGFUSE_BASE_URL : undefined
    const legacyHost = nonEmpty(env.LANGFUSE_HOST) ? env.LANGFUSE_HOST : undefined
    return {
      source: "env",
      publicKey: envPublicKey.trim(),
      secretKey: envSecretKey.trim(),
      host: (baseUrl ?? legacyHost ?? DEFAULT_HOST).trim(),
    }
  }

  const fromFile = await readConfigFile(homeDir)
  if ("config" in fromFile) {
    return {
      source: "file",
      publicKey: fromFile.config.publicKey,
      secretKey: fromFile.config.secretKey,
      host: fromFile.config.host ?? DEFAULT_HOST,
    }
  }

  const envReason =
    nonEmpty(envPublicKey) || nonEmpty(envSecretKey)
      ? "env credentials incomplete (both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required)"
      : "no LANGFUSE_* env vars"
  return {
    source: "none",
    reason: `${envReason}; ~/${CONFIG_FILE_RELPATH}: ${fromFile.reason}`,
  }
}

export function maskPublicKey(key: string): string {
  if (key.length <= 12) return "***"
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}

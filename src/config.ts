import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { PrivacyPreset } from "./capture-policy.js"
import type { PricingOverrides } from "./pricing.js"

const DEFAULT_HOST = "https://cloud.langfuse.com"
const CONFIG_FILE_RELPATH = ".config/opencode-langfuse/config.json"

/** Rates are USD per million tokens: finite, nonnegative; zero is a valid price. */
const finiteRate = z.number().finite().nonnegative()

const pricingEntrySchema = z.object({
  input: finiteRate,
  output: finiteRate,
  cacheRead: finiteRate.optional(),
  cacheWrite: finiteRate.optional(),
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
  privacyPreset?: PrivacyPreset
  /** File pricing entries; present only when the selected file branch supplied them. */
  pricing?: PricingOverrides
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

/**
 * Pricing keys are exact `${providerID}/${model.id}` strings, split at the
 * first slash; model ids may contain further slashes. Bare model aliases,
 * empty components, and case games are rejected, never guessed.
 */
function validPricingKey(key: string): boolean {
  const slash = key.indexOf("/")
  return slash > 0 && slash < key.length - 1
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
  if (parsed.data.pricing !== undefined) {
    for (const key of Object.keys(parsed.data.pricing)) {
      if (!validPricingKey(key)) {
        return {
          reason: `config file failed validation (pricing.${JSON.stringify(key)}: pricing keys must be "<providerID>/<model.id>")`,
        }
      }
    }
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
      ...(fromFile.config.privacyPreset !== undefined
        ? { privacyPreset: fromFile.config.privacyPreset }
        : {}),
      ...(fromFile.config.pricing !== undefined ? { pricing: fromFile.config.pricing } : {}),
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

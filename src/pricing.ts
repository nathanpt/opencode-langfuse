/**
 * Self-computed generation cost (feature-005, ADR-0002).
 *
 * The host-reported `cost` is diagnostic metadata only: it is 0 for unpriced
 * models and drops cache terms for priced ones. Exported cost is always
 * recomputed from normalized token usage times an independently resolved
 * price. Resolution picks exactly one source — never a mix:
 *
 *   1. config override, exact `${providerID}/${model.id}` key (explicit zeros
 *      are valid prices, not gaps)
 *   2. native model catalog, `(providerID, id)` match, first cost tier only
 *   3. bundled table, lowercased full model id
 *   4. no match → cost omitted, one warning per model per resolver lifetime
 *
 * Positive cache usage with a missing cache rate omits the entire cost —
 * never an input-rate or zero substitution, never a fall-through to a lower
 * source to fill the gap.
 *
 * Rates are USD per 1,000,000 tokens (how providers publish them); computed
 * amounts are USD.
 */

import { PRICE_PER_MILLION } from "./constants.js"
import type { GenerationUsage, ModelReference } from "./generations.js"
import { isRecord } from "./guards.js"
import { redactValue } from "./redaction.js"

/** USD per 1M tokens. Optional cache rates stay absent when unknown. */
export interface TokenPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** Config pricing entries, keyed by exact `${providerID}/${model.id}`. */
export type PricingOverrides = Readonly<Record<string, TokenPrice>>

/** USD amounts per category; optional components appear only when that usage is positive. */
export interface CostBreakdown {
  readonly input: number
  readonly output: number
  readonly reasoning?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly total: number
}

/** An immutable quote computed once per request from one resolved source. */
export interface GenerationPricing {
  readonly costDetails: CostBreakdown
  readonly source: "config" | "catalog" | "bundled"
  readonly tierCount?: number
  readonly firstTierApproximation?: true
  readonly assumption?: "off-peak"
}

export interface PricingResolver {
  price(model: ModelReference, usage: GenerationUsage): Promise<GenerationPricing | undefined>
}

export interface PricingOptions {
  overrides?: PricingOverrides
  loadCatalog(): Promise<unknown>
  log?(message: string): void
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function validUsage(usage: GenerationUsage): boolean {
  if (!isRate(usage.input) || !isRate(usage.output)) {
    return false
  }
  return (
    (usage.reasoning === undefined || isRate(usage.reasoning)) &&
    (usage.cacheRead === undefined || isRate(usage.cacheRead)) &&
    (usage.cacheWrite === undefined || isRate(usage.cacheWrite))
  )
}

function validPrice(price: TokenPrice): boolean {
  if (!isRate(price.input) || !isRate(price.output)) {
    return false
  }
  return (
    (price.cacheRead === undefined || isRate(price.cacheRead)) &&
    (price.cacheWrite === undefined || isRate(price.cacheWrite))
  )
}

/**
 * Compute USD cost from normalized usage and one selected price. Reasoning is
 * priced at the output rate (host precedent). A missing rate for positive
 * usage, an invalid input, or non-finite/overflow arithmetic returns
 * undefined — amounts keep full JS float precision (no rounding).
 */
export function computeCost(usage: GenerationUsage, price: TokenPrice): CostBreakdown | undefined {
  if (!validUsage(usage) || !validPrice(price)) {
    return undefined
  }
  if ((usage.cacheRead ?? 0) > 0 && price.cacheRead === undefined) {
    return undefined
  }
  if ((usage.cacheWrite ?? 0) > 0 && price.cacheWrite === undefined) {
    return undefined
  }
  const reasoning = usage.reasoning ?? 0
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  const inputCost = (usage.input * price.input) / PRICE_PER_MILLION
  const outputCost = (usage.output * price.output) / PRICE_PER_MILLION
  const reasoningCost = (reasoning * price.output) / PRICE_PER_MILLION
  const cacheReadCost = (cacheRead * (price.cacheRead ?? 0)) / PRICE_PER_MILLION
  const cacheWriteCost = (cacheWrite * (price.cacheWrite ?? 0)) / PRICE_PER_MILLION
  const total = inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost
  const parts = [inputCost, outputCost, reasoningCost, cacheReadCost, cacheWriteCost, total]
  if (!parts.every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined
  }
  const breakdown: {
    input: number
    output: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    total: number
  } = { input: inputCost, output: outputCost, total }
  // A category appears only when its usage is positive — even when a real
  // (or explicitly free) rate makes the amount zero.
  if (reasoning > 0) {
    breakdown.reasoning = reasoningCost
  }
  if (cacheRead > 0) {
    breakdown.cacheRead = cacheReadCost
  }
  if (cacheWrite > 0) {
    breakdown.cacheWrite = cacheWriteCost
  }
  return breakdown
}

interface BundledEntry {
  price: TokenPrice
  offPeak?: true
}

function bundled(input: number, output: number, cacheRead?: number, cacheWrite?: number): TokenPrice {
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  }
}

/**
 * Bundled starter price table. USD per 1M tokens, matched by lowercased full
 * model id — no family prefixes or namespace stripping, because guesses
 * misprice. An absent cache rate is unknown, not zero: positive cache usage
 * against such an entry omits the cost.
 *
 * Prices sourced from provider listings dated 2026-07 (deepseek-v4: 2026-08).
 * Model pricing drifts — the once-per-model omission warning plus per-model
 * config overrides are the intended correction path. This is a published-rate
 * fallback, not a provider bill.
 */
const BUNDLED_EXACT: Record<string, BundledEntry> = {
  // DeepSeek (official API)
  "deepseek-v3": { price: bundled(0.27, 1.1, 0.07) },
  "deepseek-v3.1": { price: bundled(0.27, 1.1, 0.07) },
  "deepseek-chat": { price: bundled(0.27, 1.1, 0.07) },
  "deepseek-r1": { price: bundled(0.55, 2.19, 0.14) },
  // DeepSeek V4 (2026-08-16 increase; now billed peak/off-peak by UTC hour —
  // peak = 01:00-04:00 and 06:00-10:00 UTC, exactly 2x the off-peak rates).
  // The table carries OFF-PEAK, DeepSeek's listed base tier (15 of 24 hours);
  // quotes from these entries carry assumption:"off-peak". Override in config
  // for peak accounting; no time-of-day logic is implemented.
  "deepseek-v4-flash": { price: bundled(0.22, 0.66, 0.007), offPeak: true },
  "deepseek-v4-pro": { price: bundled(0.66, 1.98, 0.022), offPeak: true },
  // Zhipu GLM-4.6 (sourced from Deep Infra / OpenRouter listings)
  "glm-4.6": { price: bundled(0.43, 1.74, 0.08) },
  "glm-4-32b": { price: bundled(0.43, 1.74, 0.08) },
  // Zhipu GLM-5.x (API rates from Z.ai / bigmodel.cn listings, corroborated by
  // the catalog's own coreweave GLM-5.1 entry). cacheWrite is not published.
  "glm-5": { price: bundled(1.4, 4.4, 0.26) },
  "glm-5.1": { price: bundled(1.4, 4.4, 0.26) },
  "glm-5.2": { price: bundled(1.4, 4.4, 0.26) },
  // Anthropic Claude
  "claude-sonnet-4": { price: bundled(3, 15, 0.3, 3.75) },
  "claude-3-5-sonnet": { price: bundled(3, 15, 0.3, 3.75) },
  "claude-3-7-sonnet": { price: bundled(3, 15, 0.3, 3.75) },
  "claude-haiku-4": { price: bundled(1, 5, 0.1, 1.25) },
  "claude-3-5-haiku": { price: bundled(1, 5, 0.1, 1.25) },
  "claude-opus-4": { price: bundled(15, 75, 1.5, 18.75) },
  "claude-3-opus": { price: bundled(15, 75, 1.5, 18.75) },
  // OpenAI
  "gpt-4.1": { price: bundled(2, 8, 0.5) },
  "gpt-4.1-mini": { price: bundled(0.4, 1.6, 0.1) },
  "gpt-4.1-nano": { price: bundled(0.1, 0.4, 0.025) },
  "gpt-4o": { price: bundled(2.5, 10, 1.25) },
  "gpt-4o-mini": { price: bundled(0.15, 0.6, 0.075) },
  "o3-mini": { price: bundled(1.1, 4.4, 0.55) },
  "o4-mini": { price: bundled(1.1, 4.4, 0.55) },
}

interface CatalogQuote {
  price: TokenPrice
  tierCount: number
  firstTierApproximation?: true
}

function isAllZero(price: TokenPrice): boolean {
  return price.input === 0 && price.output === 0 && price.cacheRead === 0 && price.cacheWrite === 0
}

function sameQuote(a: CatalogQuote, b: CatalogQuote): boolean {
  return (
    a.price.input === b.price.input &&
    a.price.output === b.price.output &&
    a.price.cacheRead === b.price.cacheRead &&
    a.price.cacheWrite === b.price.cacheWrite &&
    a.tierCount === b.tierCount &&
    a.firstTierApproximation === b.firstTierApproximation
  )
}

/**
 * Defensive parse of the native `{location, data}` catalog envelope. Only the
 * needed row fields are read (`id`, `providerID`, `cost`); settings,
 * credentials, headers, and display names are ignored. `modelID` never
 * substitutes for `id`. Malformed rows are skipped; identical duplicates
 * collapse; conflicting duplicates make that identity unusable. Returns
 * undefined for a malformed envelope.
 */
function parseCatalog(raw: unknown): Map<string, CatalogQuote> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    return undefined
  }
  const quotes = new Map<string, CatalogQuote>()
  const conflicting = new Set<string>()
  for (const row of raw.data) {
    if (!isRecord(row)) {
      continue
    }
    const { id, providerID, cost } = row
    if (typeof id !== "string" || id.length === 0 || typeof providerID !== "string" || providerID.length === 0) {
      continue
    }
    if (!Array.isArray(cost) || cost.length === 0) {
      continue
    }
    const tier = cost[0]
    if (!isRecord(tier)) {
      continue
    }
    const cache = isRecord(tier.cache) ? tier.cache : undefined
    const input = tier.input
    const output = tier.output
    const cacheRead = cache?.read
    const cacheWrite = cache?.write
    // All four first-tier rates must be finite and nonnegative; anything else
    // is a miss — a later tier never hides an invalid first one.
    if (!isRate(input) || !isRate(output) || !isRate(cacheRead) || !isRate(cacheWrite)) {
      continue
    }
    const key = `${providerID}/${id}`
    if (conflicting.has(key)) {
      continue
    }
    const quote: CatalogQuote = {
      price: { input, output, cacheRead, cacheWrite },
      tierCount: cost.length,
      // Multi-tier or context-conditional pricing: tier zero is used and the
      // approximation is flagged — no threshold inference.
      ...(cost.length > 1 || tier.tier !== undefined ? { firstTierApproximation: true as const } : {}),
    }
    const existing = quotes.get(key)
    if (existing !== undefined) {
      if (sameQuote(existing, quote)) {
        continue
      }
      conflicting.add(key)
      quotes.delete(key)
      continue
    }
    quotes.set(key, quote)
  }
  return quotes
}

const CATALOG_TIMEOUT_MS = 3_000
const DIAGNOSTIC_LIMIT = 300
const CATALOG_UNAVAILABLE = "Price catalog unavailable; using configured/bundled prices"
const OMITTED_BASE = "no resolvable price"
const OMITTED_SUFFIX = "configure pricing in ~/.config/opencode-langfuse/config.json (USD per million tokens)"

export function createPricingResolver(options: PricingOptions): PricingResolver {
  const overrides = options.overrides
  const loadCatalog = options.loadCatalog
  const log = options.log ?? ((message: string) => console.warn(`📊 Langfuse: ${message}`))
  const warnedModels = new Set<string>()
  let catalogAttempt: Promise<Map<string, CatalogQuote>> | undefined

  function diagnostic(message: string): void {
    const text = String(redactValue(message))
    log(text.length > DIAGNOSTIC_LIMIT ? `${text.slice(0, DIAGNOSTIC_LIMIT)}... [truncated]` : text)
  }

  /** At most one omission warning per exact provider/model for the resolver lifetime. */
  function warnOnce(key: string, reason?: string): void {
    if (warnedModels.has(key)) {
      return
    }
    warnedModels.add(key)
    diagnostic(`Cost omitted for model "${key}": ${reason ?? OMITTED_BASE}; ${OMITTED_SUFFIX}`)
  }

  /**
   * Single-flight catalog load, bounded to one owned 3,000 ms timer. The
   * native promise gets rejection handling immediately; late settlement is
   * ignored permanently (no refresh, no second warning, no cancellation
   * claim — native work may continue until it settles or the host unloads).
   */
  function catalogFor(): Promise<Map<string, CatalogQuote>> {
    if (catalogAttempt !== undefined) {
      return catalogAttempt
    }
    const { promise, resolve } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => resolve(undefined), CATALOG_TIMEOUT_MS)
    timer.unref?.()
    loadCatalog().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
    catalogAttempt = promise.then((raw) => {
      try {
        const parsed = raw === undefined ? undefined : parseCatalog(raw)
        if (parsed === undefined) {
          diagnostic(CATALOG_UNAVAILABLE)
          return new Map<string, CatalogQuote>()
        }
        return parsed
      } catch {
        diagnostic(CATALOG_UNAVAILABLE)
        return new Map<string, CatalogQuote>()
      }
    })
    return catalogAttempt
  }

  function quote(
    key: string,
    usage: GenerationUsage,
    price: TokenPrice,
    source: GenerationPricing["source"],
    extras?: Partial<Pick<GenerationPricing, "tierCount" | "firstTierApproximation" | "assumption">>,
  ): GenerationPricing | undefined {
    // The selected source is indivisible: a missing rate for positive usage
    // omits everything rather than mixing in another source or substituting.
    if ((usage.cacheRead ?? 0) > 0 && price.cacheRead === undefined) {
      warnOnce(key, "missing cacheRead rate")
      return undefined
    }
    if ((usage.cacheWrite ?? 0) > 0 && price.cacheWrite === undefined) {
      warnOnce(key, "missing cacheWrite rate")
      return undefined
    }
    const costDetails = computeCost(usage, price)
    if (costDetails === undefined) {
      warnOnce(key, "invalid usage or computed amount")
      return undefined
    }
    return { costDetails, source, ...extras }
  }

  async function price(model: ModelReference, usage: GenerationUsage): Promise<GenerationPricing | undefined> {
    const key = `${model.providerID}/${model.id}`
    if (!validUsage(usage)) {
      warnOnce(key, "invalid usage or computed amount")
      return undefined
    }
    // 1. Exact config override — short-circuits any catalog loading.
    const override = overrides?.[key]
    if (override !== undefined) {
      return quote(key, usage, override, "config")
    }
    // 2. Native catalog, matched by (providerID, id); first tier only. An
    //    all-zero tier is unpriced and falls through to bundled/omission.
    const catalog = await catalogFor()
    const catalogQuote = catalog.get(key)
    if (catalogQuote !== undefined && !isAllZero(catalogQuote.price)) {
      return quote(key, usage, catalogQuote.price, "catalog", {
        tierCount: catalogQuote.tierCount,
        ...(catalogQuote.firstTierApproximation ? { firstTierApproximation: true } : {}),
      })
    }
    // 3. Bundled table, lowercased full model id (provider ignored here —
    //    attribution/warnings above still retain the provider).
    const bundledEntry = BUNDLED_EXACT[model.id.toLowerCase()]
    if (bundledEntry !== undefined) {
      return quote(key, usage, bundledEntry.price, "bundled", bundledEntry.offPeak ? { assumption: "off-peak" } : {})
    }
    // 4. No match: omit cost, warn once.
    warnOnce(key)
    return undefined
  }

  return { price }
}

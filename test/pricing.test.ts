import assert from "node:assert/strict"
import test from "node:test"
import type { GenerationUsage, ModelReference } from "../src/generations.js"
import { computeCost, createPricingResolver, type PricingOptions } from "../src/pricing.js"

const USAGE: GenerationUsage = { input: 37, output: 5, reasoning: 2, cacheRead: 5, cacheWrite: 0 }
const OVERRIDE_PRICE = { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.25 }

function near(actual: number | undefined, expected: number, message?: string): void {
  const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-9)
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be ≈ ${expected}`,
  )
}

/** One macrotask boundary: all pending microtasks (continuations, timers' effects) have run. */
async function macrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

interface TestResolverOptions extends Partial<Omit<PricingOptions, "log">> {}

function makeResolver(options: TestResolverOptions = {}, logs?: string[]) {
  return createPricingResolver({
    loadCatalog: async () => ({ data: [] }),
    ...options,
    ...(logs ? { log: (message: string) => logs.push(message) } : {}),
  })
}

function catalogRow(id: string, providerID: string, cost: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { id, providerID, cost, ...extra }
}

function tier(input: number, output: number, read = 0, write = 0, extra?: Record<string, unknown>): unknown {
  return { input, output, cache: { read, write }, ...(extra ?? {}) }
}

function omissionWarnings(logs: string[]): string[] {
  return logs.filter((m) => m.includes("Cost omitted for model"))
}

test("computeCost matches the hand-computed vectors exactly", () => {
  const breakdown = computeCost(USAGE, OVERRIDE_PRICE)
  assert.ok(breakdown)
  near(breakdown.input, 0.0000555)
  near(breakdown.output, 0.000045)
  near(breakdown.reasoning, 0.000018)
  near(breakdown.cacheRead, 0.00000075)
  assert.equal(breakdown.cacheWrite, undefined, "zero cacheWrite usage emits no cacheWrite cost")
  near(breakdown.total, 0.00011925)

  const withWrite = computeCost({ ...USAGE, cacheWrite: 3 }, OVERRIDE_PRICE)
  assert.ok(withWrite)
  near(withWrite.cacheWrite, 3 * 1.25 / 1_000_000)
  near(withWrite.total, 0.000123)

  const cacheHeavy = computeCost(
    { input: 37, output: 5, reasoning: 2, cacheRead: 1000, cacheWrite: 0 },
    OVERRIDE_PRICE,
  )
  assert.ok(cacheHeavy)
  near(cacheHeavy.cacheRead, 0.00015)
  near(cacheHeavy.total, 0.0002685)
})

test("computeCost emits all of input/output/total even when usage or price is zero", () => {
  const zeroUsage = computeCost({ input: 0, output: 0 }, { input: 1.5, output: 9 })
  assert.ok(zeroUsage)
  assert.equal(zeroUsage.input, 0)
  assert.equal(zeroUsage.output, 0)
  assert.equal(zeroUsage.total, 0, "known zero usage yields a defined zero cost")

  const reasoningOnly = computeCost({ input: 0, output: 0, reasoning: 5 }, { input: 1.5, output: 9 })
  assert.ok(reasoningOnly)
  assert.equal(reasoningOnly.input, 0)
  assert.equal(reasoningOnly.output, 0)
  near(reasoningOnly.reasoning, 5 * 9 / 1_000_000, "reasoning is priced at the output rate")
  near(reasoningOnly.total, 45 / 1_000_000)

  const free = computeCost(USAGE, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.ok(free)
  assert.equal(free.total, 0, "an explicitly free price yields true zero cost")
  near(free.cacheRead, 0, "positive usage keeps the category at a real zero")
})

test("computeCost keeps tiny positive amounts below 1e-8 without rounding", () => {
  const tiny = computeCost({ input: 1, output: 0 }, { input: 0.000_001, output: 9 })
  assert.ok(tiny)
  near(tiny.total, 1e-12, "no eight-decimal rounding: tiny valid costs survive")
  assert.ok(tiny.total > 0)
})

test("computeCost rejects invalid usage, invalid prices, missing needed rates, and overflow", () => {
  const price = OVERRIDE_PRICE
  assert.equal(computeCost({ input: -1, output: 5 }, price), undefined, "negative usage")
  assert.equal(computeCost({ input: Number.NaN, output: 5 }, price), undefined, "NaN usage")
  assert.equal(computeCost({ input: 1, output: 5, reasoning: -2 }, price), undefined, "negative reasoning")
  assert.equal(computeCost(USAGE, { input: -1.5, output: 9 }), undefined, "negative price")
  assert.equal(computeCost(USAGE, { input: Number.POSITIVE_INFINITY, output: 9 }), undefined, "non-finite price")
  assert.equal(
    computeCost(USAGE, { input: 1.5, output: 9, cacheWrite: 1.25 }),
    undefined,
    "positive cacheRead usage with a missing cacheRead rate",
  )
  assert.equal(
    computeCost({ input: 37, output: 5, cacheWrite: 2 }, { input: 1.5, output: 9, cacheRead: 0.15 }),
    undefined,
    "positive cacheWrite usage with a missing cacheWrite rate",
  )
  const harmless = computeCost({ input: 37, output: 5, reasoning: 2 }, { input: 1.5, output: 9 })
  assert.ok(harmless, "missing cache rates with absent cache usage are harmless")
  const overflow = computeCost({ input: 1e308, output: 0 }, { input: 5e10, output: 9 })
  assert.equal(overflow, undefined, "overflowing arithmetic is a miss, not Infinity")
})

test("an exact config override beats catalog and bundled without loading the catalog", async () => {
  const logs: string[] = []
  let loads = 0
  const resolver = makeResolver(
    {
      overrides: { "mock/mock-1": OVERRIDE_PRICE },
      loadCatalog: async () => {
        loads += 1
        return { data: [catalogRow("mock-1", "mock", [tier(100, 200)])] }
      },
    },
    logs,
  )
  const quote = await resolver.price({ providerID: "mock", id: "mock-1" }, USAGE)
  assert.ok(quote)
  assert.equal(quote.source, "config")
  near(quote.costDetails.total, 0.00011925)
  assert.equal(loads, 0, "an exact override never loads the catalog")
  await resolver.price({ providerID: "mock", id: "mock-1" }, USAGE)
  assert.equal(loads, 0)
  assert.equal(omissionWarnings(logs).length, 0)
})

test("the same model id on another provider resolves independently", async () => {
  const logs: string[] = []
  const resolver = makeResolver(
    {
      overrides: { "mock/mock-1": OVERRIDE_PRICE },
      loadCatalog: async () => ({ data: [catalogRow("mock-1", "other", [tier(7, 11)])] }),
    },
    logs,
  )
  const priced = await resolver.price({ providerID: "mock", id: "mock-1" }, USAGE)
  assert.ok(priced)
  assert.equal(priced.source, "config", "the override key includes the provider")

  const other = await resolver.price({ providerID: "other", id: "mock-1" }, USAGE)
  assert.ok(other)
  assert.equal(other.source, "catalog", "the other provider matches its own catalog row")
  near(other.costDetails.total, (37 * 7 + 5 * 11 + 2 * 11 + 5 * 0) / 1_000_000)
})

test("catalog modelID never replaces id", async () => {
  const logs: string[] = []
  const resolver = makeResolver(
    {
      loadCatalog: async () => ({
        data: [catalogRow("cat-1", "mock", [tier(1, 2)], { modelID: "mock-1" })],
      }),
    },
    logs,
  )
  const byModelID = await resolver.price({ providerID: "mock", id: "mock-1" }, USAGE)
  assert.equal(byModelID, undefined, "a row whose modelID matches but id does not is not a catalog source")
  assert.equal(omissionWarnings(logs).length, 1)

  const byID = await resolver.price({ providerID: "mock", id: "cat-1" }, USAGE)
  assert.ok(byID)
  assert.equal(byID.source, "catalog")
})

test("a nonzero catalog tier beats bundled; all-zero falls through; mixed-zero is valid", async () => {
  const nonzero = makeResolver({ loadCatalog: async () => ({ data: [catalogRow("glm-5.2", "mock", [tier(9, 19, 1.9, 0)])] }) })
  const catalogQuote = await nonzero.price({ providerID: "mock", id: "glm-5.2" }, USAGE)
  assert.ok(catalogQuote)
  assert.equal(catalogQuote.source, "catalog", "nonzero catalog rates shadow the bundled table")

  const allZero = makeResolver({
    loadCatalog: async () => ({ data: [catalogRow("glm-5.2", "mock", [tier(0, 0, 0, 0)])] }),
  })
  const bundledQuote = await allZero.price({ providerID: "mock", id: "glm-5.2" }, USAGE)
  assert.ok(bundledQuote)
  assert.equal(bundledQuote.source, "bundled", "an all-zero catalog tier falls through to bundled rates")
  near(bundledQuote.costDetails.total, 0.0000839)

  const mixedZero = makeResolver({
    loadCatalog: async () => ({ data: [catalogRow("glm-5.2", "mock", [tier(0, 2, 0, 0)])] }),
  })
  const mixedQuote = await mixedZero.price({ providerID: "mock", id: "glm-5.2" }, USAGE)
  assert.ok(mixedQuote)
  assert.equal(mixedQuote.source, "catalog", "mixed-zero tiers are valid, not unpriced")
  near(mixedQuote.costDetails.input, 0)
  near(mixedQuote.costDetails.output, 0.00001)
})

test("empty, malformed, and conflicting catalog rows never break resolution", async () => {
  const logs: string[] = []
  const resolver = makeResolver(
    {
      loadCatalog: async () => ({
        data: [
          null,
          42,
          "row",
          { providerID: "mock", cost: [tier(1, 1)] },
          { id: "no-cost", providerID: "mock" },
          catalogRow("empty-cost", "mock", []),
          catalogRow("bad-tier", "mock", [{ input: "x", output: 2, cache: { read: 0, write: 0 } }]),
          catalogRow("negative", "mock", [tier(-1, 2, 0, 0)]),
          catalogRow("hidden-by-invalid-first", "mock", [
            { input: "bad", output: 2, cache: { read: 0, write: 0 } },
            tier(5, 5, 0, 0),
          ]),
          catalogRow("good", "mock", [tier(2, 3, 0.2, 0)]),
          catalogRow("good", "mock", [tier(2, 3, 0.2, 0)]),
          catalogRow("conflicted", "mock", [tier(1, 1, 0, 0)]),
          catalogRow("conflicted", "mock", [tier(9, 9, 0, 0)]),
        ],
      }),
    },
    logs,
  )
  const good = await resolver.price({ providerID: "mock", id: "good" }, USAGE)
  assert.ok(good)
  assert.equal(good.source, "catalog", "identical duplicate rows collapse")
  near(good.costDetails.total, (37 * 2 + 5 * 3 + 2 * 3 + 5 * 0.2) / 1_000_000)

  const conflicted = await resolver.price({ providerID: "mock", id: "conflicted" }, USAGE)
  assert.equal(conflicted, undefined, "conflicting duplicates make the identity unusable")
  const invalidFirst = await resolver.price({ providerID: "mock", id: "hidden-by-invalid-first" }, USAGE)
  assert.equal(invalidFirst, undefined, "a later tier never hides an invalid first tier")
  assert.equal(omissionWarnings(logs).length, 2)
})

test("a failing or malformed catalog is diagnosed once, cached, and never breaks traces", async () => {
  const logs: string[] = []
  let loads = 0
  const resolver = makeResolver(
    {
      loadCatalog: async () => {
        loads += 1
        throw new Error("catalog endpoint down")
      },
    },
    logs,
  )
  const glm = await resolver.price({ providerID: "mock", id: "glm-5.2" }, USAGE)
  assert.ok(glm)
  assert.equal(glm.source, "bundled", "a failed catalog falls through to bundled rates")
  assert.equal(logs.filter((m) => m.includes("Price catalog unavailable")).length, 1)
  const unknown = await resolver.price({ providerID: "mock", id: "mystery" }, USAGE)
  assert.equal(unknown, undefined)
  await resolver.price({ providerID: "mock", id: "glm-5.1" }, USAGE)
  assert.equal(loads, 1, "the failed attempt is cached for the resolver lifetime")
  assert.equal(logs.filter((m) => m.includes("Price catalog unavailable")).length, 1, "no repeated diagnostics")

  const malformed = makeResolver({ loadCatalog: async () => ({ data: "not-an-array" }) }, logs)
  const afterMalformed = await malformed.price({ providerID: "mock", id: "glm-5.2" }, USAGE)
  assert.ok(afterMalformed)
  assert.equal(afterMalformed.source, "bundled")
  assert.equal(
    logs.filter((m) => m.includes("Price catalog unavailable")).length,
    2,
    "a malformed envelope is its own single diagnosis",
  )
})

test("concurrent resolutions share one catalog attempt", async () => {
  const gate = Promise.withResolvers<void>()
  let loads = 0
  const resolver = makeResolver({
    loadCatalog: async () => {
      loads += 1
      await gate.promise
      return { data: [catalogRow("shared-a", "mock", [tier(1, 1)]), catalogRow("shared-b", "mock", [tier(2, 2)])] }
    },
  })
  const models: ModelReference[] = [
    { providerID: "mock", id: "shared-a" },
    { providerID: "mock", id: "shared-b" },
    { providerID: "mock", id: "shared-a" },
  ]
  const pending = models.map((model) => resolver.price(model, { input: 1, output: 1 }))
  await macrotask()
  assert.equal(loads, 1, "concurrent lookups start exactly one load")
  gate.resolve()
  const quotes = await Promise.all(pending)
  assert.equal(quotes.every((q) => q !== undefined), true)
  assert.equal(loads, 1)
})

test("the catalog wait is bounded at 3000 ms and late settlement is inert", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const logs: string[] = []
  let loads = 0
  const deferred = Promise.withResolvers<unknown>()
  const resolver = makeResolver(
    {
      loadCatalog: () => {
        loads += 1
        return deferred.promise
      },
    },
    logs,
  )
  const pending = resolver.price({ providerID: "mock", id: "mock-1" }, USAGE)
  let settled = false
  void pending.then(() => {
    settled = true
  })
  await macrotask()
  assert.equal(settled, false, "a hanging loader holds the quote open")
  t.mock.timers.tick(2_999)
  await macrotask()
  assert.equal(settled, false, "the deadline is exactly 3000 ms")
  t.mock.timers.tick(1)
  const omitted = await pending
  assert.equal(omitted, undefined, "after the deadline the model resolves from bundled/omission")
  assert.equal(omissionWarnings(logs).length, 1)

  // Late success after the timeout: cached failure wins permanently.
  let unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  deferred.resolve({ data: [catalogRow("mock-1", "mock", [tier(100, 200)])] })
  await macrotask()
  assert.equal(unhandled.length, 0, "late settlement has no unhandled rejection")
  process.off("unhandledRejection", onUnhandled)

  const again = await resolver.price({ providerID: "mock", id: "mock-1" }, USAGE)
  assert.equal(again, undefined, "no repricing after a late catalog resolve")
  assert.equal(loads, 1, "the loader is never restarted")
  assert.equal(omissionWarnings(logs).length, 1, "no second omission warning")
})

test("a late catalog rejection is handled and changes nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const logs: string[] = []
  const deferred = Promise.withResolvers<unknown>()
  const resolver = makeResolver({ loadCatalog: () => deferred.promise }, logs)
  const pending = resolver.price({ providerID: "mock", id: "glm-5.2" }, USAGE)
  t.mock.timers.tick(3_000)
  const bundled = await pending
  assert.ok(bundled)
  assert.equal(bundled.source, "bundled")

  let unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  deferred.reject(new Error("late catalog failure"))
  await macrotask()
  assert.equal(unhandled.length, 0, "the underlying promise keeps its rejection handler")
  process.off("unhandledRejection", onUnhandled)

  const again = await resolver.price({ providerID: "mock", id: "glm-5.2" }, USAGE)
  assert.ok(again && again.source === "bundled", "no repricing after a late rejection")
  assert.equal(omissionWarnings(logs).length, 0)
})

test("an explicit zero config price yields zero cost without an omission warning", async () => {
  const logs: string[] = []
  const resolver = makeResolver({ overrides: { "mock/mock-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, logs)
  const quote = await resolver.price({ providerID: "mock", id: "mock-free" }, USAGE)
  assert.ok(quote)
  assert.equal(quote.source, "config")
  assert.equal(quote.costDetails.total, 0)
  near(quote.costDetails.cacheRead, 0)
  assert.equal(omissionWarnings(logs).length, 0)
})

test("a missing needed cache rate omits the entire cost even when a lower source could fill it", async () => {
  const logs: string[] = []
  const resolver = makeResolver(
    {
      overrides: { "mock/mock-missing-cache": { input: 1.5, output: 9, cacheWrite: 1.25 } },
      loadCatalog: async () => ({ data: [catalogRow("mock-missing-cache", "mock", [tier(1.5, 9, 0.15, 1.25)])] }),
    },
    logs,
  )
  const quote = await resolver.price({ providerID: "mock", id: "mock-missing-cache" }, USAGE)
  assert.equal(quote, undefined, "the incomplete higher-priority source is never mixed with a lower one")
  const warnings = omissionWarnings(logs)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes("missing cacheRead rate"), warnings[0])
})

test("a missing cache rate with zero cache usage computes the rest", async () => {
  const logs: string[] = []
  const resolver = makeResolver(
    { overrides: { "mock/mock-missing-cache": { input: 1.5, output: 9, cacheWrite: 1.25 } } },
    logs,
  )
  const quote = await resolver.price(
    { providerID: "mock", id: "mock-missing-cache" },
    { input: 37, output: 5, reasoning: 2, cacheRead: 0, cacheWrite: 0 },
  )
  assert.ok(quote)
  near(quote.costDetails.total, 0.0001185)
  assert.equal(quote.costDetails.cacheRead, undefined)
  assert.equal(omissionWarnings(logs).length, 0)
})

test("an unknown model warns once per provider across repeats, sessions, and flushes", async () => {
  const logs: string[] = []
  const resolver = makeResolver({}, logs)
  const model: ModelReference = { providerID: "mock", id: "mystery-model" }
  await resolver.price(model, USAGE)
  await resolver.price(model, USAGE)
  await resolver.price(model, USAGE)
  assert.equal(
    logs.filter((m) => m.includes('Cost omitted for model "mock/mystery-model"')).length,
    1,
    "one warning per exact provider/model for the resolver lifetime",
  )
  await resolver.price({ providerID: "other", id: "mystery-model" }, USAGE)
  assert.equal(
    logs.filter((m) => m.includes('Cost omitted for model "other/mystery-model"')).length,
    1,
    "another provider for the same id warns independently",
  )
  const fresh = makeResolver({}, [])
  await fresh.price(model, USAGE)
  assert.equal(
    logs.filter((m) => m.includes('Cost omitted for model "mock/mystery-model"')).length,
    1,
    "the original resolver is untouched by a new one",
  )
})

test("bundled GLM rates and DeepSeek off-peak attribution", async () => {
  const logs: string[] = []
  const resolver = makeResolver({}, logs)
  const glm = await resolver.price({ providerID: "zhipu", id: "glm-5.2" }, USAGE)
  assert.ok(glm)
  assert.equal(glm.source, "bundled")
  near(glm.costDetails.total, 0.0000839)
  assert.equal(glm.costDetails.cacheWrite, undefined, "no guessed cacheWrite for GLM")
  assert.equal(glm.assumption, undefined)

  const flash = await resolver.price({ providerID: "deepseek", id: "DeepSeek-V4-Flash" }, USAGE)
  assert.ok(flash)
  assert.equal(flash.source, "bundled")
  assert.equal(flash.assumption, "off-peak", "bundled V4 quotes are flagged off-peak")
  assert.equal(flash.costDetails.cacheWrite, undefined)
  assert.equal(omissionWarnings(logs).length, 0)
})

test("catalog tier selection follows the context threshold exactly", async () => {
  // Real models.dev tier shape (qiniu-ai/qwen3-coder-480b-a35b-instruct):
  // base row first, then context-threshold tiers at 32k and 128k.
  const twoTier = makeResolver({
    loadCatalog: async () => ({
      data: [
        catalogRow("multi", "mock", [
          tier(0.86956522, 3.47826087),
          tier(1.30434783, 5.2173913, 0, 0, { tier: { type: "context", size: 32_000 } }),
          tier(2.17391304, 8.69565217, 0, 0, { tier: { type: "context", size: 128_000 } }),
        ]),
      ],
    }),
  })

  const low = await twoTier.price(
    { providerID: "mock", id: "multi" },
    { input: 4_200, output: 7, reasoning: 2, cacheRead: 0, cacheWrite: 0 },
  )
  assert.ok(low)
  assert.equal(low.tierCount, 3)
  assert.equal(low.pricingTier, undefined, "below every threshold the base row is the exact quote")
  assert.equal(low.firstTierApproximation, undefined)
  near(low.costDetails.input, (4_200 * 0.86956522) / 1_000_000)

  // The discriminator is input + cacheRead + cacheWrite, so cache traffic
  // alone can cross the threshold (5_000 + 35_000 = 40_000 → 32k tier).
  const viaCache = await twoTier.price(
    { providerID: "mock", id: "multi" },
    { input: 5_000, output: 7, reasoning: 2, cacheRead: 35_000, cacheWrite: 0 },
  )
  assert.ok(viaCache)
  assert.deepEqual(viaCache.pricingTier, { type: "context", size: 32_000 })
  near(viaCache.costDetails.input, (5_000 * 1.30434783) / 1_000_000)
  near(viaCache.costDetails.cacheRead, 0, "cache rate stays the tier's own zero")

  // The highest exceeded threshold wins.
  const high = await twoTier.price(
    { providerID: "mock", id: "multi" },
    { input: 130_000, output: 7, reasoning: 2, cacheRead: 0, cacheWrite: 0 },
  )
  assert.ok(high)
  assert.deepEqual(high.pricingTier, { type: "context", size: 128_000 })
  near(high.costDetails.input, (130_000 * 2.17391304) / 1_000_000)

  // The boundary is strict: context equal to the size stays on the lower tier.
  const exact = await twoTier.price(
    { providerID: "mock", id: "multi" },
    { input: 32_000, output: 7, reasoning: 2, cacheRead: 0, cacheWrite: 0 },
  )
  assert.ok(exact)
  assert.equal(exact.pricingTier, undefined)
  near(exact.costDetails.input, (32_000 * 0.86956522) / 1_000_000)

  // Catalog order must not matter: a reversed tier list selects identically.
  const reversed = makeResolver({
    loadCatalog: async () => ({
      data: [
        catalogRow("multi", "mock", [
          tier(0.86956522, 3.47826087),
          tier(2.17391304, 8.69565217, 0, 0, { tier: { type: "context", size: 128_000 } }),
          tier(1.30434783, 5.2173913, 0, 0, { tier: { type: "context", size: 32_000 } }),
        ]),
      ],
    }),
  })
  const fromReversed = await reversed.price(
    { providerID: "mock", id: "multi" },
    { input: 40_000, output: 7, reasoning: 2, cacheRead: 0, cacheWrite: 0 },
  )
  assert.ok(fromReversed)
  assert.deepEqual(fromReversed.pricingTier, { type: "context", size: 32_000 })
})

test("unrecognizable tier rows degrade to the base and flag the approximation", async () => {
  const unknownDiscriminator = makeResolver({
    loadCatalog: async () => ({
      data: [
        catalogRow("unknown", "mock", [
          tier(1, 2),
          tier(4, 8, 0, 0, { tier: { type: "offpeak", size: 1000 } }),
        ]),
      ],
    }),
  })
  const uq = await unknownDiscriminator.price({ providerID: "mock", id: "unknown" }, USAGE)
  assert.ok(uq)
  assert.equal(uq.tierCount, 2)
  assert.equal(uq.pricingTier, undefined)
  assert.equal(uq.firstTierApproximation, true, "an unhonorable tier row makes the base quote an approximation")
  near(uq.costDetails.input, 37 / 1_000_000)

  const malformedTiers = makeResolver({
    loadCatalog: async () => ({
      data: [
        catalogRow("string-tier", "mock", [tier(1, 2), { input: 3, output: 6, cache: { read: 0, write: 0 }, tier: "context_over_200k" }]),
        catalogRow("bad-size", "mock", [tier(1, 2), tier(3, 6, 0, 0, { tier: { type: "context", size: "lots" } })]),
        catalogRow("bad-rates", "mock", [tier(1, 2), tier(-3, 6, 0, 0, { tier: { type: "context", size: 1000 } })]),
        catalogRow("null-tier", "mock", [tier(1, 2), { input: 3, output: 6, cache: { read: 0, write: 0 }, tier: null }]),
      ],
    }),
  })
  for (const id of ["string-tier", "bad-size", "bad-rates", "null-tier"]) {
    const q = await malformedTiers.price({ providerID: "mock", id }, USAGE)
    assert.ok(q, `${id} still quotes`)
    assert.equal(q.source, "catalog")
    assert.equal(q.pricingTier, undefined, `${id}: no tier selected`)
    assert.equal(q.firstTierApproximation, true, `${id}: base quote flagged`)
    near(q.costDetails.input, 37 / 1_000_000, `${id}: base carries the quote`)
  }
})

test("a tier array with no base row is a catalog miss", async () => {
  const logs: string[] = []
  const noBase = makeResolver(
    {
      loadCatalog: async () => ({
        data: [catalogRow("conditional", "mock", [tier(1, 2, 0, 0, { tier: { type: "context", size: 200_000 } })])],
      }),
    },
    logs,
  )
  const q = await noBase.price({ providerID: "mock", id: "conditional" }, USAGE)
  assert.equal(q, undefined, "without an undiscriminated row the model is unpriced")
  assert.equal(omissionWarnings(logs).length, 1)

  const single = makeResolver({ loadCatalog: async () => ({ data: [catalogRow("single", "mock", [tier(1, 2)])] }) })
  const singleQuote = await single.price({ providerID: "mock", id: "single" }, USAGE)
  assert.ok(singleQuote)
  assert.equal(singleQuote.tierCount, 1)
  assert.equal(singleQuote.firstTierApproximation, undefined)
  assert.equal(singleQuote.pricingTier, undefined)
})

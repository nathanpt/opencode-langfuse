import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConfig, maskPublicKey } from "../src/config.js"

async function makeHome(withFile?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "oc-langfuse-test-"))
  if (withFile !== undefined) {
    await mkdir(join(home, ".config", "opencode-langfuse"), { recursive: true })
    await writeFile(join(home, ".config", "opencode-langfuse", "config.json"), withFile, "utf8")
  }
  return home
}

async function withHome<T>(withFile: string | undefined, run: (home: string) => Promise<T>): Promise<T> {
  const home = await makeHome(withFile)
  try {
    return await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test("complete env credentials resolve with the default host", async () => {
  await withHome(undefined, async (home) => {
    const config = await loadConfig({
      env: { LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test" },
      homeDir: home,
    })
    assert.deepEqual(config, {
      source: "env",
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "https://cloud.langfuse.com",
    })
  })
})

test("LANGFUSE_HOST acts as the host fallback when BASE_URL is absent", async () => {
  await withHome(undefined, async (home) => {
    const config = await loadConfig({
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
        LANGFUSE_HOST: "https://langfuse.example.internal",
      },
      homeDir: home,
    })
    assert.deepEqual(config, {
      source: "env",
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "https://langfuse.example.internal",
    })
  })
})

test("BASE_URL takes precedence over LANGFUSE_HOST", async () => {
  await withHome(undefined, async (home) => {
    const config = await loadConfig({
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
        LANGFUSE_BASE_URL: "https://base.example.internal",
        LANGFUSE_HOST: "https://legacy.example.internal",
      },
      homeDir: home,
    })
    assert.ok(config.source === "env" && config.host === "https://base.example.internal")
  })
})

test("a valid config file resolves when env credentials are absent", async () => {
  await withHome(
    JSON.stringify({ publicKey: "pk-lf-file", secretKey: "sk-lf-file", host: "https://langfuse.home.arpa" }),
    async (home) => {
      const config = await loadConfig({ env: {}, homeDir: home })
      assert.deepEqual(config, {
        source: "file",
        publicKey: "pk-lf-file",
        secretKey: "sk-lf-file",
        host: "https://langfuse.home.arpa",
      })
    },
  )
})

test("config file without a host falls back to the default host", async () => {
  await withHome(JSON.stringify({ publicKey: "pk-lf-file", secretKey: "sk-lf-file" }), async (home) => {
    const config = await loadConfig({ env: {}, homeDir: home })
    assert.ok(config.source === "file" && config.host === "https://cloud.langfuse.com")
  })
})

test("partial env credentials fall through to a valid config file", async () => {
  await withHome(
    JSON.stringify({ publicKey: "pk-lf-file", secretKey: "sk-lf-file", host: "https://langfuse.home.arpa" }),
    async (home) => {
      const config = await loadConfig({
        env: { LANGFUSE_PUBLIC_KEY: "pk-lf-partial" },
        homeDir: home,
      })
      assert.ok(config.source === "file" && config.publicKey === "pk-lf-file")
    },
  )
})

test("empty-string env credentials are treated as absent, not as a broken env source", async () => {
  await withHome(undefined, async (home) => {
    const config = await loadConfig({
      env: { LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" },
      homeDir: home,
    })
    assert.equal(config.source, "none")
  })
})

test("invalid JSON in the config file degrades to unconfigured with the reason", async () => {
  await withHome("{ not json", async (home) => {
    const config = await loadConfig({ env: {}, homeDir: home })
    assert.ok(config.source === "none" && config.reason.includes("not valid JSON"))
  })
})

test("a config file failing schema validation names the offending field", async () => {
  await withHome(
    JSON.stringify({ publicKey: "pk-lf-file", secretKey: "sk-lf-file", host: "langfuse.home.arpa" }),
    async (home) => {
      const config = await loadConfig({ env: {}, homeDir: home })
      assert.ok(config.source === "none" && config.reason.includes("host"))
    },
  )
})

test("no env and no file yields unconfigured with both reasons", async () => {
  await withHome(undefined, async (home) => {
    const config = await loadConfig({ env: {}, homeDir: home })
    assert.ok(
      config.source === "none" &&
        config.reason.includes("no LANGFUSE_* env vars") &&
        config.reason.includes("config file not found"),
    )
  })
})

test("maskPublicKey keeps a recognizable prefix and suffix", () => {
  assert.equal(maskPublicKey("pk-lf-publickey-abcd1234"), "pk-lf-p…1234")
  assert.equal(maskPublicKey("short"), "***")
})

test("file pricing propagates through the file branch with zeros kept intact", async () => {
  await withHome(
    JSON.stringify({
      publicKey: "pk-lf-file",
      secretKey: "sk-lf-file",
      pricing: {
        "mock/mock-priced": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.25 },
        "mock/mock-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        "openrouter/deepseek/deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07 },
      },
    }),
    async (home) => {
      const config = await loadConfig({ env: {}, homeDir: home })
      assert.equal(config.source, "file")
      assert.ok(config.source === "file" && config.pricing !== undefined)
      assert.deepEqual(config.pricing["mock/mock-priced"], {
        input: 1.5,
        output: 9,
        cacheRead: 0.15,
        cacheWrite: 1.25,
      })
      assert.deepEqual(config.pricing["mock/mock-free"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      assert.deepEqual(config.pricing["openrouter/deepseek/deepseek-chat"], {
        input: 0.27,
        output: 1.1,
        cacheRead: 0.07,
      })
      assert.ok(!("cacheWrite" in config.pricing["openrouter/deepseek/deepseek-chat"]))
    },
  )
})

test("a file without pricing leaves pricing absent", async () => {
  await withHome(JSON.stringify({ publicKey: "pk-lf-file", secretKey: "sk-lf-file" }), async (home) => {
    const config = await loadConfig({ env: {}, homeDir: home })
    assert.ok(config.source === "file" && !("pricing" in config))
  })
})

test("complete env credentials still short-circuit file pricing", async () => {
  await withHome(
    JSON.stringify({
      publicKey: "pk-lf-file",
      secretKey: "sk-lf-file",
      pricing: { "mock/mock-priced": { input: 1.5, output: 9 } },
    }),
    async (home) => {
      const config = await loadConfig({
        env: { LANGFUSE_PUBLIC_KEY: "pk-lf-env", LANGFUSE_SECRET_KEY: "sk-lf-env" },
        homeDir: home,
      })
      assert.ok(config.source === "env" && !("pricing" in config))
    },
  )
})

test("pricing rates must be finite nonnegative numbers", async () => {
  await withHome(
    JSON.stringify({
      publicKey: "pk-lf-file",
      secretKey: "sk-lf-file",
      pricing: { "mock/mock-priced": { input: -1.5, output: 9 } },
    }),
    async (home) => {
      const config = await loadConfig({ env: {}, homeDir: home })
      assert.ok(config.source === "none" && config.reason.includes("pricing"))
    },
  )
  await withHome(
    JSON.stringify({
      publicKey: "pk-lf-file",
      secretKey: "sk-lf-file",
      pricing: { "mock/mock-priced": { input: "1.5", output: 9 } },
    }),
    async (home) => {
      const config = await loadConfig({ env: {}, homeDir: home })
      assert.ok(config.source === "none" && config.reason.includes("pricing"))
    },
  )
})

test("bare or incomplete pricing keys are rejected with the offending key named", async () => {
  for (const key of ["mock-priced", "/mock-priced", "mock/", ""]) {
    await withHome(
      JSON.stringify({
        publicKey: "pk-lf-file",
        secretKey: "sk-lf-file",
        pricing: { [key]: { input: 1.5, output: 9 } },
      }),
      async (home) => {
        const config = await loadConfig({ env: {}, homeDir: home })
        assert.ok(config.source === "none", `key ${JSON.stringify(key)} must be rejected`)
        assert.ok(config.reason.includes("pricing"), `reason names pricing for ${JSON.stringify(key)}`)
      },
    )
  }
})

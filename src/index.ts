import { Plugin } from "@opencode/plugin"
import { loadConfig, maskPublicKey } from "./config.js"

export default Plugin.define({
  id: "opencode-langfuse",
  async setup() {
    const config = await loadConfig()
    if (config.source === "none") {
      console.log(`📊 Langfuse: Disabled — ${config.reason}`)
    } else {
      console.log(
        `📊 Langfuse: Tracing enabled → ${config.host} (key ${maskPublicKey(config.publicKey)}, source ${config.source})`,
      )
    }
    return () => {
      // Flush/shutdown lands here with the transport (R5 design in ARCHITECTURE.md).
    }
  },
})

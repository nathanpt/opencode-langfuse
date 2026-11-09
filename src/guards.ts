/** The package's canonical object guard (style rule: one definition, exported). */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

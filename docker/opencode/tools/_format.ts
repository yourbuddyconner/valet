import { encode } from "@toon-format/toon"

/** Encode data as TOON for token-efficient LLM output. Falls back to JSON on error. */
export function formatOutput(data: unknown): string {
  try {
    return encode(data)
  } catch {
    return JSON.stringify(data, null, 2)
  }
}

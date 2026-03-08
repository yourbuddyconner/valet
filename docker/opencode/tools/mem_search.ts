import { tool } from "@opencode-ai/plugin"

// Models to try in order of preference
const RERANK_MODELS = [
  {
    key: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  },
  {
    key: "OPENAI_API_KEY",
    provider: "openai",
    model: "gpt-4o-mini",
  },
] as const

export default tool({
  description:
    "Search memory files using full-text search with optional LLM re-ranking. " +
    "Returns the most relevant files for the query, with match-aware snippets. " +
    "Use this before responding to any new request that may involve known projects, " +
    "preferences, workflows, or past decisions.",
  args: {
    query: tool.schema
      .string()
      .min(1)
      .describe("Search query. Examples: 'valet deployment', 'auth cloudflare', 'coding preferences'"),
    path: tool.schema
      .string()
      .optional()
      .describe("Optional path prefix to scope the search. Example: 'projects/valet/'"),
    rerank: tool.schema
      .boolean()
      .default(true)
      .describe("Whether to re-rank results with LLM (default true, set false for speed)"),
    limit: tool.schema
      .number()
      .default(5)
      .describe("Max results to return after re-ranking (default 5)"),
  },
  async execute(args) {
    try {
      // 1. Fetch top-20 candidates from FTS
      const params = new URLSearchParams({ query: args.query, limit: "20" })
      if (args.path) params.set("path", args.path)

      const res = await fetch(
        `http://localhost:9000/api/memory/search?${params.toString()}`,
      )
      if (!res.ok) {
        const errText = await res.text()
        return `Search failed: ${errText}`
      }

      const data = (await res.json()) as {
        results: { path: string; snippet: string; relevance: number }[]
      }

      if (!data.results || data.results.length === 0) {
        return `No matches for "${args.query}"`
      }

      const candidates = data.results
      const finalLimit = args.limit ?? 5

      // 2. Re-rank if enabled and we have an LLM available
      let ranked = candidates
      if (args.rerank !== false && candidates.length > 1) {
        const reranked = await rerankWithLLM(args.query, candidates)
        if (reranked) ranked = reranked
      }

      // 3. Format output
      const top = ranked.slice(0, finalLimit)
      const lines = [
        `Found ${candidates.length} matches for "${args.query}", showing top ${top.length}:\n`,
      ]
      for (let i = 0; i < top.length; i++) {
        const r = top[i]
        const scoreStr = (r.relevance * 100).toFixed(0) + "%"
        lines.push(`${i + 1}. ${r.path}  (score: ${scoreStr})`)
        lines.push(`   ${r.snippet.replace(/\n/g, "\n   ")}`)
        lines.push("")
      }
      return lines.join("\n")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Search failed: ${msg}`
    }
  },
})

// ─── LLM Re-ranking ──────────────────────────────────────────────────────────

interface Candidate {
  path: string
  snippet: string
  relevance: number
}

async function rerankWithLLM(
  query: string,
  candidates: Candidate[],
): Promise<Candidate[] | null> {
  // Find the first available provider
  const provider = RERANK_MODELS.find((m) => !!process.env[m.key])
  if (!provider) return null

  const docList = candidates
    .map((c, i) => `[${i + 1}] ${c.path}\n${c.snippet}`)
    .join("\n\n")

  const prompt = `You are a relevance judge. Score each document's relevance to the query.

Query: "${query}"

Documents:
${docList}

Respond with ONLY a JSON array of scores, one number per document in order.
Each score: 0.0 (not relevant) to 1.0 (highly relevant).
Example for 3 docs: [0.9, 0.2, 0.7]`

  try {
    let scores: number[] | null = null

    if (provider.provider === "anthropic") {
      scores = await callAnthropic(provider.model, prompt, process.env[provider.key]!)
    } else if (provider.provider === "openai") {
      scores = await callOpenAI(provider.model, prompt, process.env[provider.key]!)
    }

    if (!scores || scores.length !== candidates.length) return null

    // Re-sort candidates by LLM score, preserving path/snippet
    return candidates
      .map((c, i) => ({ ...c, relevance: scores![i] ?? c.relevance }))
      .sort((a, b) => b.relevance - a.relevance)
  } catch {
    // Re-ranking failure is non-fatal — return null to use FTS order
    return null
  }
}

const RERANK_TIMEOUT_MS = 8000

async function callAnthropic(model: string, prompt: string, apiKey: string): Promise<number[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS)
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as any
    const text = data?.content?.[0]?.text ?? ""
    return parseScores(text)
  } finally {
    clearTimeout(timer)
  }
}

async function callOpenAI(model: string, prompt: string, apiKey: string): Promise<number[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS)
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as any
    const text = data?.choices?.[0]?.message?.content ?? ""
    return parseScores(text)
  } finally {
    clearTimeout(timer)
  }
}

function parseScores(text: string): number[] | null {
  try {
    // Extract JSON array from text (LLM may include surrounding prose)
    const match = text.match(/\[[\d.,\s"e\-]+\]/i)
    if (!match) return null
    const arr = JSON.parse(match[0])
    if (!Array.isArray(arr)) return null
    return arr.map((v: unknown) => {
      const n = typeof v === "number" ? v : parseFloat(String(v))
      return isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
    })
  } catch {
    return null
  }
}

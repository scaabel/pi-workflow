/**
 * web tools — SearXNG search + Jina Reader fetch.
 *
 * - web_search: self-hosted SearXNG JSON API (no API key).
 * - web_fetch:  Jina Reader (r.jina.ai) → clean Markdown for a URL.
 *
 * Stdlib fetch only, no dependencies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SEARXNG_URL =
  (process.env.SEARXNG_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const SEARXNG_TIMEOUT_MS = Number(process.env.SEARXNG_TIMEOUT_MS ?? 15000);

const JINA_READER_URL =
  (process.env.JINA_READER_URL ?? "https://r.jina.ai/").replace(/\/+$/, "") +
  "/";
const JINA_API_KEY = process.env.JINA_API_KEY;

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

/** SearXNG returns JSON only when `format=json` is enabled on the instance. */
function parseSearxngResults(json: unknown): SearchHit[] {
  if (!json || typeof json !== "object") return [];
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      url: String(r.url ?? "").trim(),
      snippet: String(r.content ?? "").trim(),
    }))
    .filter((hit) => hit.url);
}

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via a self-hosted SearXNG instance. Returns numbered results with title, URL, and snippet. Set SEARXNG_URL to point at your instance (JSON format must be enabled). Use for current information, docs, or facts not in the codebase.",
    promptSnippet: "Search the web via SearXNG",
    promptGuidelines: [
      "Use web_search when a task needs current information, library documentation, or facts not present in the codebase.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, description: "Max results (default 8)" }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      if (!query) throw new Error("web_search: empty query");

      const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: withTimeout(signal, SEARXNG_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `web_search: SearXNG unreachable at ${SEARXNG_URL} — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `web_search: SearXNG returned HTTP ${response.status} — is format=json enabled in the instance settings.yml?`,
        );
      }

      const hits = parseSearxngResults(await response.json());
      if (hits.length === 0) {
        throw new Error(`web_search: no results for "${query}"`);
      }

      const shown = hits.slice(0, params.maxResults ?? 8);
      let text = shown
        .map(
          (hit, i) =>
            `${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ""}`,
        )
        .join("\n\n");

      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      if (truncation.truncated) {
        text = `${truncation.content}\n\n[Output truncated — refine the query for fewer results.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { hits: shown, engine: "searxng" },
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL as clean Markdown via Jina Reader (r.jina.ai). Use to read a specific page after web_search. Set JINA_API_KEY for higher rate limits.",
    promptSnippet: "Fetch a URL as Markdown",
    promptGuidelines: [
      "Use web_fetch to read a page found via web_search when its snippet is insufficient.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to fetch, e.g. https://example.com/doc" }),
    }),

    async execute(_toolCallId, params, signal) {
      const url = params.url.trim();
      if (!url) throw new Error("web_fetch: empty URL");
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("web_fetch: URL must start with http:// or https://");
      }

      // No browser User-Agent: Jina Reader rejects browser UA strings with 403.
      const headers: Record<string, string> = {};
      if (JINA_API_KEY) {
        headers.Authorization = `Bearer ${JINA_API_KEY}`;
      }

      let response: Response;
      try {
        response = await fetch(`${JINA_READER_URL}${url}`, {
          headers,
          signal: withTimeout(signal, SEARXNG_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `web_fetch: Jina Reader unreachable — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `web_fetch: HTTP ${response.status} — ${response.status === 429 ? "rate limited (set JINA_API_KEY for higher limits)" : "could not fetch"}`,
        );
      }

      let text = await response.text();
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      if (truncation.truncated) {
        text = `${truncation.content}\n\n[Content truncated.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { url, source: "jina-reader" },
      };
    },
  });
}

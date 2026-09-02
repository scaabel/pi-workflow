/**
 * web_search tool — keyless web search via DuckDuckGo's HTML endpoints.
 *
 * No API key, no dependency, stdlib fetch only.
 * // ponytail: scraping DDG HTML; if results silently stop, the markup
 * // changed — fix the two regexes below. Upgrade path: swap in a real
 * // search API (Tavily/Brave) behind the same tool signature.
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

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** DDG wraps result URLs in a redirect; unwrap the real target. */
function realUrl(href: string): string {
  let url = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(url);
    const uddg = u.searchParams.get("uddg");
    if (uddg) url = decodeURIComponent(uddg);
  } catch {
    /* keep as-is */
  }
  return url;
}

function parseHtmlResults(html: string): SearchHit[] {
  const links = [
    ...html.matchAll(
      /<a\b([^>]*\bclass="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/g,
    ),
  ];
  const snippets = [
    ...html.matchAll(
      /<a\b[^>]*\bclass="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
    ),
  ];
  return links.map((m, i) => ({
    title: clean(m[2]),
    url: realUrl(/href="([^"]+)"/.exec(m[1])?.[1] ?? ""),
    snippet: clean(snippets[i]?.[1] ?? ""),
  }));
}

function parseLiteResults(html: string): SearchHit[] {
  const links = [
    ...html.matchAll(
      /<a\b([^>]*\bclass="[^"]*result-link[^"]*"[^>]*)>([\s\S]*?)<\/a>/g,
    ),
  ];
  const snippets = [
    ...html.matchAll(
      /<td\b[^>]*\bclass="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g,
    ),
  ];
  return links.map((m, i) => ({
    title: clean(m[2]),
    url: realUrl(/href="([^"]+)"/.exec(m[1])?.[1] ?? ""),
    snippet: clean(snippets[i]?.[1] ?? ""),
  }));
}

const ENDPOINTS: Array<{ url: string; parse: (html: string) => SearchHit[] }> = [
  { url: "https://html.duckduckgo.com/html/?q=", parse: parseHtmlResults },
  { url: "https://lite.duckduckgo.com/lite/?q=", parse: parseLiteResults },
];

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web (DuckDuckGo, keyless). Returns numbered results with title, URL, and snippet. Use for current information, docs, or facts not in the codebase.",
    promptSnippet: "Search the web via DuckDuckGo",
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

      let hits: SearchHit[] = [];
      let lastError = "no results";

      for (const endpoint of ENDPOINTS) {
        try {
          const response = await fetch(endpoint.url + encodeURIComponent(query), {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept-Language": "en-US,en",
            },
            signal,
          });
          if (!response.ok) {
            lastError = `${endpoint.url} -> HTTP ${response.status}`;
            continue;
          }
          hits = endpoint.parse(await response.text());
          if (hits.length > 0) break;
          lastError = `${endpoint.url} -> parsed 0 results (markup changed?)`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      if (hits.length === 0) {
        throw new Error(`web_search failed for "${query}": ${lastError}`);
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

      return { content: [{ type: "text", text }], details: { hits: shown } };
    },
  });
}

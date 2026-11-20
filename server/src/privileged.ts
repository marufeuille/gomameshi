// Privileged (host-side) capabilities for 食事とPFC.
//
// fetchPageText: the action sandbox has no network egress of its own,
// but the AI food lookup's second stage needs the *body* of a candidate
// page — search-result snippets routinely cut off before the nutrition
// table (the table sits deep in a manufacturer's product page), which
// is why branded products timed out or came back not_found even though
// the maker publishes the values in plain HTML. This handler fetches
// ONE page (a URL the server picked from its own search results, or a
// link/form discovered on such a page), strips it to readable text,
// and also returns its outgoing links and its site-search form (if
// any): a maker's product page is often not itself in the search pool,
// but is one hop away from a page that is — via a category listing, a
// "原材料・栄養成分表示はこちら" link, or the store's own keyword
// search. It never guesses content: a failed fetch reports ok=false
// and no text.

import {
  definePrivilegedContracts,
  definePrivilegedHandlers,
  z,
} from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts({
  fetchPageText: {
    request: z.object({
      url: z.string().url().max(2000),
    }),
    response: z.object({
      ok: z.boolean(),
      status: z.number(),
      finalUrl: z.string(),
      title: z.string(),
      text: z.string(),
      links: z.array(z.object({ url: z.string(), text: z.string() })),
      searchForms: z.array(
        z.object({ action: z.string(), param: z.string() }),
      ),
    }),
    timeoutMs: 20000,
  },
});

const MAX_TEXT_CHARS = 120_000;
const MAX_LINKS = 250;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCharCode(Number(n) || 32),
    )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

function stripTags(fragment: string): string {
  return fragment
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(
  html: string,
  baseUrl: string,
): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_LINKS) {
    const href = (m[1] ?? "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }
    resolved.hash = "";
    const url = resolved.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, text: stripTags(m[2] ?? "").slice(0, 120) });
  }
  return out;
}

function extractSearchForms(
  html: string,
  baseUrl: string,
): Array<{ action: string; param: string }> {
  const out: Array<{ action: string; param: string }> = [];
  const formRe = /<form[^>]*>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(html)) !== null && out.length < 3) {
    const openTag = fm[0].slice(0, fm[0].indexOf(">") + 1);
    const method = /\bmethod="([^"]*)"/i.exec(openTag)?.[1] ?? "get";
    if (method.toLowerCase() !== "get") continue;
    const actionRaw = /\baction="([^"]*)"/i.exec(openTag)?.[1] ?? "";
    const formName = /\bname="([^"]*)"/i.exec(openTag)?.[1] ?? "";
    const body = fm[1] ?? "";
    // The keyword input of a site search is a text/search input whose
    // name reads like a query (keyword/q/key/s/word…); the form itself
    // usually also identifies as a search (name, id, or action path).
    const inputs = [...body.matchAll(/<input[^>]*>/gi)].map((x) => x[0]);
    for (const input of inputs) {
      const type = /\btype="([^"]*)"/i.exec(input)?.[1] ?? "text";
      if (type !== "text" && type !== "search") continue;
      const param = /\bname="([^"]*)"/i.exec(input)?.[1] ?? "";
      if (!param) continue;
      const looksLikeKeyword =
        /key|keyword|q$|query|word|search|name|free/i.test(param);
      const formLooksLikeSearch =
        /search|item_list|list|search_result/i.test(`${formName} ${actionRaw}`);
      if (!looksLikeKeyword && !formLooksLikeSearch) continue;
      let action: URL;
      try {
        action = new URL(actionRaw || baseUrl, baseUrl);
      } catch {
        continue;
      }
      if (action.protocol !== "http:" && action.protocol !== "https:") {
        continue;
      }
      action.hash = "";
      out.push({ action: action.toString(), param });
      break; // one keyword param per form is enough
    }
  }
  return out;
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async fetchPageText(args) {
    const empty = {
      ok: false,
      status: 0,
      finalUrl: args.url,
      title: "",
      text: "",
      links: [] as Array<{ url: string; text: string }>,
      searchForms: [] as Array<{ action: string; param: string }>,
    };
    const parsed = new URL(args.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return empty;
    }
    try {
      const res = await fetch(args.url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "ja,en;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !/html|text/.test(contentType)) {
        return { ...empty, status: res.status, finalUrl: res.url || args.url };
      }
      const html = await res.text();
      const finalUrl = res.url || args.url;
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      const title = (titleMatch?.[1] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      return {
        ok: true,
        status: res.status,
        finalUrl,
        title,
        text: htmlToText(html).slice(0, MAX_TEXT_CHARS),
        links: extractLinks(html, finalUrl),
        searchForms: extractSearchForms(html, finalUrl),
      };
    } catch {
      return empty;
    }
  },
});

/**
 * fairy-tales-web: `fetch` tool — retrieve a URL as readable text (or raw body).
 * No dependencies: naive HTML→text conversion, truncated to config maxBytes.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { loadFairyTalesConfig } from "../src/config.ts";
import { clipHead } from "../src/text.ts";
import { safeFetch } from "../src/net.ts";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(nav|footer|aside|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch",
    label: "Fetch URL",
    description:
      "Fetch a URL over HTTP(S) and return its content. mode 'text' (default) converts HTML to readable text; 'raw' returns the raw body. Output is truncated to ~50KB.",
    promptSnippet: "Fetch a web page or API endpoint and return its content",
    promptGuidelines: [
      "Use fetch to read documentation, APIs, or web pages when a URL is known or given by the user.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL to fetch" }),
      mode: Type.Optional(StringEnum(["text", "raw"] as const)),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cfg = loadFairyTalesConfig(ctx.cwd);
      const url = params.url;
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("fetch requires an absolute http(s) URL");
      }
      const timeout = AbortSignal.timeout(cfg.web.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      // Cap the download at 2× maxBytes of raw bytes; text is clipped after.
      const res = await safeFetch(url, {
        signal: combined,
        maxBytes: Math.max(cfg.web.maxBytes * 2, 131072),
        blockPrivate: cfg.web.blockPrivateHosts !== false,
        headers: {
          "user-agent": "pi-fairy-tales/0.2 (+pi coding agent)",
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
        },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const body = res.text;

      let text: string;
      if (params.mode === "raw") {
        text = body;
      } else if (contentType.includes("html") || /^\s*(<!doctype|<html)/i.test(body)) {
        text = htmlToText(body);
      } else {
        text = body;
      }

      return {
        content: [{ type: "text", text: clipHead(text, cfg.web.maxBytes, 2000) }],
        details: { url: res.finalUrl, status: res.status, contentType, bytes: body.length, capped: res.truncated },
      };
    },
  });
}

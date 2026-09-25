import TurndownService from "turndown";
import { isPaywalled, type RawPost } from "./substack/api.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
});

// Substack UI chrome that shows up inside body_html and is pure noise for a reader.
turndown.remove(["script", "style", "button", "form", "iframe", "svg"]);
turndown.addRule("substack-widgets", {
  filter: (node) => {
    const cls = (node as { className?: unknown }).className;
    return (
      typeof cls === "string" &&
      /\b(subscription-widget|subscribe-widget|button-wrapper|paywall|share-dialog|post-ufi|footnote-anchor-wrapper)/.test(cls)
    );
  },
  replacement: () => "",
});
// Images become a short placeholder: the model can't see them, but captions carry meaning.
turndown.addRule("images", {
  filter: "img",
  replacement: (_content, node) => {
    const alt = ((node as { getAttribute(n: string): string | null }).getAttribute("alt") ?? "").trim();
    return alt ? `[image: ${alt}]` : "";
  },
});
turndown.addRule("figcaption", {
  filter: "figcaption",
  replacement: (content) => (content.trim() ? `\n_${content.trim()}_\n` : ""),
});

export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(html)
    // Linked images with no alt text leave an empty link behind: "[\n\n](https://substackcdn...)".
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return htmlToMarkdown(html)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, "$1");
}

export type BodyFormat = "markdown" | "text" | "html";

export interface RenderedPost {
  header: string;
  body: string;
  /** True when Substack served a preview instead of the full post. */
  truncated: boolean;
}

export function renderPost(post: RawPost, format: BodyFormat): RenderedPost {
  const html = post.body_html ?? "";
  const body =
    format === "html" ? html : format === "text" ? htmlToText(html) : htmlToMarkdown(html);

  const truncated = isPaywalled(post.audience) && isPreview(html, post.wordcount);

  const authors = post.publishedBylines?.map((b) => b.name).filter(Boolean).join(", ");
  const lines = [
    `# ${post.title ?? "(untitled)"}`,
    post.subtitle ? `_${post.subtitle}_` : null,
    "",
    authors ? `- Author: ${authors}` : null,
    post.post_date ? `- Published: ${post.post_date}` : null,
    post.canonical_url ? `- URL: ${post.canonical_url}` : null,
    post.audience ? `- Audience: ${post.audience}` : null,
    post.wordcount ? `- Words: ${post.wordcount}` : null,
    truncated
      ? "- ⚠️ Only a preview was returned. Either you don't have a paid subscription to this publication, or your session wasn't accepted (run `substack-reader-mcp status` to check)."
      : null,
  ].filter((l): l is string => l !== null);

  return { header: lines.join("\n"), body, truncated };
}

/**
 * Substack doesn't say whether it served the full post or a preview. When the
 * viewer has access, the body contains a `paywall-jump` marker where the paywall
 * would be; previews stop right before it. Word count is the backup signal for
 * posts paywalled from the very top, which have no marker either way.
 */
function isPreview(html: string, wordcount?: number): boolean {
  const words = countWords(htmlToText(html));
  if (words === 0) return true;
  if (html.includes('class="paywall-jump"')) return false;
  return wordcount ? words < wordcount * 0.9 : true;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

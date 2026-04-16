import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { PageContent, PageLink } from "@/types";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

// ── Browser singleton ──
// Launching Chromium takes ~2s. Keep one browser alive and open pages per request.
let browserInstance: import("playwright").Browser | null = null;
let browserLaunching = false;
let browserLaunchQueue: Array<(b: import("playwright").Browser) => void> = [];

async function getBrowser(): Promise<import("playwright").Browser> {
  if (browserInstance?.isConnected()) return browserInstance;

  if (browserLaunching) {
    // Another request is already launching — queue up
    return new Promise((resolve) => browserLaunchQueue.push(resolve));
  }

  browserLaunching = true;
  try {
    const { chromium } = await import("playwright");
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // important in Docker/low-memory envs
        "--disable-gpu",
      ],
    });

    // Flush queue
    for (const resolve of browserLaunchQueue) resolve(browserInstance);
    browserLaunchQueue = [];

    return browserInstance;
  } finally {
    browserLaunching = false;
  }
}

/**
 * True if Playwright + Chromium binary is available.
 * Checks lazily so it doesn't slow startup.
 */
let _playwrightAvailable: boolean | null = null;
export async function hasPlaywright(): Promise<boolean> {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  try {
    const { chromium } = await import("playwright");
    const execPath = chromium.executablePath();
    const { existsSync } = await import("fs");
    _playwrightAvailable = existsSync(execPath);
  } catch {
    _playwrightAvailable = false;
  }
  return _playwrightAvailable;
}

/**
 * Fetch a page using Playwright (Chromium headless).
 * Handles JS-rendered SPAs that return empty HTML to plain fetch().
 * Falls back gracefully on timeout or crash.
 */
export async function fetchWithPlaywright(url: string): Promise<PageContent | null> {
  let context: import("playwright").BrowserContext | null = null;
  let page: import("playwright").Page | null = null;

  try {
    const browser = await getBrowser();

    // Isolated context per request (separate cookies, storage)
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      // Block ads/trackers/fonts to speed up page loads
      javaScriptEnabled: true,
    });

    // Block heavy resources we don't need
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    page = await context.newPage();

    // Navigate — domcontentloaded is reliable; networkidle can hang forever
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Give JS frameworks a moment to render (React, Vue, etc.)
    await page.waitForTimeout(2000);

    const html = await page.content();
    const title = await page.title().catch(() => "");

    await context.close();
    context = null;

    return parseHtmlToContent(url, html, title);
  } catch (error) {
    console.log(
      `[Playwright] Failed for ${url}:`,
      error instanceof Error ? error.message : "unknown"
    );
    // If browser crashed, clear the singleton so next call relaunches it
    if (error instanceof Error && error.message.includes("Target closed")) {
      browserInstance = null;
    }
    return null;
  } finally {
    // Always close context to free memory, even on error
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

/**
 * Parse raw HTML into PageContent using Readability + Turndown.
 * Identical logic to fetcher.ts's parseHtmlContent.
 */
function parseHtmlToContent(url: string, html: string, titleFallback: string): PageContent | null {
  try {
    const { document } = parseHTML(html);

    const links = extractLinks(url, document);

    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();

    let markdown: string;
    let title: string;

    if (article && article.content) {
      title = article.title || titleFallback;
      markdown = turndown.turndown(article.content);
    } else {
      title = titleFallback || (document.querySelector("title")?.textContent ?? "");
      const body = document.querySelector("body");
      markdown = body ? turndown.turndown(body.innerHTML) : "";
    }

    if (markdown.length < 50) return null;

    if (markdown.length > 15000) {
      markdown = markdown.slice(0, 15000) + "\n\n[Content truncated]";
    }

    return {
      url,
      title,
      markdown,
      links,
      fetchedAt: new Date(),
      fetchMethod: "playwright" as const,
    };
  } catch {
    return null;
  }
}

function extractLinks(
  baseUrl: string,
  document: ReturnType<typeof parseHTML>["document"]
): PageLink[] {
  const links: PageLink[] = [];
  const seenUrls = new Set<string>();

  for (const anchor of document.querySelectorAll("a[href]")) {
    try {
      const href = anchor.getAttribute("href");
      if (!href) continue;
      const absoluteUrl = new URL(href, baseUrl).toString();
      if (!absoluteUrl.startsWith("http")) continue;
      if (seenUrls.has(absoluteUrl)) continue;
      seenUrls.add(absoluteUrl);
      const text = (anchor.textContent || "").trim().slice(0, 200);
      if (!text) continue;
      links.push({ url: absoluteUrl, anchorText: text });
    } catch {
      // skip malformed URLs
    }
  }

  return links;
}

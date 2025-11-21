// crawl-collection.mjs
// Scrape one or more Solution Technologies collection URLs and send to n8n

import "dotenv/config";
import fs from "fs";
import { chromium } from "playwright";
import pLimit from "p-limit";

import { loginIfNeeded } from "./lib/login.mjs";
import { extractProduct } from "./lib/extract-product.mjs";
import { getProductLinksOnPage, getNextPageUrl } from "./lib/pagination.mjs";
import { postJsonWithRetry } from "./lib/fetch-retry.mjs";

const {
  SUPPLIER_BASE,
  DEALER_EMAIL,
  DEALER_PASSWORD,
  COLLECTION_URL,      // legacy single URL
  COLLECTION_URLS,     // comma-separated list of URLs
  N8N_WEBHOOK_URL,
  MAX_PAGES = "10",
  CONCURRENCY = "5",
  BATCH_SIZE = "50",
  DRY_RUN = "false",
} = process.env;

const startUrls = (COLLECTION_URLS || COLLECTION_URL || "")
  .split(",")
  .map(u => u.trim())
  .filter(Boolean);

if (!startUrls.length) {
  throw new Error("Missing env: COLLECTION_URL or COLLECTION_URLS");
}

if (!N8N_WEBHOOK_URL && DRY_RUN !== "true") {
  throw new Error("Missing env: N8N_WEBHOOK_URL");
}

const maxPages = parseInt(MAX_PAGES, 10);
const limit = pLimit(parseInt(CONCURRENCY, 10));
const batchSize = Math.max(1, parseInt(BATCH_SIZE, 10) || 50);

// ---------- helpers ----------

// make a stable key (sku preferred, else handle)
function makeKey(item) {
  const url = item.url || "";
  const handle = (url.match(/\/products\/([^/?#]+)/i) || [])[1] || "";
  return (item.sku || "").trim() || handle;
}

// dedupe by key (last write wins)
function dedupeByKey(items) {
  const m = new Map();
  for (const it of items) m.set(makeKey(it), it);
  return Array.from(m.values());
}

// chunk an array
function chunk(arr, n) {
  if (arr.length <= n) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Normalise vendor for Solution Technologies (Epson vs JK vs Dtech etc.)
function normaliseVendorForSolutiontech(prod) {
  const title = prod.title || "";
  const sku = prod.sku || "";
  let vendor = (prod.vendor || "").trim();

  const t = title.toLowerCase();
  const skuLow = sku.toLowerCase();

  const isJK =
    skuLow.startsWith("jk") ||
    t.startsWith("jk ");

  const isEpson =
    t.includes("epson") ||
    skuLow.startsWith("eh") ||
    skuLow.startsWith("eb") ||
    skuLow.startsWith("ls");

  // Dtech detection
  const isDtech =
    t.includes("dtech") ||
    skuLow.startsWith("dtuf") ||
    skuLow.startsWith("dtf");

  if (isJK) {
    vendor = "JK";
  } else if (isEpson) {
    vendor = "Epson";
  } else if (isDtech) {
    vendor = "Dtech";
  }

  return { ...prod, vendor };
}

// Scroll a bit in case anything lazy-loads on scroll
async function autoScrollCollection(page, { maxScrolls = 10, pauseMs = 800 } = {}) {
  let previousHeight = await page.evaluate(() => document.body.scrollHeight);

  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(pauseMs);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight <= previousHeight) break;
    previousHeight = newHeight;
  }
}

// Dtech / infinite-scroll style: find the hidden “Show more” button
async function getInfiniteScrollNextUrl(page) {
  const rel = await page.evaluate(() => {
    const btn = document.querySelector(".infinite-scrolling a.btn");
    if (!btn) return null;
    return btn.getAttribute("data-href") || btn.getAttribute("href");
  });

  if (!rel) return null;

  // Build absolute URL using SUPPLIER_BASE as origin
  try {
    const base = SUPPLIER_BASE || (await page.evaluate(() => location.origin));
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

// Dump HTML + screenshot for debugging (already working for you)
async function dumpDebug(page) {
  try {
    await page.screenshot({ path: "debug-page.png", fullPage: true });
    const html = await page.content();
    await fs.promises.writeFile("debug-page.html", html, "utf8");
    console.log("[debug] saved debug-page.html and debug-page.png");
  } catch (e) {
    console.warn("[debug] failed to save debug artifacts:", e.message);
  }
}

// Send per-collection batches to n8n
async function sendBatchesForCollection(items, collectionIndex, collectionUrl) {
  if (!items.length) {
    console.log(
      `[collection ${collectionIndex + 1}] no items to send, skipping webhook.`
    );
    return;
  }

  const deduped = dedupeByKey(items);
  console.log(
    `\n[collection ${collectionIndex + 1}] preparing to send ${deduped.length} items (${items.length} raw) for ${collectionUrl}`
  );

  if (DRY_RUN === "true") {
    console.log(
      `[DRY_RUN] Would POST ${deduped.length} items in batches of ${batchSize} for collection ${
        collectionIndex + 1
      } to ${N8N_WEBHOOK_URL || "(no URL)"}`
    );
    return;
  }

  const batches = chunk(deduped, batchSize);
  for (let i = 0; i < batches.length; i++) {
    const part = batches[i];
    const body = {
      source: "solutiontech",
      collectionIndex,
      collectionUrl,
      batchIndex: i,
      batchCount: batches.length,
      count: part.length,
      items: part,
    };
    console.log(
      `[collection ${collectionIndex + 1}] posting batch ${i + 1}/${
        batches.length
      } (${part.length} items) to N8N: ${N8N_WEBHOOK_URL}`
    );
    await postJsonWithRetry(N8N_WEBHOOK_URL, body, {
      retries: 5,
      baseDelayMs: 500,
    });
  }
}

// ---------- main ----------

async function main() {
  console.log(`[init] startUrls (${startUrls.length}):`);
  startUrls.forEach(u => console.log(`  - ${u}`));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await loginIfNeeded(page, {
    base: SUPPLIER_BASE,
    email: DEALER_EMAIL,
    password: DEALER_PASSWORD,
  });

  let totalPages = 0;
  let totalItems = 0;

  // global uniqueness across all collections
  const globalSeenKeys = new Set();

  for (let idx = 0; idx < startUrls.length; idx++) {
    const startUrl = startUrls[idx];
    console.log(`\n[set ${idx + 1}/${startUrls.length}] starting at ${startUrl}`);

    let url = startUrl;
    let pages = 0;
    const collectedForSet = [];

    while (url && pages < maxPages) {
      pages++;
      totalPages++;
      console.log(`[collection ${idx + 1}] page ${pages}: ${url}`);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      // Optional debug dump (already used once – keep commented in normal runs)
      // await dumpDebug(page);

      // Light scroll to trigger any lazy loading
      await autoScrollCollection(page);

      const links = await getProductLinksOnPage(page);
      console.log(
        `[collection ${idx + 1}] page ${pages}: found ${links.length} links`
      );

      // Scrape products concurrently for this collection
      await Promise.all(
        links.map(href =>
          limit(async () => {
            const p = await ctx.newPage();
            try {
              await p.goto(href, {
                waitUntil: "domcontentloaded",
                timeout: 120000,
              });
              const prodRaw = await extractProduct(p);
              const prod = normaliseVendorForSolutiontech(prodRaw);
              const full = {
                source: "solutiontech",
                crawledAt: new Date().toISOString(),
                collectionIndex: idx,
                collectionUrl: startUrl,
                ...prod,
              };

              const key = makeKey(full);
              if (globalSeenKeys.has(key)) {
                console.log(`  ◦ duplicate key, skipping: ${key}`);
              } else {
                globalSeenKeys.add(key);
                collectedForSet.push(full);
                totalItems++;
                console.log(`  ✔ scraped: ${prod.title}`);
              }
            } catch (e) {
              console.error(`  ✖ scrape failed ${href}:`, e.message);
              try {
                await p.screenshot({
                  path: `error-${Date.now()}.png`,
                  fullPage: true,
                });
              } catch {
                /* ignore */
              }
            } finally {
              await p.close();
            }
          })
        )
      );

      // ---------- NEXT PAGE LOGIC ----------

      // 1) Dtech style “infinite_scrolling” hidden button
      let nextUrl = await getInfiniteScrollNextUrl(page);

      // 2) Fallback to generic pagination helper for other collections
      if (!nextUrl) {
        nextUrl = await getNextPageUrl(page);
      }

      if (!nextUrl) {
        console.log(
          `[collection ${idx + 1}] no further page link found; stopping pagination.`
        );
        url = null;
      } else {
        url = nextUrl;
      }
    }

    console.log(
      `[collection ${idx + 1}] finished pagination. Pages: ${pages}, collected items: ${collectedForSet.length}`
    );

    await sendBatchesForCollection(collectedForSet, idx, startUrl);
  }

  console.log(
    `Done. Collections: ${startUrls.length}, Pages: ${totalPages}, Products scraped (unique keys): ${totalItems}`
  );
  await browser.close();
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(2);
});

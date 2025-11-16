import "dotenv/config";
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
  COLLECTION_URLS,     // NEW: comma-separated list of URLs
  N8N_WEBHOOK_URL,
  MAX_PAGES = "10",
  CONCURRENCY = "4",
  BATCH_SIZE = "50",         // how many items per webhook POST
  DRY_RUN = "false",         // if "true", skip POST and just log
} = process.env;

// Build the list of start URLs (supports COLLECTION_URLS or single COLLECTION_URL)
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

// util: make a stable key (sku preferred, else handle)
function makeKey(item) {
  const url = item.url || "";
  const handle = (url.match(/\/products\/([^/?#]+)/i) || [])[1] || "";
  return (item.sku || "").trim() || handle;
}

// util: dedupe by key (last write wins)
function dedupeByKey(items) {
  const m = new Map();
  for (const it of items) m.set(makeKey(it), it);
  return Array.from(m.values());
}

// util: chunk an array
function chunk(arr, n) {
  if (arr.length <= n) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

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

  const seenLinks = new Set();
  const collected = [];   // all products gathered this run
  let totalPages = 0;

  // Loop over each start URL (collection)
  for (let idx = 0; idx < startUrls.length; idx++) {
    const startUrl = startUrls[idx];
    console.log(`\n[set ${idx + 1}/${startUrls.length}] starting at ${startUrl}`);

    let url = startUrl;
    let pages = 0;

    while (url && pages < maxPages) {
      pages++;
      totalPages++;
      console.log(`[collection ${idx + 1}] page ${pages}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

      const links = (await getProductLinksOnPage(page)).filter(href => !seenLinks.has(href));
      console.log(`  handles on page (unique): ${links.length}`);
      links.forEach(href => seenLinks.add(href));
      console.log(`  found ${links.length} new product links`);

      // Scrape products concurrently (no posting here)
      await Promise.all(
        links.map(href =>
          limit(async () => {
            const p = await ctx.newPage();
            try {
              await p.goto(href, { waitUntil: "domcontentloaded", timeout: 120000 });
              const prod = await extractProduct(p);
              collected.push({
                source: "solutiontech",
                crawledAt: new Date().toISOString(),
                ...prod,
              });
              console.log(`  ✔ scraped: ${prod.title}`);
            } catch (e) {
              console.error(`  ✖ scrape failed ${href}:`, e.message);
              await p
                .screenshot({ path: `./failed_${Date.now()}.png`, fullPage: true })
                .catch(() => {});
            } finally {
              await p.close();
            }
          })
        )
      );

      url = await getNextPageUrl(page);
    }

    console.log(`[set ${idx + 1}] finished after ${pages} page(s).`);
  }

  // Dedupe and send in batches
  const deduped = dedupeByKey(collected);
  console.log(`\nCollected ${collected.length} items (${deduped.length} after dedupe) across ${totalPages} page(s).`);

  if (DRY_RUN === "true") {
    console.log(`[DRY_RUN] Would POST ${deduped.length} items in batches of ${batchSize} to ${N8N_WEBHOOK_URL || "(no URL)"}`);
  } else {
    const batches = chunk(deduped, batchSize);
    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    for (let i = 0; i < batches.length; i++) {
      const part = batches[i];
      const body = {
        batchId,
        index: i,
        totalBatches: batches.length,
        count: part.length,
        items: part,
      };
      console.log(
        `Posting batch ${i + 1}/${batches.length} (${part.length} items) to N8N: ${N8N_WEBHOOK_URL}`
      );
      await postJsonWithRetry(N8N_WEBHOOK_URL, body, {
        retries: 5,
        baseDelayMs: 500,
      });
    }
  }

  console.log(
    `Done. Collections: ${startUrls.length}, Pages: ${totalPages}, Products scraped: ${collected.length}, Posted: ${
      DRY_RUN === "true" ? 0 : deduped.length
    }`
  );
  await browser.close();
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(2);
});

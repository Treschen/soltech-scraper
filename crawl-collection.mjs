import "dotenv/config";
import { chromium } from "playwright";
import pLimit from "p-limit";

import { loginIfNeeded } from "./lib/login.mjs";
import { extractProduct } from "./lib/extract-product.mjs";
import { getProductLinksOnPage, getNextPageUrl } from "./lib/pagination.mjs";
import { postJsonWithRetry } from "./lib/fetch-retry.mjs";
import {
  buildCanonicalItem,       // op: "upsert", handle, sku, price:"123.45", quantity, etc.
} from "./lib/normalize.mjs";

const {
  SUPPLIER_BASE,
  DEALER_EMAIL,
  DEALER_PASSWORD,
  COLLECTION_URL,
  N8N_WEBHOOK_URL,
  MAX_PAGES = "10",
  CONCURRENCY = "4",
} = process.env;

if (!COLLECTION_URL) throw new Error("Missing env: COLLECTION_URL");
if (!N8N_WEBHOOK_URL) throw new Error("Missing env: N8N_WEBHOOK_URL");

const maxPages = parseInt(MAX_PAGES, 10);
const limit = pLimit(parseInt(CONCURRENCY, 10));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await loginIfNeeded(page, {
    base: SUPPLIER_BASE,
    email: DEALER_EMAIL,
    password: DEALER_PASSWORD,
  });

  let url = COLLECTION_URL;
  let pages = 0;
  let totalPushed = 0;
  const seen = new Set();

  while (url && pages < maxPages) {
    pages++;
    console.log(`[collection] page ${pages}: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    const links = (await getProductLinksOnPage(page)).filter(l => !seen.has(l));
    links.forEach(l => seen.add(l));
    console.log(`  found ${links.length} new product links`);

    // Scrape all links concurrently, then batch POST once per page
    const items = [];
    await Promise.all(
      links.map(href =>
        limit(async () => {
          const p = await ctx.newPage();
          try {
            await p.goto(href, { waitUntil: "domcontentloaded", timeout: 120000 });
            const raw = await extractProduct(p); // { title, vendor, sku, price(number), availability, images[], url, ... }
            const canonical = buildCanonicalItem(raw); // ensures price "123.45", quantity int, handle, sku…

            // sanity: require at least sku + price to include in batch
            if (canonical.sku && Number(canonical.price) > 0) {
              items.push(canonical);
              console.log(`    + ready: ${canonical.title || canonical.sku} @ ${canonical.price}`);
            } else {
              console.warn(`    ! skipped (missing sku/price): ${raw.title || raw.url}`);
            }
          } catch (e) {
            console.error(`    ✖ ${href}:`, e.message);
            await p.screenshot({ path: `./failed_${Date.now()}.png`, fullPage: true }).catch(() => {});
          } finally {
            await p.close();
          }
        })
      )
    );

    if (items.length) {
      const payload = {
        source: "solutiontech",
        batchId: `collection-${Date.now()}-p${pages}`,
        vendor: items[0]?.vendor || "Epson",
        items,
      };
      console.log(`  → Posting batch of ${items.length} items to n8n`);
      await postJsonWithRetry(N8N_WEBHOOK_URL, payload, { retries: 5, baseDelayMs: 500 });
      totalPushed += items.length;
    } else {
      console.log("  (no valid items on this page)");
    }

    url = await getNextPageUrl(page);
  }

  console.log(`Done. Pages: ${pages}, Items posted: ${totalPushed}`);
  await browser.close();
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(2);
});

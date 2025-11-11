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

  await loginIfNeeded(page, { base: SUPPLIER_BASE, email: DEALER_EMAIL, password: DEALER_PASSWORD });

  let url = COLLECTION_URL;
  let pages = 0;
  let pushed = 0;
  const seen = new Set();

  while (url && pages < maxPages) {
    pages++;
    console.log(`[collection] page ${pages}: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

    const links = (await getProductLinksOnPage(page)).filter(l => !seen.has(l));
    links.forEach(l => seen.add(l));
    console.log(`  found ${links.length} new product links`);

    await Promise.all(
      links.map(href =>
        limit(async () => {
          const p = await ctx.newPage();
          try {
            await p.goto(href, { waitUntil: "domcontentloaded", timeout: 120000 });
            const prod = await extractProduct(p);
            const payload = {
              source: "solutiontech",
              crawledAt: new Date().toISOString(),
              ...prod,
            };
            console.log("Posting to N8N:", process.env.N8N_WEBHOOK_URL);
            await postJsonWithRetry(process.env.N8N_WEBHOOK_URL, payload, { retries: 5, baseDelayMs: 500 });
            pushed++;
            console.log(`  ✔ posted: ${prod.title}`);
          } catch (e) {
            console.error(`  ✖ ${href}:`, e.message);
            await p.screenshot({ path: `./failed_${Date.now()}.png`, fullPage: true }).catch(()=>{});
          } finally {
            await p.close();
          }
        })
      )
    );

    url = await getNextPageUrl(page);
  }

  console.log(`Done. Pages: ${pages}, Products posted: ${pushed}`);
  await browser.close();
}

main().catch(e => { console.error("Fatal:", e); process.exit(2); });

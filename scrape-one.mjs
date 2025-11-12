import "dotenv/config";
import { chromium } from "playwright";

import { loginIfNeeded } from "./lib/login.mjs";
import { extractProduct } from "./lib/extract-product.mjs";
import { postJsonWithRetry } from "./lib/fetch-retry.mjs";
import { buildCanonicalItem } from "./lib/normalize.mjs";

const {
  SUPPLIER_BASE,
  DEALER_EMAIL,
  DEALER_PASSWORD,
  PRODUCT_URL,
  N8N_WEBHOOK_URL,
} = process.env;

if (!PRODUCT_URL) throw new Error("Missing env: PRODUCT_URL");
if (!N8N_WEBHOOK_URL) throw new Error("Missing env: N8N_WEBHOOK_URL");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1) Login (session persisted via .auth if you kept that in Docker)
  await loginIfNeeded(page, {
    base: SUPPLIER_BASE,
    email: DEALER_EMAIL,
    password: DEALER_PASSWORD,
  });

  // 2) Go to the target product
  console.log("[single] navigating:", PRODUCT_URL);
  await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

  // 3) Extract (uses DOM + product.js fallback) -> { title, vendor, sku, price(number), ... }
  const raw = await extractProduct(page);

  // 4) Canonicalize for Shopify upsert -> { sku, price:"123.45", quantity, handle, ... }
  const item = buildCanonicalItem(raw);

  // sanity checks
  if (!item.sku) throw new Error("Extracted product has no SKU (cannot upsert)");
  if (!(Number(item.price) > 0)) throw new Error("Extracted product price is zero/invalid");

  // 5) POST to n8n (send as a batch of one for consistency)
  const payload = {
    source: "solutiontech",
    batchId: `single-${Date.now()}`,
    vendor: item.vendor || "Epson",
    items: [item],
  };

  console.log("→ Posting to n8n:", process.env.N8N_WEBHOOK_URL);
  await postJsonWithRetry(N8N_WEBHOOK_URL, payload, { retries: 5, baseDelayMs: 500 });
  console.log("✔ posted:", item.title || item.sku, "@", item.price);

  await browser.close();
}

main().catch(async (e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(2);
});

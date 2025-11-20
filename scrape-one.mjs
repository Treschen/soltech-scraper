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
  DRY_RUN = "false",
} = process.env;

if (!SUPPLIER_BASE) throw new Error("Missing env SUPPLIER_BASE");
if (!DEALER_EMAIL) throw new Error("Missing env DEALER_EMAIL");
if (!DEALER_PASSWORD) throw new Error("Missing env DEALER_PASSWORD");
if (!PRODUCT_URL) throw new Error("Missing env PRODUCT_URL");
if (!N8N_WEBHOOK_URL && DRY_RUN !== "true") {
  throw new Error("Missing env N8N_WEBHOOK_URL");
}

// --- Vendor normaliser for Solution Technologies (Epson / JK / Dtech) ----
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

  const isDtech =
    t.includes("dtech") ||
    skuLow.startsWith("dtuf") || // e.g. DTUF303FIBUSBXX
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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1) Login
  await loginIfNeeded(page, {
    base: SUPPLIER_BASE,
    email: DEALER_EMAIL,
    password: DEALER_PASSWORD,
  });

  // 2) Go to the target product
  console.log("[single] navigating:", PRODUCT_URL);
  await page.goto(PRODUCT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  // 3) Extract raw product data from the page
  const raw = await extractProduct(page);

  // 4) Normalise vendor (JK / Epson / Dtech) and ensure URL present
  const enriched = normaliseVendorForSolutiontech({
    ...raw,
    url: raw.url || PRODUCT_URL,
  });

  // 5) Build canonical item for ingest
  const item = buildCanonicalItem(enriched);

  console.log("[single] canonical item:", JSON.stringify(item, null, 2));

  if (DRY_RUN === "true") {
    console.log("[DRY_RUN] Skipping POST to n8n.");
    await browser.close();
    return;
  }

  // 6) Wrap in payload and POST to n8n
  const payload = {
    source: "solutiontech",
    crawledAt: new Date().toISOString(),
    count: 1,
    items: [item],
  };

  console.log("→ Posting to n8n:", N8N_WEBHOOK_URL);
  await postJsonWithRetry(N8N_WEBHOOK_URL, payload, {
    retries: 5,
    baseDelayMs: 500,
  });
  console.log("✔ posted:", item.title || item.sku, "@", item.price);

  await browser.close();
}

main().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(2);
});

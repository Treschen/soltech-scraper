// crawl-collection.mjs
import "dotenv/config";
import { chromium } from "playwright";
import pLimit from "p-limit";
import { loginIfNeeded } from "./lib/login.mjs";
import { extractProduct } from "./lib/extract-product.mjs";
import {
  getProductLinksOnPage,
  getNextPageUrl,
} from "./lib/pagination.mjs";
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
  .map((u) => u.trim())
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

// ---------- util helpers ----------

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
    skuLow.startsWith("dtuf") || // e.g. DTUF303FIBUSBXX
    skuLow.startsWith("dtf");    // safety net for similar patterns

  if (isJK) {
    vendor = "JK";
  } else if (isEpson) {
    vendor = "Epson";
  } else if (isDtech) {
    vendor = "Dtech";
  }

  return { ...prod, vendor };
}

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

// ---------- collection loading helpers ----------

// For “Items per page: 24” style controls – set to max value
async function setItemsPerPageToMax(page) {
  try {
    const result = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      let target = null;

      for (const sel of selects) {
        let labelText = "";

        // direct label[for=id]
        if (sel.id) {
          const lbl = document.querySelector(`label[for="${sel.id}"]`);
          if (lbl) labelText += " " + (lbl.textContent || "");
        }

        // parent text often contains the label (e.g. "Items per page 24 ▼")
        if (sel.parentElement) {
          labelText += " " + (sel.parentElement.textContent || "");
        }

        // previous sibling might be a label span
        if (sel.previousElementSibling) {
          labelText += " " + (sel.previousElementSibling.textContent || "");
        }

        if (/items\s*per\s*page/i.test(labelText)) {
          target = sel;
          break;
        }
      }

      if (!target) {
        return { found: false };
      }

      const options = Array.from(target.options || []);
      if (!options.length) return { found: false };

      // take the last option as "max"
      const last = options[options.length - 1];
      target.value = last.value;
      target.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        found: true,
        value: last.value,
        text: last.textContent || "",
      };
    });

    if (!result || !result.found) {
      console.log("  [items-per-page] dropdown not found or has no options");
      return;
    }

    console.log(
      `  [items-per-page] set to max option value=${result.value} (${result.text.trim()})`
    );

    // wait for Ajax reload of product grid
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
  } catch (err) {
    console.log(
      "  [items-per-page] failed to change items-per-page dropdown:",
      err.message
    );
  }
}

// Fallback for true infinite scroll (if any collections use it)
async function autoScrollCollection(page, { maxScrolls = 15, pauseMs = 1200 } = {}) {
  try {
    let previousHeight = await page.evaluate(
      () => document.body.scrollHeight
    );

    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      await page.waitForTimeout(pauseMs);

      const newHeight = await page.evaluate(
        () => document.body.scrollHeight
      );

      if (newHeight <= previousHeight) {
        break;
      }

      previousHeight = newHeight;
    }
  } catch (err) {
    console.log(
      "  [scroll] autoScrollCollection error:",
      err.message
    );
  }
}

// ---------- main ----------

async function main() {
  console.log(`[init] startUrls (${startUrls.length}):`);
  startUrls.forEach((u) => console.log(`  - ${u}`));

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

  // track global uniqueness across ALL collections
  const globalSeenKeys = new Set();

  for (let idx = 0; idx < startUrls.length; idx++) {
    const startUrl = startUrls[idx];
    console.log(`\n[set ${idx + 1}/${startUrls.length}] starting at ${startUrl}`);

    let url = startUrl;
    let pages = 0;
    const collectedForSet = []; // items for this collection only

    while (url && pages < maxPages) {
      pages++;
      totalPages++;
      console.log(`[collection ${idx + 1}] page ${pages}: ${url}`);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      // First, try to bump "Items per page" to max (Dtech & similar)
      await setItemsPerPageToMax(page);

      // Then, scroll in case any collection uses infinite scroll
      await autoScrollCollection(page);

      const links = await getProductLinksOnPage(page);
      console.log(
        `[collection ${idx + 1}] page ${pages}: found ${links.length} links`
      );

      // Scrape products concurrently for this collection
      await Promise.all(
        links.map((href) =>
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
              await p
                .screenshot({
                  path: `error-${Date.now()}.png`,
                  fullPage: true,
                })
                .catch(() => {});
            } finally {
              await p.close();
            }
          })
        )
      );

      // next page for this collection (for classic ?page=2 pagination)
      const nextUrl = await getNextPageUrl(page);
      if (!nextUrl) {
        console.log(
          `[collection ${idx + 1}] no further page link found; stopping pagination.`
        );
      }
      url = nextUrl;
    }

    console.log(
      `[collection ${idx + 1}] finished pagination. Pages: ${pages}, collected items: ${collectedForSet.length}`
    );

    // send ONLY this collection's items as its own webhook run
    await sendBatchesForCollection(collectedForSet, idx, startUrl);
  }

  console.log(
    `Done. Collections: ${startUrls.length}, Pages: ${totalPages}, Products scraped (unique keys): ${totalItems}`
  );

  await browser.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});

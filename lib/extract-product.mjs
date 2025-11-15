
// lib/extract-product.mjs
import { parsePrice, modelFrom, canonicalHandle } from "./normalize.mjs";

/** try to get product JSON from Shopify's public endpoint */
async function fetchShopifyProductJson(page) {
  try {
    const url = new URL(page.url());
    const handle = canonicalHandle(url.href);
    if (!handle) return null;

    const apiUrl = `${url.origin}/products/${handle}.js`;
    // Run in page context to avoid CORS headaches
    const data = await page.evaluate(async (endpoint) => {
      try {
        const r = await fetch(endpoint, { credentials: "omit", cache: "no-store" });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }, apiUrl);

    return data || null;
  } catch {
    return null;
  }
}

export async function extractProduct(page) {
  const url = page.url();

  // --- TITLE (DOM) ---
  const title =
    (await page.locator("h1, .product__title, h1.product-title").first().textContent().catch(() => ""))?.trim() ||
    (await page.locator('[itemprop="name"]').first().textContent().catch(() => ""))?.trim() ||
    "";

  // --- VENDOR (DOM hint) ---
  const vendor =
    (await page.locator(".product-vendor, a.vendor, .product__vendor").first().textContent().catch(() => ""))?.trim() ||
    (await page.locator('[itemprop="brand"]').first().textContent().catch(() => ""))?.trim() ||
    "";

  // --- PRICE (meta/DOM first) ---
  let priceText =
    (await page.locator('[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    (await page.locator('meta[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    (await page.locator('[data-product-price], .price .money, .product__price, .price').first().textContent().catch(() => ""))?.trim() ||
    "";
  let price = parsePrice(priceText);

  // --- SKU (DOM) ---
  let sku =
    (await page.locator('[itemprop="sku"], .product-sku, .sku, .product__sku').first().textContent().catch(() => ""))?.trim() ||
    "";

  // --- AVAILABILITY (DOM hint) ---
  const availability =
    (await page.locator('[data-availability], .product-stock, .availability, link[itemprop="availability"]').first().textContent().catch(() => ""))?.trim() ||
    "InStock";

  // --- IMAGE (DOM) ---
  let image =
    (await page.locator('.product__media img, img[src*="/cdn/"], .product-gallery img').first().getAttribute("src").catch(() => null)) ||
    null;
  if (image && !/^https?:\/\//i.test(image)) {
    try { image = new URL(image, url).href; } catch { /* noop */ }
  }

  // If either sku or a nonzero price is missing, hit Shopify’s product.js
  if (!sku || !price) {
    const pj = await fetchShopifyProductJson(page);
    if (pj && pj.variants && pj.variants.length) {
      // choose first available variant, else the first
      const v = pj.variants.find(x => x.available) || pj.variants[0];
      if (v) {
        if (!sku && v.sku) sku = String(v.sku).trim();
        if (!price && typeof v.price === "number") price = v.price / 100; // cents → rands
      }
    }
    // Images from product.js if DOM failed
    if (!image && pj?.images?.length) image = pj.images[0];
  }

  // Final fallback for SKU from title pattern
  if (!sku) sku = modelFrom(title);

  // Optional description HTML
  const descriptionHtml =
    (await page.locator(".product__description, [itemprop='description'], .rte").first().innerHTML().catch(() => "")) || "";

  return {
    title,
    vendor,
    sku,                // likely populated now
    price,              // Number (in R), not cents
    currency: "ZAR",
    availability,
    images: image ? [image] : [],
    url,
    descriptionHtml,
  };
}

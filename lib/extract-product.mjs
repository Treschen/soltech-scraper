// lib/extract-product.mjs
import { parsePrice, modelFrom } from "./normalize.mjs";

/**
 * Extract a single product from the current Playwright page.
 * Returns a minimal, clean object with guaranteed `sku` and numeric `price`.
 */
export async function extractProduct(page) {
  const url = page.url();

  // Title
  const title =
    (await page.locator("h1, .product__title, h1.product-title").first().textContent().catch(() => ""))?.trim() ||
    (await page.locator('[itemprop="name"]').first().textContent().catch(() => ""))?.trim() ||
    "";

  // Vendor (optional but useful)
  const vendor =
    (await page.locator(".product-vendor, a.vendor, .product__vendor").first().textContent().catch(() => ""))?.trim() ||
    (await page.locator('[itemprop="brand"]').first().textContent().catch(() => ""))?.trim() ||
    "";

  // SKU (try explicit selectors; fallback to model parsed from title)
  let sku =
    (await page.locator('[itemprop="sku"], .product-sku, .sku, .product__sku').first().textContent().catch(() => ""))?.trim() ||
    "";
  if (!sku) sku = modelFrom(title); // last resort

  // Price (prefer numeric attributes; else parse visible text)
  // Try meta/ld-json first (fast win if present)
  let priceText =
    (await page.locator('[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    (await page.locator('meta[itemprop="price"]').first().getAttribute("content").catch(() => null)) ||
    null;

  if (!priceText) {
    priceText =
      (await page.locator('[data-product-price], .price .money, .product__price, .price').first().textContent().catch(() => ""))?.trim() ||
      "";
  }

  const price = parsePrice(priceText);

  // Availability → simple text (we’ll convert to quantity later)
  const availability =
    (await page.locator('[data-availability], .product-stock, .availability, link[itemprop="availability"]').first().textContent().catch(() => ""))?.trim() ||
    "InStock";

  // First product image (absolute URL)
  let image =
    (await page.locator('.product__media img, img[src*="/cdn/"], .product-gallery img').first().getAttribute("src").catch(() => null)) ||
    null;
  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, url).href;
    } catch {
      // ignore if URL parsing fails
    }
  }

  // Optional HTML description
  const descriptionHtml =
    (await page.locator(".product__description, [itemprop='description'], .rte").first().innerHTML().catch(() => "")) || "";

  return {
    title,
    vendor,
    sku,          // guaranteed non-empty if modelFrom(title) worked
    price,        // Number (e.g., 43172)
    currency: "ZAR",
    availability,
    images: image ? [image] : [],
    url,
    descriptionHtml,
  };
}

/**
 * lib/normalize.mjs
 * Tiny helpers to standardise values for your scraper → n8n → Shopify flow.
 * No external deps. ESM-ready.
 */

/** Parse price from numbers or strings like:
 *  "43172", "R 43 172.00", "45,078.94", "45078,94", "R43 172" (NBSP)
 *  Returns a Number (not string). Use toMoneyString() when posting to Shopify.
 */
export function parsePrice(x) {
  if (x == null) return 0;
  if (typeof x === "number" && Number.isFinite(x)) return x;

  let s = String(x).trim();
  if (!s) return 0;

  // Strip currency symbols and spaces (incl. non-breaking space)
  s = s.replace(/[R$\s\u00A0]/g, "");

  // If both comma and dot present, assume comma = thousands
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    // If only comma present, treat it as decimal separator
    s = s.replace(",", ".");
  }

  // Keep only digits and '.' (single decimal point case handled by parseFloat)
  s = s.replace(/[^0-9.]/g, "");

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Ensure Shopify-friendly money string with 2 decimals, e.g. "43172.00" */
export function toMoneyString(n) {
  const num = typeof n === "number" ? n : parsePrice(n);
  return Number(num || 0).toFixed(2);
}

/** Extract a sensible model token from a title/SKU (e.g., EHLS11000W, LS12000B, TW7000) */
export function modelFrom(titleOrSku = "") {
  const U = String(titleOrSku).toUpperCase();

  const m =
    U.match(/\b(EHLS\d{4,5}[A-Z]?)\b/) ||
    U.match(/\b(LS\d{4,5}[A-Z]?)\b/)   ||
    U.match(/\b(EHTW\d{4}[A-Z]?)\b/)   ||
    U.match(/\b(TW\d{4}[A-Z]?)\b/)     ||
    U.match(/\b([A-Z]{2,6}\d{4,5}[A-Z]?)\b/);

  return m ? m[1] : "";
}

/** Map supplier availability text → coarse quantity (tweak as you like) */
export function stockFromAvailability(avail = "") {
  const a = String(avail).toLowerCase();
  if (a.includes("out")) return 0;
  if (a.includes("pre")) return 0;
  if (a.includes("low")) return 5;
  if (a.includes("in")) return 100;
  return 0;
}

/** Normalise SKU for matching (remove non-alnum, uppercase) */
export function normalizeSku(sku = "") {
  return String(sku).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Normalise titles for fuzzy matching if ever needed */
export function normalizeTitle(s = "") {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Extract Shopify handle from a product URL (or return "") */
export function canonicalHandle(url = "") {
  try {
    const m = String(url).match(/\/products\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Build a Shopify-ready variant payload from raw fields */
export function buildShopifyVariant({ sku, price, compareAtPrice, taxable = true, requiresShipping = true, inventory_management = "shopify", barcode } = {}) {
  return {
    sku: sku || "",
    price: toMoneyString(price),
    ...(compareAtPrice != null ? { compare_at_price: toMoneyString(compareAtPrice) } : {}),
    taxable: Boolean(taxable),
    requires_shipping: Boolean(requiresShipping),
    inventory_management,
    ...(barcode ? { barcode } : {})
  };
}

/** Create a canonical payload your scraper can POST to n8n for upsert flows */
export function buildCanonicalItem({ vendor, title, url, sku, price, currency = "ZAR", availability, images = [], stockQuantity } = {}) {
  return {
    op: "upsert",
    vendor: (vendor || "").trim(),
    handle: canonicalHandle(url),
    title: title || "",
    sku: sku || modelFrom(title || ""),
    price: toMoneyString(price),
    currency,
    quantity: typeof stockQuantity === "number" ? stockQuantity : stockFromAvailability(availability),
    availability: availability || "",
    images,
    source_url: url || ""
  };
}

export async function extractProduct(page) {
  const url = page.url();

  // Prefer JSON-LD
  const blocks = await page.$$eval('script[type="application/ld+json"]', ns =>
    ns.map(n => { try { return JSON.parse(n.textContent || "{}"); } catch { return null; } }).filter(Boolean)
  );

  const pick = (obj, path, d) => path.split(".").reduce((o,k)=>o?.[k], obj) ?? d;
  let title, sku, price, currency, availability, images;

  for (const b of blocks.flat()) {
    if (!b) continue;
    const p = b["@type"] === "Product" ? b : (b["@graph"] || []).find(x => x["@type"] === "Product");
    if (p) {
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      title = p.name || title;
      sku = p.sku || p.mpn || sku;
      price = offer ? parseFloat(offer.price) : price;
      currency = offer?.priceCurrency || currency;
      availability = pick(offer || {}, "availability", "").split("/").pop() || availability;
      images = Array.isArray(p.image) ? p.image : (p.image ? [p.image] : images);
      break;
    }
  }

  // DOM fallbacks
  if (!title) title = (await page.locator("h1").first().textContent().catch(()=>null))?.trim() || "";
  if (!price) {
    const txt = await page.locator('[itemprop="price"], .price, .product__price').first().textContent().catch(()=>null);
    price = txt ? parseFloat(txt.replace(/[^\d.,]/g,"").replace(",", "")) : null;
  }

  const vendor = await page.locator(".product-vendor,[data-vendor],[itemprop='brand']").first().textContent().catch(()=>null) || "";
  const descriptionHtml = await page.locator("[itemprop='description'], .product__description, [data-product-description]").first().innerHTML().catch(()=>undefined);

  return { url, title, sku, price, currency: currency || "ZAR", availability: availability || "", vendor, images: images || [], descriptionHtml: descriptionHtml || "" };
}

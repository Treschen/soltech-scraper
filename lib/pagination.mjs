// lib/pagination.mjs
// Handles:
// 1) Extracting product links on a collection page
// 2) Clicking "items per page" to max (50) when available
// 3) Finding next page URL, including hidden infinite-scroll data-href

export async function getProductLinksOnPage(page) {
  // Wait a bit for product grid to be present
  await page.waitForTimeout(500);

  // Collect anchors that look like product tiles
  const hrefs = await page.$$eval(
    [
      'a.product-grid-image[href*="/products/"]',
      'a.product-item[href*="/products/"]',
      '.product-item a[href*="/products/"]',
      'a[href*="/products/"]'
    ].join(","),
    as => as.map(a => a.href)
  ).catch(() => []);

  // Dedupe + sanitize
  return Array.from(new Set(hrefs.map(h => h.trim()).filter(Boolean)));
}

export async function setItemsPerPageToMax(page) {
  // Theme markup from debug-page.html:
  // div.filters-toolbar__limited-view .label-tab opens ul.dropdown-menu span[data-value]
  const labelTab = page.locator('.filters-toolbar__limited-view .label-tab').first();
  const maxOption = page.locator(
    '.filters-toolbar__limited-view ul.dropdown-menu span[data-value]'
  );

  const hasDropdown = await labelTab.isVisible().catch(() => false);
  if (!hasDropdown) {
    console.log("  [items-per-page] dropdown not found or not visible");
    return;
  }

  // Find max numeric option (usually 50)
  const values = await maxOption.evaluateAll(els =>
    els.map(e => parseInt(e.getAttribute("data-value") || "0", 10)).filter(n => n > 0)
  ).catch(() => []);

  if (!values.length) {
    console.log("  [items-per-page] dropdown not found or has no options");
    return;
  }

  const maxVal = Math.max(...values);

  // Open dropdown
  await labelTab.click().catch(() => {});
  await page.waitForTimeout(300);

  // Click max option
  const opt = page.locator(
    `.filters-toolbar__limited-view ul.dropdown-menu span[data-value="${maxVal}"]`
  ).first();

  if (await opt.isVisible().catch(() => false)) {
    console.log(`  [items-per-page] setting to ${maxVal}`);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      opt.click().catch(() => {}),
    ]);

    // Give the theme time to re-render products
    await page.waitForTimeout(1200);
  } else {
    console.log("  [items-per-page] max option not clickable");
  }
}

export async function getNextPageUrl(page) {
  // 1) Standard Shopify rel="next"
  const relNext = page.locator('a[rel="next"]').first();
  if (await relNext.isVisible().catch(() => false)) {
    const href = await relNext.getAttribute("href").catch(() => null);
    if (href) return new URL(href, page.url()).toString();
  }

  // 2) Classic pagination "next" button
  const classicNext = page.locator(
    [
      '.pagination a[title*="Next"]',
      '.pagination a.next',
      'a.pagination__next',
      'a:has-text("Next")'
    ].join(",")
  ).first();

  if (await classicNext.isVisible().catch(() => false)) {
    const href = await classicNext.getAttribute("href").catch(() => null);
    if (href) return new URL(href, page.url()).toString();
  }

  // 3) Hidden infinite-scroll "Show more" data-href
  // Present even when parent has class "hide"
  const infiniteBtn = page.locator('.infinite-scrolling a.btn[data-href]').first();
  const dataHref = await infiniteBtn.getAttribute("data-href").catch(() => null);

  if (dataHref) {
    const nextUrl = new URL(dataHref, page.url()).toString();
    return nextUrl;
  }

  return null;
}

export async function getProductLinksOnPage(page) {
  const hrefs = await page.$$eval('a[href*="/products/"]', as =>
    Array.from(new Set(as.map(a => a.href)))
  );
  return hrefs;
}

export async function getNextPageUrl(page) {
  return await page.evaluate(() => {
    const relNext = document.querySelector('a[rel="next"]');
    if (relNext?.href) return relNext.href;
    const nextNum = document.querySelector(".pagination .active + li a");
    if (nextNum?.href) return nextNum.href;
    const btn = [...document.querySelectorAll("a")].find(a => /next/i.test(a.textContent || ""));
    return btn?.href || null;
  });
}

// lib/pagination.mjs
export async function getProductLinksOnPage(page) {
  // Return ONE canonical product URL per handle, ignoring ?variant=... etc.
  const { origin } = new URL(page.url());

  const handles = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/products/"]'));
    const toHandle = (href) => {
      try {
        // Absolute or relative
        const u = new URL(href, location.origin);
        // ignore non-product actions (cart/add, etc.)
        if (!/\/products\//i.test(u.pathname)) return null;
        const m = u.pathname.match(/\/products\/([^/?#]+)/i);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    };
    const hs = new Set();
    for (const a of anchors) {
      const h = toHandle(a.getAttribute("href") || "");
      if (h) hs.add(h);
    }
    return Array.from(hs);
  });

  // Build canonical URLs (no query/fragment)
  return handles.map(h => `${origin}/products/${h}`);
}

export async function getNextPageUrl(page) {
  // Prefer rel=next; fallbacks for theme paginators
  return await page.evaluate(() => {
    const absHref = (el) => {
      try { return new URL((el.getAttribute("href") || "").trim(), location.origin).href; } catch { return null; }
    };

    // 1) rel="next"
    const relNext = document.querySelector('a[rel="next"]');
    if (relNext) {
      const href = absHref(relNext);
      if (href) return href;
    }

    // 2) numeric paginator: .pagination .active + li a
    const nextNum = document.querySelector(".pagination .active + li a, .pagination__item--current + a");
    if (nextNum) {
      const href = absHref(nextNum);
      if (href) return href;
    }

    // 3) button/link text that looks like "Next"
    const nextText = Array.from(document.querySelectorAll("a,button"))
      .find(el => /next/i.test(el.textContent || ""));
    if (nextText) {
      const href = absHref(nextText);
      if (href) return href;
    }

    return null;
  });
}

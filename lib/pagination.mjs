// lib/pagination.mjs
export async function getProductLinksOnPage(page) {
  // Return ONE canonical product URL per handle, ignoring ?variant=... etc.
  const { origin } = new URL(page.url());

  const handles = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/products/"]'));
    const toHandle = (href) => {
      try {
        const u = new URL(href, location.origin); // absolute or relative
        if (!/\/products\//i.test(u.pathname)) return null; // ignore cart/add etc.
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
  return handles.map((h) => `${origin}/products/${h}`);
}

export async function getNextPageUrl(page) {
  return await page.evaluate(() => {
    const absHref = (el) => {
      try {
        const raw = (el.getAttribute("href") || "").trim();
        if (!raw) return null;
        return new URL(raw, location.origin).href;
      } catch {
        return null;
      }
    };

    // 1) rel="next" (most reliable)
    const relNext = document.querySelector('a[rel="next"]');
    if (relNext) {
      const href = absHref(relNext);
      if (href) return href;
    }

    // 2) classic ".pagination .active + li a" (Bootstrap-style)
    const activeLiNext = document.querySelector(".pagination .active + li a");
    if (activeLiNext) {
      const href = absHref(activeLiNext);
      if (href) return href;
    }

    // 3) Shopify 2.0 style: ".pagination__item--current" as <a> or <li>
    const current = document.querySelector(".pagination__item--current");
    if (current) {
      // If it's inside an <li>, move to that LI
      const li = current.closest("li") || current;
      let sib = li.nextElementSibling;
      while (sib) {
        const a = sib.querySelector("a[href]");
        if (a) {
          const href = absHref(a);
          if (href) return href;
        }
        sib = sib.nextElementSibling;
      }
    }

    // 4) Generic "Next" link/button anywhere on the page
    const nextTextEl = Array.from(document.querySelectorAll("a,button"))
      .find((el) => /^(next|›|»)$/i.test((el.textContent || "").trim()) ||
                    /next/i.test((el.textContent || "").trim()));
    if (nextTextEl) {
      const href = absHref(nextTextEl);
      if (href) return href;
    }

    // No further pages
    return null;
  });
}

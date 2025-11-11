import { chromium } from 'playwright';

const {
  SUPPLIER_BASE,
  DEALER_EMAIL,
  DEALER_PASSWORD,
  PRODUCT_URL,
  N8N_WEBHOOK_URL
} = process.env;

if (!SUPPLIER_BASE || !DEALER_EMAIL || !DEALER_PASSWORD || !PRODUCT_URL) {
  console.error("Missing required environment variables.");
  process.exit(2);
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const extractHandle = url => (url.match(/\/products\/([^/?#]+)/i) || [])[1] || "";

// ------- LOGIN (XHR-based, no full navigation expected) -------
async function login(page) {
  await page.goto(`${SUPPLIER_BASE}/account/login`, { waitUntil: 'load' });

  // Dismiss cookie banner if present (non-fatal)
  await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('button:has-text("I Accept")').first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('[data-accept-cookies], .accept-cookies').first().click({ timeout: 2000 }).catch(() => {});

  // Scope to the login form and fill
  const form = page.locator('form[action*="/account/login"]').first();
  await form.locator('#customer_email, input[name="customer[email]"]').first().fill(DEALER_EMAIL, { timeout: 15000 });
  await form.locator('#customer_password, input[name="customer[password]"]').first().fill(DEALER_PASSWORD, { timeout: 15000 });

  // Submit (XHR likely, not a full navigation)
  const submit = form.locator('button[type="submit"], button[name="commit"], input[type="submit"]').first();
  await submit.click();

  // Wait for any success signal (no hard navigation)
  const loggedIn = await Promise.race([
    page.waitForSelector('a[href*="/account/logout"], form[action*="/account/logout"], .customer-logout', { timeout: 10000 }).then(() => true).catch(() => false),
    page.waitForURL(u => !u.includes('/account/login'), { timeout: 10000 }).then(() => true).catch(() => false),
    page.waitForResponse(r => r.url().includes('/account') && r.status() === 200, { timeout: 10000 }).then(() => true).catch(() => false),
  ]);

  // Even if we didn’t detect a signal, proceed; the product fetch will prove auth
  if (!loggedIn) {
    await page.waitForTimeout(600);
  }
}

async function fetchProductJsonInSession(page, handle) {
  try {
    return await page.evaluate(async h => {
      const r = await fetch(`/products/${h}.js`, { credentials: 'include' });
      if (!r.ok) return null;
      return await r.json();
    }, handle);
  } catch {
    return null;
  }
}

function parseVariantsFromHtml(html) {
  const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
  let ldj = null;
  try { ldj = ld ? JSON.parse(ld) : null; } catch {}

  const productJson =
    (html.match(/id="ProductJson[^"]*"[^>]*>([\s\S]*?)<\/script>/) || [])[1] ||
    (html.match(/var\s+product\s*=\s*({[\s\S]*?});/) || [])[1] ||
    (html.match(/window\.__NEXT_DATA__\s*=\s*({[\s\S]*?});/) || [])[1];

  let product = null;
  try { product = productJson ? JSON.parse(productJson) : null; } catch {}

  const invQtyMatch = html.match(/"inventory_quantity"\s*:\s*(-?\d+)/i);
  const inventoryQuantityFromHtml = invQtyMatch ? Number(invQtyMatch[1]) : undefined;

  const out = { title: product?.title || ldj?.name || '', variants: [] };

  if (product?.variants?.length) {
    for (const v of product.variants) {
      out.variants.push({
        sku: v.sku || '',
        variant_title: v.title || '',
        price: String(v.price ?? v.priceV2?.amount ?? ''),
        compare_at: String(v.compare_at_price ?? v.compareAtPriceV2?.amount ?? ''),
        available: (typeof v.available === 'boolean') ? v.available :
                   (typeof v.inventory_quantity === 'number') ? v.inventory_quantity > 0 :
                   (typeof inventoryQuantityFromHtml === 'number') ? inventoryQuantityFromHtml > 0 : undefined,
        stock: (typeof v.inventory_quantity === 'number') ? v.inventory_quantity : inventoryQuantityFromHtml
      });
    }
  } else if (ldj?.offers) {
    const offers = Array.isArray(ldj.offers) ? ldj.offers : [ldj.offers];
    for (const o of offers) {
      out.variants.push({
        sku: o.sku || '',
        variant_title: o.name || '',
        price: String(o.price || ''),
        compare_at: '',
        available: !!(o.availability && /InStock/i.test(o.availability)),
        stock: undefined
      });
    }
  }
  return out;
}

async function scrapeOne() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await login(page);

  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded' });
  const handle = extractHandle(PRODUCT_URL);

  let result = {
    source: SUPPLIER_BASE,
    product_url: PRODUCT_URL,
    handle,
    title: '',
    variants: []
  };

  if (handle) {
    const jsPayload = await fetchProductJsonInSession(page, handle);
    if (jsPayload?.variants?.length) {
      result.title = jsPayload.title || '';
      result.variants = jsPayload.variants.map(v => ({
        sku: v.sku || '',
        variant_title: v.title || '',
        price: String(v.price ?? ''),
        compare_at: String(v.compare_at_price ?? ''),
        available: typeof v.available === 'boolean' ? v.available : undefined,
        stock: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : undefined
      }));
    }
  }

  if (!result.variants.length || result.variants.some(v => v.price === '' || v.available === undefined)) {
    const html = await page.content();
    const parsed = parseVariantsFromHtml(html);
    if (parsed.title && !result.title) result.title = parsed.title;

    const bySku = new Map(result.variants.filter(v => v.sku).map(v => [v.sku, v]));
    for (const v of parsed.variants) {
      if (v.sku && bySku.has(v.sku)) {
        const tgt = bySku.get(v.sku);
        tgt.price = tgt.price || v.price;
        tgt.compare_at = tgt.compare_at || v.compare_at;
        if (tgt.available === undefined) tgt.available = v.available;
        if (tgt.stock === undefined) tgt.stock = v.stock;
      } else {
        result.variants.push(v);
      }
    }
  }

  // after you build `result.variants`
  for (const v of result.variants) {
    const s = String(v.price || '').trim();
    const asNumber = /^\d+$/.test(s) ? Number(s) / 100 : Number(s.replace(/[^0-9.]/g,''));
    v.price_rands = Number.isFinite(asNumber) ? asNumber.toFixed(2) : '';
  }

  await browser.close();

  if (N8N_WEBHOOK_URL) {
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    });
    if (!res.ok) throw new Error(`Webhook push failed: ${res.status} ${await res.text()}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

scrapeOne().catch(e => { console.error(e); process.exit(1); });

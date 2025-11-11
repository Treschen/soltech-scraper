export async function loginIfNeeded(page, { base, email, password }) {
  // Skip if creds not provided
  if (!base || !email || !password) return;

  // Go to login
  await page.goto(`${base}/account/login`, { waitUntil: "domcontentloaded" });

  // Best-effort cookie banners
  await page.getByRole("button", { name: /accept|agree|ok/i }).first().click().catch(() => {});
  await page.locator('button:has-text("Accept")').first().click().catch(() => {});
  await page.locator('button:has-text("I Accept")').first().click().catch(() => {});

  // If already logged in, Shopify often redirects to /account
  if (/\/account($|\/)/.test(page.url())) {
    // Might already be authenticated
    const logout = await page.locator('a[href*="/account/logout"]').first().isVisible().catch(() => false);
    if (logout) return;
  }

  // Scope to the actual login form (avoid recover/forgot forms)
  const form = page.locator('form[action*="/account/login"]').first();

  const emailInput = form.locator(
    'input[name="customer[email]"], #CustomerEmail, #customer_email, input[type="email"]'
  ).first();

  const passInput = form.locator(
    'input[name="customer[password]"], #CustomerPassword, #customer_password, input[type="password"]'
  ).first();

  // Fill within the form scope to avoid strict-mode collisions
  await emailInput.fill(email, { timeout: 15000 });
  await passInput.fill(password, { timeout: 15000 });

  // Click submit (works across most Shopify themes)
  const submitBtn = form.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click({ timeout: 15000 }).catch(async () => {
    // Fallback to common button labels
    await form.getByRole("button", { name: /log ?in|sign ?in/i }).first().click();
  });

  // Wait for either success (account page) or a logged-in indicator
  await page.waitForLoadState("networkidle");
  // Success heuristics: landed on account page or logout exists
  const onAccount = /\/account($|\/)/.test(page.url());
  const hasLogout = await page.locator('a[href*="/account/logout"]').first().isVisible().catch(() => false);

  if (!onAccount && !hasLogout) {
    // Some themes stay on same URL but hide form on success; give it one more check
    const formVisible = await form.isVisible().catch(() => false);
    if (formVisible) {
      throw new Error("Login failed: still seeing login form after submit.");
    }
  }
}

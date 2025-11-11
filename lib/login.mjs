export async function loginIfNeeded(page, { base, email, password }) {
  if (!base || !email || !password) return; // skip if not required
  await page.goto(`${base}/account/login`, { waitUntil: "load" });
  await page.getByRole("button", { name: /accept/i }).first().click().catch(()=>{});
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForLoadState("networkidle");
}

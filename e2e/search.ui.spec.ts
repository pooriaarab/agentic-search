import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const SHOTS = "docs/screenshots";
const THEMES = ["light", "dark"] as const;

/** Check the page against WCAG 2.2 AA in both themes, and keep a screenshot of each. */
async function audit(page: Page, name: string) {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `${name} (${theme})`).toEqual([]);
    // Set SHOTS=1 to refresh the committed screenshots.
    if (process.env.SHOTS === "1") await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
  }
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
}

const field = (page: Page) => page.getByRole("combobox", { name: "Search" });

test("the / key focuses the field, and so does Ctrl+K", async ({ page }) => {
  await page.goto("/");
  await expect(field(page)).not.toBeFocused();
  await page.keyboard.press("/");
  await expect(field(page)).toBeFocused();
  // A slash typed in the field is text, not the shortcut.
  await page.keyboard.type("a/b");
  await expect(field(page)).toHaveValue("a/b");
  await page.getByRole("heading", { level: 1 }).click();
  await expect(field(page)).not.toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(field(page)).toBeFocused();
  await audit(page, "1-start");
});

test("results are grouped by kind, and the arrow keys and Enter pick one", async ({ page }) => {
  await page.goto("/");
  const searches: unknown[] = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/v1/search") && searches.push(r.postDataJSON()));
  await field(page).click();
  // Typing fast sends one call, for the last text, after the pause.
  await field(page).pressSequentially("budg", { delay: 20 });
  const list = page.getByRole("listbox", { name: "Search" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("group")).toHaveCount(9);
  // The groups come in a fixed order.
  expect(await list.locator(".agd-search__group-title").allTextContents()).toEqual(["Documents", "Sheets", "Slides", "Tables", "Tasks", "Forms", "Boards", "Files", "Comments"]);
  await expect(page.getByRole("status").filter({ hasText: "results" })).toBeVisible();
  expect(searches).toEqual([expect.objectContaining({ query: "budg" })]);
  await audit(page, "2-results");

  await page.keyboard.press("ArrowDown");
  const first = list.getByRole("option").first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!);
  await page.keyboard.press("ArrowUp");
  await expect(list.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/^You picked .*, a (document|sheet|slide|table|task|form|board|file|comment)\.$/)).toBeVisible();
  await expect(list).toBeHidden();
  // Focus stays in the field.
  await expect(field(page)).toBeFocused();
});

test("a click picks a result, and Escape closes and then clears", async ({ page }) => {
  await page.goto("/");
  await field(page).fill("launch");
  await page.getByRole("option", { name: /Launch plan/ }).first().click();
  await expect(page.getByText("You picked Launch plan, a document.")).toBeVisible();
  // Clicking the field again opens the panel again.
  await field(page).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(field(page)).toHaveValue("launch");
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
});

test("no match shows an empty state", async ({ page }) => {
  await page.goto("/");
  await field(page).fill("zzzzqqq");
  await expect(page.getByRole("heading", { name: "No results" })).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await audit(page, "3-empty");
});

test("a failed call shows an error, not an empty result, and Try again recovers", async ({ page }) => {
  let fail = true;
  await page.route("**/api/v1/search", (route) =>
    fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"internal error"}' }) : route.continue(),
  );
  await page.goto("/");
  await field(page).fill("budget");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The search failed");
  await expect(page.getByRole("heading", { name: "No results" })).toHaveCount(0);
  await audit(page, "4-error");
  fail = false;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(alert).toBeHidden();
});

test("a slow older answer never replaces a newer one", async ({ page }) => {
  await page.route("**/api/v1/search", async (route) => {
    if (route.request().postDataJSON().query === "slide") await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.goto("/");
  await field(page).fill("slide");
  await page.waitForTimeout(300);
  await field(page).fill("logo");
  await expect(page.getByRole("option", { name: /logo-launch/ })).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByRole("option", { name: /logo-launch/ })).toBeVisible();
  await expect(page.getByRole("group")).toHaveCount(1);
});

test("the page works at 390px with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await field(page).fill("budget");
  await expect(page.getByRole("listbox")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await audit(page, "5-mobile");
});

test("the demo API is read-only", async ({ request }) => {
  expect((await request.post("/api/v1/items", { data: { items: [] } })).status()).toBe(404);
  expect((await request.delete("/api/v1/owners/demo")).status()).toBe(404);
  expect((await request.get("/api/v1/owners/demo/export")).status()).toBe(404);
});

test("new suite kinds appear as selectable result groups", async ({ page }) => {
  await page.goto("/");
  await field(page).fill("budget");
  const list = page.getByRole("listbox", { name: "Search" });
  await expect(list.getByRole("group")).toHaveCount(9);
  expect(await list.locator(".agd-search__group-title").allTextContents()).toEqual(["Documents", "Sheets", "Slides", "Tables", "Tasks", "Forms", "Boards", "Files", "Comments"]);
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
});

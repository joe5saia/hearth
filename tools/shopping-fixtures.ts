import assert from "node:assert/strict";
import { Schema } from "effect";
import { HouseholdSchema, type Household } from "../src/domain.ts";

/**
 * Shopping lists and rows comparable across a smoke's restore: list revisions rotate, and rows the restore
 * re-adds get new addedAt/checkedAt timestamps that the public API cannot set.
 */
export const shoppingContent = (state: Pick<typeof HouseholdSchema.Encoded, "shoppingLists" | "shoppingItems">) => ({
  shoppingLists: state.shoppingLists.map(({ revision: _revision, ...list }) => list),
  shoppingItems: state.shoppingItems.map(({ addedAt: _addedAt, checkedAt: _checkedAt, ...item }) => item),
});

/**
 * Restores a local household's shopping lists to a snapshot through the public API: deletes lists created
 * since, recreates deleted ones, and deletes then re-adds exactly the rows whose state changed.
 */
export async function restoreShoppingLists(root: string, original: Household) {
  const write = async (path: string, method: string, body: object) => {
    const response = await fetch(`${root}/api/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert(response.ok, `Restore ${method} ${path}: ${response.status} ${await response.text()}`);
  };
  const response = await fetch(`${root}/api/household`);
  assert(response.ok, "Read the household before restoring shopping lists.");
  const current = Schema.decodeUnknownSync(HouseholdSchema)(await response.json());

  for (const list of current.shoppingLists)
    if (!original.shoppingLists.some((entry) => entry.id === list.id))
      await write(`shopping-lists/${encodeURIComponent(list.id)}`, "DELETE", { expectedRevision: list.revision ?? null });

  for (const list of original.shoppingLists) {
    const saved = current.shoppingLists.find((entry) => entry.id === list.id);
    if (!saved || saved.date !== list.date || saved.label !== list.label)
      await write("shopping-lists", "PUT", { id: list.id, date: list.date, label: list.label, expectedRevision: saved?.revision ?? null });
    const path = `shopping-lists/${encodeURIComponent(list.id)}/items`;
    const wanted = original.shoppingItems.filter((item) => item.listId === list.id);
    const rows = saved ? current.shoppingItems.filter((item) => item.listId === list.id) : [];
    const same = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      a.checked === b.checked && a.packages === b.packages && JSON.stringify(a.sources) === JSON.stringify(b.sources);
    const stale = rows.filter((row) => !wanted.some((item) => item.groceryId === row.groceryId && same(item, row)));
    const missing = wanted.filter((item) => !rows.some((row) => row.groceryId === item.groceryId && same(item, row)));
    if (stale.length) await write(path, "DELETE", { groceryIds: stale.map((row) => row.groceryId) });
    if (missing.length)
      await write(path, "POST", {
        items: missing.map(({ groceryId, checked, packages, sources }) => ({ groceryId, checked, packages, sources, replace: true })),
      });
  }
}

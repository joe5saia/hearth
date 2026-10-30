# Core user flows

Hearth should make it easy for a household to plan meals, shop for them, and cook them.
These journeys are the product lens for every change, whether made by a person or an agent.
They describe the experience we want to protect and improve, not a claim that every part is
already implemented or covered by automated tests.

## Using this guide for every change

- Review all three flows before designing or changing behavior. Identify which steps and
  transitions the change could affect, including effects outside the screen being edited.
- Validate affected journeys through the real application, not just an isolated control or API.
  For shared data changes, check both website and agent workflows where applicable. Agents
  must preserve the same household intent even when they use tools rather than screens.
- Exercise relevant variations below, including returning later and moving between flows.
  Check phone/touch use for cooking and in-store shopping, not just desktop planning.
- Report what was exercised, what passed, and any gaps or blocked steps. Do not call a whole
  journey covered because one step passed. An existing gap is not a reason to silently drop
  the user need or expand an unrelated change to implement it.

Every change needs this impact review; it does not require manually repeating every scenario
for a documentation-only edit or a change that cannot affect a particular flow. Follow the
repository's [validation guidance](../AGENTS.md#validation) for runtime checks and the
[Taskfile](../Taskfile.yml) for available tasks. Existing smoke tasks are supporting evidence,
not a declaration that these journeys are fully covered.

## 1. Making dinner

**Goal:** Open today's planned dinner and have everything needed to make it together, without
having to reconstruct the meal from scattered screens or the original publisher's website.

### Journey

1. Open the meal plan and select the dinner for the day.
2. Read the planned meal's recipe, including ingredients, amounts, instructions, and meal notes.
3. Do any prep that needs to happen ahead of time.
4. Return later to make the meal, with enough context to continue confidently.
5. When cooking more than one meal or dish at once, move between their recipes without losing
   track of which meal, quantities, or instructions are being followed.

### What changes must respect

- The meal plan is an entry point into cooking, not just a calendar for choosing recipes.
- Ingredients, instructions, serving amounts, and relevant notes should be easy to consult
  together. Avoid requiring repeated trips through unrelated screens during cooking.
- Prep and cooking may happen in separate sessions. Do not design only for an uninterrupted
  start-to-finish visit.
- Cooking may involve multiple meals at once. Do not assume the user can finish one recipe
  before opening another, or confuse one meal's state with another's.
- Cooking should use the planned meal's content and serving scale, not silently substitute a
  subsequently edited source recipe.

### Representative validation

- From the plan, open today's dinner and confirm its ingredients and instructions are usable
  at the planned serving amount.
- Consult the recipe for prep, leave, and return later. Check that the meal and saved notes
  remain available; verify any progress state affected by the change according to its actual
  persistence contract.
- Plan two dishes with different serving amounts. Switch between them while cooking and
  confirm the content, quantities, and any cooking controls stay associated with the right dish.

## 2. Meal planning

**Goal:** Quickly turn both saved recipes and recipes found elsewhere into a useful meal plan.

### Journey

1. Browse or search the household's saved recipes and choose something to make.
2. Add it to the intended day and meal slot, with the desired servings and notes.
3. Alternatively, find a new recipe on a site such as Ambitious Kitchen or The New York Times.
4. Import it into Hearth, review the result, and save it to the recipe collection.
5. Add that recipe to the intended meal in as few unnecessary steps as possible.
6. Review the plan and adjust meals as household plans change.

### What changes must respect

- Saved-recipe planning and discovery/import are equally important paths into the same plan.
- Importing is a means to planning and cooking, not a dead end in the recipe collection.
  Preserve enough context to get the newly saved recipe onto the intended day quickly.
- Speed must not hide missing ingredients, instructions, or uncertain imported quantities.
  A successful fetch is not necessarily a complete, usable recipe.
- A planned meal owns its recipe snapshot. Editing the meal and editing the saved recipe are
  different actions; the user's intended scope must stay clear.
- The resulting plan must be usable downstream for both shopping and cooking.

### Representative validation

- Find an existing recipe, schedule it with a changed serving amount, then reopen the planned
  meal and verify the date, slot, content, and scale.
- Import a supported public recipe URL into an isolated household, review/save the draft,
  schedule it, and open it from the plan. Check usable ingredients and instructions, not just
  that a recipe card exists.
- Exercise an unavailable or unsupported import. Make the limitation clear and preserve a
  usable next step; never treat a partial or rejected import as a completed planning journey.
- Change a planned meal without unintentionally changing the saved recipe or other meals.

## 3. Shopping: build, adjust, and use the list

**Goal:** Turn the meal plan and other household needs into a practical list, account for what's
already at home, and use that list to guide a grocery-store visit.

### Journey

1. Review the meal plan and use its meals as a starting point for building the shopping list.
2. Add the ingredients needed for those meals, with enough visibility to notice omissions.
3. Add other things the household wants, whether or not they belong to a planned recipe.
4. Review what's already in stock and adjust quantities or remove things that aren't needed.
   Adding everything first and then trimming or adjusting is a normal workflow, not a mistake.
5. Refer to past shops when useful while preparing the next shop.
6. At the grocery store, open the prepared list, follow it through the store, and check things
   off as they are picked up.

### What changes must respect

- The meal plan informs the list; it does not define list membership. Not every planned
  ingredient needs buying, and not every shopping item comes from a planned meal.
- Amounts must be adjustable to reflect stock on hand. If a meal needs two cans of beans and
  the household already has one, the final list should ask for one can, not two.
- Quantities needed by recipes and quantities being purchased are distinct. Make package
  sizes/counts clear enough to review without mistaking one package's contents for the total.
- Selecting meals, combining their needs, and adjusting the list must not silently lose
  ingredients that lack a grocery link or overwrite deliberate shopping choices.
- Planning or recipe edits must not silently rebuild a list that has already been adjusted.
- List preparation and in-store shopping are parts of one journey. The prepared quantities
  and useful store order should carry through, with clear feedback when items are checked off.
- Past shops should be understandable as past activity, not confused with the current list.

### Representative validation

- Build a list from two planned meals, including a shared ingredient and different serving
  scales. Review the combined need, package counts, and any ingredients that cannot be added.
- Start with a need for two one-can packages of beans, reduce the purchase count to one, omit
  an ingredient already in stock, and add something unrelated to the plan. Reopen the list
  and confirm all three decisions remain intact.
- Adjust a meal after preparing the list. Confirm it does not silently undo the household's
  stock adjustments or remove unrelated shopping items.
- On a phone-sized screen, enter shopping mode, follow the list order, and check off several
  items. Leave and return; confirm the remaining list reflects the acknowledged changes.
- When past-shop review is implemented or changed, open an earlier shop and return to the
  current list without changing either accidentally.

## Current boundaries and goals to keep visible

These notes distinguish the desired journeys from current implementation; they are not a
complete feature audit or permission to implement extra features in an unrelated change.

- Planned meals currently have independent recipe snapshots and serving scales. Shopping
  currently uses a manually maintained list, with recipe/meal ingredient selection and
  quantity review, List Builder, and Shop Mode. Date ranges do not define list membership.
- Prep-ahead continuity and cooking multiple dishes are design requirements to evaluate.
  This guide does not promise a dedicated prep schedule, persistent cooking progress, or a
  simultaneous multi-recipe workspace.
- Reviewing past shops is a desired part of shopping; the current manual list is not a
  saved history of individual shopping trips.
- Ambitious Kitchen and NYT describe real discovery sources, not a guarantee that every URL
  can be imported. Import is best-effort for supported public recipe data, with no paywall or
  access bypass. Review warnings and actual publisher availability separately from fixture tests.

import { describe, expect, it } from "vitest";
import {
  addDays,
  checkKey,
  displayAmount,
  nextDinnerDate,
  shoppingList,
  validDate,
  weekStart,
  type Meal,
  type Recipe,
} from "../src/domain";

const recipe: Recipe = {
  id: "one",
  title: "One",
  description: "",
  servings: 4,
  minutes: 20,
  category: "Vegetarian",
  photo: "",
  source: "",
  rating: "neutral",
  instructions: ["Cook."],
  ingredients: [
    { name: " Tomatoes ", quantity: 125, unit: "g" },
    { name: "Olive oil", quantity: 1, unit: "tbsp" },
  ],
};

const meal: Meal = {
  id: "m1",
  recipeId: "one",
  date: "2026-09-21",
  scale: 1.5,
  slot: "Dinner",
  note: "Add chicken",
};

describe("shopping totals", () => {
  it("includes both date boundaries, repeated recipes, fractional scales, and excludes outside dates", () => {
    const meals = [
      meal,
      { ...meal, id: "m2", date: "2026-09-27", scale: 0.5 },
      { ...meal, id: "m3", date: "2026-09-20", scale: 9 },
      { ...meal, id: "m4", date: "2026-09-28", scale: 7 },
    ];

    const result = shoppingList([recipe], meals, "2026-09-21", "2026-09-27");
    expect(result.map(({ name, quantity, unit }) => ({ name, quantity, unit }))).toEqual([
      { name: "olive oil", quantity: 6, unit: "tsp" },
      { name: "tomatoes", quantity: 250, unit: "g" },
    ]);
    expect(result[1].recipes).toEqual(["One"]);
    expect(result.some((item) => item.name === "chicken")).toBe(false);
  });
  it("normalizes ingredient names and compatible units without merging incompatible units", () => {
    const other: Recipe = {
      ...recipe,
      id: "two",
      title: "Two",
      ingredients: [
        { name: "TOMATOES", quantity: 0.3, unit: "kg" },
        { name: "tomatoes", quantity: 1, unit: "can" },
        { name: "olive   oil", quantity: 2, unit: "tsp" },
      ],
    };

    const result = shoppingList(
      [recipe, other],
      [meal, { ...meal, id: "m2", recipeId: "two", scale: 2 }],
      meal.date,
      meal.date,
    );

    expect(result.find((item) => item.name === "tomatoes" && item.unit === "g")?.quantity).toBe(787.5);
    expect(result.find((item) => item.unit === "can")?.quantity).toBe(2);
    expect(result.find((item) => item.name === "olive oil")?.quantity).toBe(8.5);
    expect(result).toHaveLength(3);
  });
  it("resets a check identity when total or date range changes, not due to float noise", () => {
    const item = shoppingList([recipe], [meal], meal.date, meal.date)[0];
    expect(checkKey(item, meal.date, meal.date)).not.toBe(
      checkKey({ ...item, quantity: 8 }, meal.date, meal.date),
    );
    expect(checkKey(item, meal.date, meal.date)).not.toBe(checkKey(item, meal.date, "2026-09-22"));
    expect(checkKey(item, meal.date, meal.date)).toBe(
      checkKey({ ...item, quantity: item.quantity + 1e-10 }, meal.date, meal.date),
    );
  });
  it("has no stale totals after meals are removed and never changes the original recipe", () => {
    shoppingList([recipe], [meal], meal.date, meal.date);
    expect(recipe.ingredients[0].quantity).toBe(125);
    expect(shoppingList([recipe], [], meal.date, meal.date)).toEqual([]);
  });
  it("keeps distinct contributing titles in meal order and isolates aggregation between calls", () => {
    const other = { ...recipe, id: "two", title: "Two" };
    const sameTitle = { ...recipe, id: "three" };

    const meals = [
      { ...meal, recipeId: "two", scale: 2 },
      meal,
      { ...meal, recipeId: "three", scale: 0.5 },
      { ...meal, recipeId: "missing", scale: 99 },
    ];

    const result = shoppingList([recipe, other, sameTitle], meals, meal.date, meal.date);
    expect(result[1].quantity).toBe(500);
    expect(result[1].recipes).toEqual(["Two", "One"]);
    result[1].recipes.push("Not a recipe");
    const next = shoppingList([recipe], [meal], meal.date, meal.date);
    expect(next[1].quantity).toBe(187.5);
    expect(next[1].recipes).toEqual(["One"]);
    expect(other.ingredients[0].quantity).toBe(125);
  });
});

describe("calendar and quantity boundaries", () => {
  it("suggests the next open dinner in the selected week, ignoring past days and lunch bookings", () => {
    const meals: Meal[] = [
      { ...meal, date: "2026-09-23" },
      { ...meal, id: "lunch", date: "2026-09-24", slot: "Lunch" },
    ];

    expect(nextDinnerDate(meals, "2026-09-21", "2026-09-23")).toBe("2026-09-24");
    expect(nextDinnerDate(meals, "2026-09-28", "2026-09-23")).toBe("2026-09-28");
    expect(nextDinnerDate(meals, "2026-09-14", "2026-09-23")).toBe("2026-09-14");
    expect(nextDinnerDate([{ ...meal, date: "2026-09-27" }], "2026-09-21", "2026-09-27")).toBe("2026-09-27");

    const fullWeek = Array.from({ length: 7 }, (_, index) => ({
      ...meal,
      id: `day-${index}`,
      date: addDays("2026-12-28", index),
    }));

    expect(nextDinnerDate(fullWeek, "2026-12-28", "2026-12-20")).toBe("2026-12-28");
  });
  it("uses Monday weeks and calendar dates across month, year, leap day, and DST boundaries", () => {
    expect(weekStart("2026-09-27")).toBe("2026-09-21");
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(weekStart("2027-01-01")).toBe("2026-12-28");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(validDate("2026-02-29")).toBe(false);
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2026-09-31")).toBe(false);
  });
  it("formats useful units without changing quantities", () => {
    expect(displayAmount({ name: "Rice", quantity: 999, unit: "g" })).toBe("999 g");
    expect(displayAmount({ name: "Rice", quantity: 1250, unit: "g" })).toBe("1.25 kg");
    expect(displayAmount({ name: "Oil", quantity: 7.5, unit: "tsp" })).toBe("7.5 tsp");
    expect(displayAmount({ name: "Oil", quantity: 9, unit: "tsp" })).toBe("3 tbsp");
  });
});

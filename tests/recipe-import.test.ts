import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { nytRecipeUrl, parseIngredient, parseRecipeHtml } from "../src/recipe-import";

const source =
  "https://cooking.nytimes.com/recipes/1018529-coq-au-vin?unlocked_article_code=example&smid=ck-recipe-iOS-share";

describe("NYT Cooking import", () => {
  it("imports the supplied Coq au Vin page without dropping ingredients or steps", async () => {
    const html = await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8");
    const { recipe, warnings } = parseRecipeHtml(html, source);

    expect(recipe).toMatchObject({ title: "Coq au Vin", servings: 4, minutes: 120, source });
    expect(recipe.photo).toBe(
      "https://static01.nyt.com/images/2023/08/24/multimedia/MC-Coq-Au-Van-ctpm/MC-Coq-Au-Van-ctpm-videoSixteenByNineJumbo1600.jpg",
    );
    expect(recipe.ingredients.map(({ quantity, unit }) => [quantity, unit])).toEqual([
      [3, "lb"],
      [2.5, "tsp"],
      [0.5, "tsp"],
      [3, "cup"],
      [1, "each"],
      [1, "tsp"],
      [4, "oz"],
      [3, "tbsp"],
      [1, "each"],
      [1, "each"],
      [8, "oz"],
      [2, "clove"],
      [1, "tsp"],
      [1, "tbsp"],
      [2, "tbsp"],
      [3, "tbsp"],
      [8, "oz"],
      [1, "pinch"],
      [2, "slice"],
      [0.25, "cup"],
    ]);
    expect(recipe.ingredients[6].name).toBe(
      "lardons, pancetta or bacon, diced into ¼-inch pieces (about 1 cup)",
    );
    expect(recipe.ingredients[11].name).toBe("garlic, minced");
    expect(recipe.instructions).toHaveLength(9);
    expect(recipe.instructions[0]).toContain("at least 2 hours or, even better, overnight.");
    expect(recipe.instructions[8]).toContain("serve with croutons on top.");
    expect(warnings).toEqual([]);
  });

  it("handles fractions and keeps ambiguous original wording for review", () => {
    expect(parseIngredient("1½ tablespoons butter").ingredient).toEqual({
      quantity: 1.5,
      unit: "tbsp",
      name: "butter",
    });
    expect(parseIngredient("1 3/4 cups flour").ingredient.quantity).toBe(1.75);
    expect(parseIngredient("⅓ cup milk").ingredient.quantity).toBeCloseTo(1 / 3);

    for (const line of ["Salt to taste", "2–3 onions", "2 to 3 onions", "1/0 cup milk", "0 cups flour"]) {
      expect(parseIngredient(line)).toEqual({
        ingredient: { name: line, quantity: 1, unit: "each" },
        review: true,
      });
    }
  });

  it.each([
    ["P2D", 2880],
    ["P1DT2H3M4S", 1564],
    ["PT45S", 1],
  ])("converts duration %s to %i minutes", async (duration, minutes) => {
    const html = await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8");
    const result = parseRecipeHtml(html.replace('"PT2H"', JSON.stringify(duration)), source);

    expect(result.recipe.minutes).toBe(minutes);
  });

  it("preserves compound and alternative measurements with a recipe review warning", async () => {
    const html = await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8");

    for (const line of [
      "2 cups minus 2 tablespoons cake flour (8 ½ ounces)",
      "1 cup plus 2 tablespoons granulated sugar (8 ounces)",
      "½ cup/100 grams granulated sugar",
      "½ cup / 100 grams granulated sugar",
      "1 cup plus ¼ cup milk",
    ]) {
      expect(parseIngredient(line)).toEqual({
        ingredient: { name: line, quantity: 1, unit: "each" },
        review: true,
      });
      const result = parseRecipeHtml(html.replace("3 pounds chicken legs and thighs", line), source);

      expect(result.recipe.ingredients[0]).toEqual({ name: line, quantity: 1, unit: "each" });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(`Review ingredient 1: “${line}”`);
    }

    expect(parseIngredient("2 cups flour, plus more for dusting")).toEqual({
      ingredient: { name: "flour, plus more for dusting", quantity: 2, unit: "cup" },
      review: false,
    });
    expect(parseIngredient("4 ounces bacon, cut into 1/4-inch pieces")).toEqual({
      ingredient: { name: "bacon, cut into 1/4-inch pieces", quantity: 4, unit: "oz" },
      review: false,
    });
  });

  it("keeps cloves as a spice while recognizing both garlic-clove word orders", () => {
    for (const name of ["cloves", "cloves (optional)"]) {
      expect(parseIngredient(`2 ${name}`)).toEqual({
        ingredient: { name, quantity: 2, unit: "each" },
        review: false,
      });
    }

    for (const line of ["2 cloves garlic, minced", "2 garlic cloves, minced", "2 cloves of garlic, minced"]) {
      expect(parseIngredient(line)).toEqual({
        ingredient: { name: "garlic, minced", quantity: 2, unit: "clove" },
        review: false,
      });
    }

    expect(parseIngredient("2 cups")).toEqual({
      ingredient: { name: "2 cups", quantity: 1, unit: "each" },
      review: true,
    });
  });

  it("finds Recipe in a graph, flattens sections, decodes HTML, and flags unknown quantities", () => {
    const html = `<script type='application/ld+json'>{bad}</script><script type='application/ld+json'>${JSON.stringify(
      {
        "@graph": [
          { "@type": "WebSite" },
          {
            "@type": ["Thing", "Recipe"],
            name: "Soup &amp; bread",
            recipeYield: ["6 servings"],
            totalTime: "PT1H25M",
            image: "https://example.com/soup.jpg",
            recipeIngredient: ["Salt to taste"],
            recipeInstructions: [{ itemListElement: [{ text: "<p>Stir &amp; simmer.</p>" }, "Serve."] }],
          },
        ],
      },
    )}</script>`;

    const result = parseRecipeHtml(html, source);

    expect(result.recipe).toMatchObject({
      title: "Soup & bread",
      minutes: 85,
      servings: 6,
      instructions: ["Stir & simmer.", "Serve."],
    });
    expect(result.warnings).toHaveLength(1);
    expect(() => parseRecipeHtml("<html>Sign in</html>", source)).toThrow("complete recipe");
  });

  it("allows only HTTPS recipe paths on the exact NYT Cooking host", () => {
    expect(nytRecipeUrl(source).href).toBe(source);

    for (const url of [
      "https://localhost/recipes/1",
      "http://cooking.nytimes.com/recipes/1",
      "https://cooking.nytimes.com.evil.test/recipes/1",
      "https://cooking.nytimes.com:1234/recipes/1",
      "https://user:pass@cooking.nytimes.com/recipes/1",
      "https://cooking.nytimes.com/search",
      "not a URL",
    ]) {
      expect(() => nytRecipeUrl(url)).toThrow();
    }
  });
});

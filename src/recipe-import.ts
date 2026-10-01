import { Option, Schema } from "effect";
import { decodeHTML } from "entities";

const Step = Schema.Struct({ text: Schema.String });

const Image = Schema.Union([Schema.String, Schema.Struct({ url: Schema.String })]);

const RecipeData = Schema.Struct({
  "@type": Schema.Union([Schema.Literal("Recipe"), Schema.Array(Schema.String)]),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  recipeYield: Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String)]),
  totalTime: Schema.String,
  image: Schema.optional(Schema.Union([Image, Schema.Array(Image)])),
  recipeIngredient: Schema.Array(Schema.String),
  recipeInstructions: Schema.Array(
    Schema.Union([
      Schema.String,
      Step,
      Schema.Struct({ itemListElement: Schema.Array(Schema.Union([Schema.String, Step])) }),
    ]),
  ),
});

const Document = Schema.Union([
  RecipeData,
  Schema.Array(Schema.Unknown),
  Schema.Struct({ "@graph": Schema.Array(Schema.Unknown) }),
]);

const plainText = (text: string) =>
  decodeHTML(text.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const unitNames = new Map(
  Object.entries({
    teaspoons: "tsp",
    teaspoon: "tsp",
    tsp: "tsp",
    tablespoons: "tbsp",
    tablespoon: "tbsp",
    tbsp: "tbsp",
    cups: "cup",
    cup: "cup",
    pounds: "lb",
    pound: "lb",
    lb: "lb",
    lbs: "lb",
    ounces: "oz",
    ounce: "oz",
    oz: "oz",
    grams: "g",
    gram: "g",
    g: "g",
    kilograms: "kg",
    kilogram: "kg",
    kg: "kg",
    milliliters: "ml",
    ml: "ml",
    liters: "l",
    liter: "l",
    l: "l",
    bunches: "bunch",
    bunch: "bunch",
    cans: "can",
    can: "can",
    pinch: "pinch",
    slices: "slice",
    slice: "slice",
  }),
);

const fractions = new Map(
  Object.entries({
    "¼": "1/4",
    "½": "1/2",
    "¾": "3/4",
    "⅓": "1/3",
    "⅔": "2/3",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
  }),
);

export function parseIngredient(line: string) {
  const original = plainText(line);

  const normalized = original
    .replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, (value) => ` ${fractions.get(value)}`)
    .replace(/⁄/g, "/")
    .trim();

  const match = normalized.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s+(.+)$/);
  const pinch = original.match(/^pinch\s+(.+)$/i);

  if (pinch) return { ingredient: { quantity: 1, unit: "pinch", name: pinch[1] }, review: false };

  if (!match) return { ingredient: { quantity: 1, unit: "each", name: original }, review: true };

  const amount = match[1].split(/\s+/).reduce((sum, part) => {
    const [numerator, denominator = "1"] = part.split("/");

    return sum + Number(numerator) / Number(denominator);
  }, 0);

  // Only normalize the leading amount; keep fractions in preparation notes intact.
  const rest = original.replace(/^[\d\s./⁄¼½¾⅓⅔⅛⅜⅝⅞]+/, "").trim();

  // Ranges, arithmetic and alternative measures need review rather than a guessed amount.
  // Match numeric additions, not notes such as "plus more for serving".
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    /^(?:to\s|[-–])/i.test(rest) ||
    /\b(?:plus|minus)\s+\d/i.test(normalized) ||
    /^[a-z.]+\s*\/\s*\d/i.test(match[2])
  )
    return { ingredient: { quantity: 1, unit: "each", name: original }, review: true };
  const [word] = rest.split(/\s+/);
  const unit = unitNames.get(word.toLowerCase().replace(/\.$/, ""));
  const garlic = rest.match(/^(?:garlic cloves?\b|cloves?\s+(?:of\s+)?garlic\b)(.*)$/i);
  const name = garlic ? `garlic${garlic[1]}` : unit ? rest.slice(word.length).trim() : rest;

  if (!name) return { ingredient: { quantity: 1, unit: "each", name: original }, review: true };

  return {
    ingredient: {
      quantity: amount,
      unit: garlic ? "clove" : (unit ?? "each"),
      name,
    },
    review: false,
  };
}

export function nytRecipeUrl(source: string): URL {
  const url = new URL(source);

  if (
    url.protocol !== "https:" ||
    url.hostname !== "cooking.nytimes.com" ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/recipes\/\d+(?:-[a-z0-9-]+)?\/?$/.test(url.pathname)
  )
    throw new Error("Use an https://cooking.nytimes.com/recipes/… URL.");

  return url;
}

export function parseRecipeHtml(html: string, source: string) {
  const scripts = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );

  for (const script of scripts) {
    let json;

    try {
      json = JSON.parse(script[1]);
    } catch {
      continue;
    }

    const document = Schema.decodeUnknownOption(Document)(json);

    if (Option.isNone(document)) continue;
    const value = document.value;
    const candidates = Array.isArray(value) ? value : "@graph" in value ? value["@graph"] : [value];

    for (const candidate of candidates) {
      const parsed = Schema.decodeUnknownOption(RecipeData)(candidate);

      if (Option.isNone(parsed) || !parsed.value["@type"].includes("Recipe")) continue;
      const data = parsed.value;
      const duration = data.totalTime.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);

      const minutes = duration
        ? Math.ceil(
            Number(duration[1] ?? 0) * 1440 +
              Number(duration[2] ?? 0) * 60 +
              Number(duration[3] ?? 0) +
              Number(duration[4] ?? 0) / 60,
          )
        : 0;

      const servings = Number(String(data.recipeYield).match(/^\d+(?:\.\d+)?/)?.[0] ?? 0);
      const ingredients = data.recipeIngredient.map(parseIngredient);
      const image = Array.isArray(data.image) ? data.image[0] : data.image;
      const photo = Schema.decodeUnknownOption(Schema.String)(image);
      const imageObject = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }))(image);

      const warnings = ingredients.flatMap((item, index) =>
        item.review
          ? [
              `Review ingredient ${index + 1}: “${data.recipeIngredient[index]}”. Its original wording is preserved; set the quantity and unit before saving.`,
            ]
          : [],
      );

      return {
        recipe: {
          id: crypto.randomUUID(),
          title: plainText(data.name),
          description: plainText(data.description ?? ""),
          servings,
          minutes,
          category: "",
          source,
          photo: Option.isSome(photo) ? photo.value : Option.isSome(imageObject) ? imageObject.value.url : "",
          rating: "neutral" as const,
          ingredients: ingredients.map((item, index) => ({
            ...item.ingredient,
            originalText: plainText(data.recipeIngredient[index]),
          })),
          instructions: data.recipeInstructions.flatMap((step) => {
            if (Schema.is(Schema.String)(step)) return [plainText(step)];

            if ("text" in step) return [plainText(step.text)];

            return step.itemListElement.map((item) =>
              plainText(Schema.is(Schema.String)(item) ? item : item.text),
            );
          }),
        },
        warnings,
      };
    }
  }

  throw new Error(
    "NYT did not provide a complete recipe on this page. Try an unlocked share link or add it manually.",
  );
}

export async function importRecipe(source: string) {
  let url;

  try {
    url = nytRecipeUrl(source);
  } catch {
    throw new Error("Use an https://cooking.nytimes.com/recipes/… URL.");
  }

  // Never follow redirects: an allowed public URL must not fetch an arbitrary host.
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: { Accept: "text/html" },
  });

  if (!response.ok)
    throw new Error("NYT couldn’t be read. Try an unlocked share link or add the recipe manually.");

  if (!response.body) throw new Error("NYT returned an empty page.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > 5_000_000) throw new Error("This recipe page is too large to import.");
      html += decoder.decode(value, { stream: true });
    }

    html += decoder.decode();
  } finally {
    await reader.cancel();
  }

  return parseRecipeHtml(html, source);
}

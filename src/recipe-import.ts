import { Effect, Option, Schema } from "effect";
import { decodeHTML } from "entities";
import ipaddr from "ipaddr.js";
import type { Unit } from "./domain";

/** An application-authored import failure whose message is safe for household members. */
export class RecipeImportError extends Error {}

interface RecipeStep {
  readonly text?: string;
  readonly itemListElement?: readonly (string | RecipeStep)[];
}

const Step: Schema.Codec<RecipeStep> = Schema.Struct({
  text: Schema.optional(Schema.String),
  itemListElement: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.suspend(() => Step)]))),
}).check(Schema.makeFilter((step) => Boolean(plainText(step.text ?? "") || step.itemListElement?.length)));

const Instructions = Schema.Union([Schema.String, Step, Schema.Array(Schema.Union([Schema.String, Step]))]);

const Image = Schema.Union([Schema.String, Schema.Struct({ url: Schema.String })]);

// Optional publisher metadata is decoded independently: a malformed photo or time
// must not invalidate otherwise complete ingredients and instructions.
const OptionalText = Schema.optional(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
);

const RecipeData = Schema.Struct({
  "@type": Schema.Union([Schema.Literal("Recipe"), Schema.Array(Schema.String)]),
  name: Schema.String,
  description: OptionalText,
  recipeYield: Schema.optional(
    Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String)]),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
  totalTime: OptionalText,
  prepTime: OptionalText,
  cookTime: OptionalText,
  image: Schema.optional(Schema.Union([Image, Schema.Array(Image)])).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
  recipeIngredient: Schema.Array(Schema.String),
  recipeInstructions: Instructions,
});

const Graph = Schema.Struct({ "@graph": Schema.Array(Schema.Unknown) });

const plainText = (text: string) =>
  decodeHTML(text.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const unitNames = new Map<string, Unit>(
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
  } satisfies Record<string, Unit>),
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

/** Keeps ambiguous ingredient wording intact and flags it for quantity/unit review. */
export function parseIngredient(line: string) {
  const original = plainText(line);

  const normalized = original
    .replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, (value) => ` ${fractions.get(value)}`)
    .replace(/⁄/g, "/")
    .trim();

  const match = normalized.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s+(.+)$/);
  const pinch = original.match(/^pinch\s+(.+)$/i);

  if (pinch) return { ingredient: { quantity: 1, unit: "pinch" as const, name: pinch[1] }, review: false };

  if (!match) return { ingredient: { quantity: 1, unit: "each" as const, name: original }, review: true };

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
    return { ingredient: { quantity: 1, unit: "each" as const, name: original }, review: true };
  const [word] = rest.split(/\s+/);
  const unit = unitNames.get(word.toLowerCase().replace(/\.$/, ""));
  const garlic = rest.match(/^(?:garlic cloves?\b|cloves?\s+(?:of\s+)?garlic\b)(.*)$/i);
  const name = garlic ? `garlic${garlic[1]}` : unit ? rest.slice(word.length).trim() : rest;

  if (!name) return { ingredient: { quantity: 1, unit: "each" as const, name: original }, review: true };

  return {
    ingredient: {
      quantity: amount,
      unit: garlic ? ("clove" as const) : (unit ?? ("each" as const)),
      name,
    },
    review: false,
  };
}

/** Accepts credential-free HTTPS public hostnames, never IP literals or local names. DNS is checked before fetching. */
export function recipeUrl(source: string): URL {
  let url: URL;

  try {
    url = new URL(source);
  } catch {
    throw new RecipeImportError("Use an HTTPS recipe link from a public website.");
  }

  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|onion)$/.test(url.hostname)
  )
    throw new RecipeImportError("Use an HTTPS recipe link from a public website.");

  return url;
}

const DnsResponse = Schema.Struct({
  Status: Schema.Literal(0),
  Answer: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.Number, data: Schema.String }))),
});

async function publicHost(url: URL, signal: AbortSignal) {
  // Check both address families, including CNAME answers, before every redirect hop.
  // Workers' public fetch is the network boundary; do not attach a private-network/VPC binding here.
  const answers = await Promise.all(
    ["A", "AAAA"].map(async (type) => {
      const dns = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`,
        {
          headers: { Accept: "application/dns-json" },
          redirect: "manual",
          signal,
        },
      );

      if (!dns.ok) throw new Error("DNS unavailable");

      return Schema.decodeUnknownSync(DnsResponse)(await dns.json()).Answer ?? [];
    }),
  );

  const addresses = answers.flat().filter((answer) => answer.type === 1 || answer.type === 28);

  if (
    !addresses.length ||
    addresses.some(({ data }) => !ipaddr.isValid(data) || ipaddr.parse(data).range() !== "unicast")
  )
    throw new Error("Non-public destination");
}

function durationMinutes(value = "") {
  const duration = value.match(
    /^P(?:0Y)?(?:0M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );

  return duration
    ? Math.ceil(
        Number(duration[1] ?? 0) * 1440 +
          Number(duration[2] ?? 0) * 60 +
          Number(duration[3] ?? 0) +
          Number(duration[4] ?? 0) / 60,
      )
    : 0;
}

function instructionText(value: typeof Instructions.Type, depth = 0): string[] {
  if (depth > 10)
    throw new RecipeImportError("This recipe has unsupported instruction nesting. Please add it manually.");

  if (Schema.is(Schema.String)(value)) return [plainText(value)].filter(Boolean);

  if (Schema.is(Schema.Array(Schema.Union([Schema.String, Step])))(value))
    return value.flatMap((item) => instructionText(item, depth + 1));

  return value.itemListElement?.length
    ? instructionText(value.itemListElement, depth + 1)
    : instructionText(value.text ?? "", depth + 1);
}

function recipeDraft(data: typeof RecipeData.Type, source: string) {
  const instructions = instructionText(data.recipeInstructions);

  // Collection pages and partial metadata must never become apparently complete recipes.
  if (
    !plainText(data.name) ||
    !data.recipeIngredient.length ||
    data.recipeIngredient.some((line) => !plainText(line)) ||
    !instructions.length
  )
    return;

  const minutes =
    durationMinutes(data.totalTime) || durationMinutes(data.prepTime) + durationMinutes(data.cookTime);

  const yieldText = String(Array.isArray(data.recipeYield) ? data.recipeYield[0] : (data.recipeYield ?? ""));
  const servings = Number(yieldText.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
  const ingredients = data.recipeIngredient.map(parseIngredient);
  const image = Schema.is(Schema.Array(Image))(data.image) ? data.image[0] : data.image;

  const warnings = ingredients.flatMap((item, index) =>
    item.review
      ? [
          `Review ingredient ${index + 1}: “${data.recipeIngredient[index]}”. Its original wording is preserved; set the quantity and unit before saving.`,
        ]
      : [],
  );

  const validTime = minutes > 0 && minutes <= 10000;
  const validYield = servings > 0 && servings <= 100;

  if (!validTime)
    warnings.push(
      "The page did not provide a usable total time. Time is set to 1 minute as a placeholder; correct it before saving.",
    );

  if (!validYield)
    warnings.push(
      "The page did not provide usable servings. Servings are set to 1 as a placeholder; correct them before saving.",
    );
  let photo = "";

  try {
    const candidate = new URL(Schema.is(Schema.String)(image) ? image : (image?.url ?? ""), source);

    if (
      image &&
      ["https:", "http:"].includes(candidate.protocol) &&
      !candidate.username &&
      !candidate.password
    )
      photo = candidate.href;
  } catch {
    /* An optional unusable image must not discard a complete recipe. */
  }

  return {
    recipe: {
      id: crypto.randomUUID(),
      title: plainText(data.name),
      description: plainText(data.description ?? ""),
      servings: validYield ? servings : 1,
      minutes: validTime ? minutes : 1,
      category: "",
      source,
      photo,
      rating: "neutral" as const,
      ingredients: ingredients.map((item, index) => ({
        ...item.ingredient,
        originalText: plainText(data.recipeIngredient[index]),
      })),
      instructions,
    },
    warnings,
  };
}

async function structuredHtml(html: string) {
  const fields = {
    name: new Array<string>(),
    recipeYield: new Array<string>(),
    totalTime: new Array<string>(),
    prepTime: new Array<string>(),
    cookTime: new Array<string>(),
    description: new Array<string>(),
    image: new Array<string>(),
    recipeIngredient: new Array<string>(),
    recipeInstructions: new Array<string>(),
  };

  let seen = false;
  let active = false;
  let nested = 0;
  let excluded = 0;

  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);

  const rewriter = new HTMLRewriter().on("[itemscope], [class]", {
    element(element) {
      const classes = (element.getAttribute("class") ?? "").split(/\s+/);
      const types = (element.getAttribute("itemtype") ?? "").split(/\s+/);
      const microdata = element.getAttribute("itemscope") !== null;

      const recipe =
        classes.some((name) => name === "h-recipe" || name === "hrecipe") ||
        (microdata && types.some((type) => /^https?:\/\/schema.org\/Recipe$/.test(type)));

      if (voidTags.has(element.tagName)) return;

      if (!seen && recipe) {
        seen = true;
        active = true;
        element.onEndTag(() => {
          active = false;
        });

        return;
      }

      const microformat = classes.some(
        (name) => /^h-[a-z]/.test(name) || ["hrecipe", "vcard", "hreview", "hentry"].includes(name),
      );

      if (!active || (!microdata && !microformat)) return;

      // Descendant entities own their properties, not the outer recipe. Only
      // explicitly linked instruction sections/steps contribute instruction text.
      const properties = (element.getAttribute("itemprop") ?? "").split(/\s+/);

      const instruction =
        microdata &&
        !microformat &&
        excluded === 0 &&
        (properties.includes("recipeInstructions") ||
          (nested > 0 && properties.includes("itemListElement"))) &&
        types.some((type) => /^https?:\/\/schema.org\/(?:HowToStep|HowToSection|ItemList)$/.test(type));

      nested++;

      if (!instruction) excluded++;
      element.onEndTag(() => {
        nested--;

        if (!instruction) excluded--;
      });
    },
  });

  const classes = new Map(
    Object.entries({
      name: ".p-name, .fn",
      recipeYield: ".p-yield, .yield",
      recipeInstructions: ".e-instructions, .instructions",
      recipeIngredient: ".p-ingredient, .ingredient",
    }),
  );

  for (const [key, values] of Object.entries(fields)) {
    const extra = classes.get(key);
    const selector = `[itemprop~="${key}"]${extra ? `, ${extra}` : ""}`;
    let value: string | undefined;
    let attribute = false;
    const owned = () => active && excluded === 0 && (nested === 0 || key === "recipeInstructions");
    rewriter.on(selector, {
      element(element) {
        if (!owned() || value !== undefined) return;

        const content =
          element.getAttribute("content") ??
          element.getAttribute("datetime") ??
          (key === "image" ? element.getAttribute("src") : null);

        attribute = content !== null;
        value = content ?? "";

        if (["meta", "img", "br", "link"].includes(element.tagName)) {
          values.push(value);
          value = undefined;

          return;
        }

        element.onEndTag(() => {
          if (value !== undefined) values.push(value);
          value = undefined;
        });
      },
      text(chunk) {
        if (owned() && value !== undefined && !attribute) value += chunk.text;
      },
    });

    if (key === "recipeInstructions")
      rewriter.on("p, li, br", {
        element() {
          if (owned() && value !== undefined && !attribute) value += "\n\n";
        },
      });
  }

  await rewriter.transform(new Response(html)).text();

  return {
    "@type": "Recipe" as const,
    name: fields.name[0] ?? "",
    description: fields.description[0],
    image: fields.image[0],
    recipeYield: fields.recipeYield[0],
    totalTime: fields.totalTime[0],
    prepTime: fields.prepTime[0],
    cookTime: fields.cookTime[0],
    recipeIngredient: fields.recipeIngredient,
    recipeInstructions: fields.recipeInstructions.flatMap((value) =>
      value.split("\n\n").map(plainText).filter(Boolean),
    ),
  };
}

/** Reads JSON-LD or structured HTML into an unsaved draft; missing timing/yield require review. */
export async function parseRecipeHtml(html: string, source: string) {
  const scripts = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );

  for (const script of scripts) {
    let json: unknown;

    try {
      json = JSON.parse(script[1]);
    } catch {
      continue;
    }

    const candidates: unknown[] = [json];

    while (candidates.length) {
      const candidate = candidates.shift();

      if (Schema.is(Schema.Array(Schema.Unknown))(candidate)) {
        candidates.push(...candidate);
        continue;
      }

      const graph = Schema.decodeUnknownOption(Graph)(candidate);

      if (Option.isSome(graph)) candidates.push(...graph.value["@graph"]);
      const parsed = Schema.decodeUnknownOption(RecipeData)(candidate);

      if (Option.isNone(parsed) || !parsed.value["@type"].includes("Recipe")) continue;
      const draft = recipeDraft(parsed.value, source);

      if (draft) return draft;
    }
  }

  const draft = recipeDraft(await structuredHtml(html), source);

  if (draft) return draft;
  throw new RecipeImportError(
    "No supported recipe data was found. Use an individual recipe page, try an unlocked share link, or add the recipe manually.",
  );
}

/** Fetches a public recipe page with at most three revalidated redirects, bounded to 20 seconds and 5 MB. */
export async function importRecipe(source: string) {
  let url = recipeUrl(source);

  let response: Response;

  try {
    const signal = AbortSignal.timeout(20000);

    for (let redirects = 0; ; redirects++) {
      await publicHost(url, signal);
      response = await fetch(url, {
        redirect: "manual",
        signal,
        headers: { Accept: "text/html" },
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("Location");
      await response.body?.cancel();

      if (!location || redirects >= 3) throw new Error("Recipe redirect limit or missing destination.");

      url = recipeUrl(new URL(location, url).href);
    }
  } catch {
    throw new RecipeImportError(
      "The recipe page couldn’t be read. Try an unlocked share link or add the recipe manually.",
    );
  }

  if (!response.ok)
    throw new RecipeImportError(
      "The recipe page couldn’t be read. Try an unlocked share link or add the recipe manually.",
    );

  if (!response.body)
    throw new RecipeImportError(
      "The recipe page was empty. Try another recipe link or add the recipe manually.",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > 5_000_000) throw new RecipeImportError("This recipe page is too large to import.");
      html += decoder.decode(value, { stream: true });
    }

    html += decoder.decode();
  } catch {
    if (size > 5_000_000) throw new RecipeImportError("This recipe page is too large to import.");

    throw new RecipeImportError(
      "The recipe page couldn’t be read. Try an unlocked share link or add the recipe manually.",
    );
  } finally {
    // Cleanup failure must not replace the read result or its classified public failure.
    await reader.cancel().catch(() => {});
  }

  return parseRecipeHtml(html, source);
}

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { categories, matchesRecipeSearch, units } from "./domain";
import { createRecipes, getRecipes, updateRecipes, RecipeInputError } from "./recipes";

const id = z.string().min(1).max(100);

const ingredient = z.strictObject({
  name: z.string().min(1).max(150),
  quantity: z.number().positive().max(1_000_000),
  unit: z.enum(units),
});

const fields = z.strictObject({
  title: z.string().trim().min(1).max(150),
  description: z.string().max(2000),
  servings: z.number().positive().max(100),
  minutes: z.number().int().min(1).max(10000).describe("Total preparation and cooking time in minutes."),
  category: z.enum(categories),
  photo: z.string().describe("Image URL; empty string means no image."),
  source: z.string().describe("Original recipe URL; empty string means no source."),
  rating: z.enum(["up", "down", "neutral"]),
  ingredients: z
    .array(ingredient)
    .min(1)
    .max(100)
    .describe(`Use {name:string, quantity:number>0, unit:${units.join("|")}}.`),
  instructions: z.array(z.string().trim().min(1).max(10000)).min(1).max(100),
});

const recipe = fields.extend({ id });

const recipesOutput = z.object({ recipes: z.array(recipe) });

const getOutput = recipesOutput.extend({ missingIds: z.array(id) });

const batch = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(25);

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

async function result<T extends Record<string, unknown>>(operation: () => Promise<T>) {
  try {
    const data = await operation();

    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            error instanceof RecipeInputError
              ? error.message
              : "Recipe storage is unavailable. Check the current recipes before retrying a write.",
        },
      ],
    };
  }
}

export function recipeMcp(db: D1Database) {
  return createMcpHandler(
    () => {
      const server = new McpServer({ name: "hearth-recipes", version: "1.0.0" });

      server.registerTool(
        "search_recipes",
        {
          title: "Search recipes",
          description:
            "Search the household's recipes exactly like the app: case-insensitive literal substring across title and ingredient names (not instructions or description). Use query='' to browse all. Returns id, title, and ingredients only, ordered by title then id. Page size is 1–25 (default 25); larger limits are rejected. Always returns pagination, even with no matches. Continue with pagination.nextOffset until null, keeping query and limit unchanged. Fetch full details with get_recipes.",
          inputSchema: z.strictObject({
            query: z.string().max(2000).default(""),
            limit: z.number().int().min(1).max(25).default(25).describe("Page size: 1–25, default 25."),
            offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
          }),
          outputSchema: z.object({
            recipes: z.array(z.object({ id, title: z.string(), ingredients: z.array(ingredient) })),
            pagination: z.object({
              total: z.number(),
              limit: z.number(),
              offset: z.number(),
              hasMore: z.boolean(),
              nextOffset: z.number().nullable(),
            }),
          }),
          annotations: readAnnotations,
        },
        ({ query, limit, offset }) =>
          result(async () => {
            const rows = await db
              .prepare("SELECT id,title,ingredients FROM recipes ORDER BY title,id")
              .all<{ id: string; title: string; ingredients: string }>();

            const matching = rows.results
              .map((row) => ({
                ...row,
                ingredients: z.array(ingredient).parse(JSON.parse(row.ingredients)),
              }))
              .filter((row) => matchesRecipeSearch(row, query));

            const hasMore = offset + limit < matching.length;

            return {
              recipes: matching.slice(offset, offset + limit),
              pagination: {
                total: matching.length,
                limit,
                offset,
                hasMore,
                nextOffset: hasMore ? offset + limit : null,
              },
            };
          }),
      );
      server.registerTool(
        "get_recipes",
        {
          title: "Get full recipes",
          description:
            "Fetch full recipes by IDs from search_recipes or create_recipes. Supply 1–25 unique IDs, even for a single recipe. Returns recipes in requested order and missingIds for IDs not found; missing IDs do not fail the whole request.",
          inputSchema: z.strictObject({
            ids: batch(id).refine((ids) => new Set(ids).size === ids.length, "IDs must be unique"),
          }),
          outputSchema: getOutput,
          annotations: readAnnotations,
        },
        ({ ids }) => result(() => getRecipes(db, ids)),
      );

      server.registerTool(
        "create_recipes",
        {
          title: "Create recipes",
          description:
            "Create 1–25 recipes in one atomic batch. IDs are generated by Hearth; do not supply id. Required: title, servings, minutes, category, ingredients, instructions. Optional description/photo/source default to empty strings; rating defaults to neutral. Use supported ingredient units and category enum values. Returns full saved recipes with IDs. Calling again creates duplicates; do not blindly retry after an ambiguous network failure.",
          inputSchema: z.strictObject({
            recipes: batch(
              fields.extend({
                description: fields.shape.description.default(""),
                photo: fields.shape.photo.default(""),
                source: fields.shape.source.default(""),
                rating: fields.shape.rating.default("neutral"),
              }),
            ),
          }),
          outputSchema: recipesOutput,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        ({ recipes }) => result(() => createRecipes(db, recipes)),
      );
      server.registerTool(
        "update_recipes",
        {
          title: "Update recipes",
          description:
            "Update 1–25 existing recipes with {id, changes} entries. Send only fields to change; omitted fields are preserved. ingredients and instructions replace the ENTIRE array, so get_recipes first before editing an item. IDs cannot change. Unknown fields, empty changes, duplicate IDs, invalid recipes, or missing IDs reject the batch before writes. Returns full saved recipes. This tool never creates recipes.",
          inputSchema: z.strictObject({
            updates: batch(
              z.strictObject({
                id,
                changes: fields
                  .partial()
                  .refine((changes) => Object.keys(changes).length > 0, "Supply at least one changed field"),
              }),
            ).refine(
              (updates) => new Set(updates.map((update) => update.id)).size === updates.length,
              "IDs must be unique",
            ),
          }),
          outputSchema: getOutput,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        ({ updates }) => result(() => updateRecipes(db, updates)),
      );

      return server;
    },
    { responseMode: "json" },
  );
}

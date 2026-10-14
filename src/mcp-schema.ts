import { JsonSchema, Schema } from "effect";

/** Creates an excess-property-rejecting registration adapter without mutating the domain schema. */
export function mcpSchema<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  // Effect attaches ~standard to the schema, so each registration needs its own copy.
  const standard = Schema.toStandardSchemaV1(Schema.make<S>(schema.ast), {
    parseOptions: { onExcessProperty: "error" },
  });

  const json = (side: Schema.Constraint, options: { target: string }) => {
    const document = Schema.toJsonSchemaDocument(side, { onExcessProperty: "error" });

    if (options.target === "draft-07") {
      const draft = JsonSchema.toDocumentDraft07(document);

      return { ...draft.schema, definitions: draft.definitions };
    }

    if (options.target !== "draft-2020-12")
      throw new Error(`Unsupported JSON Schema target: ${options.target}`);

    return { ...document.schema, $defs: document.definitions };
  };

  return {
    "~standard": {
      ...standard["~standard"],
      jsonSchema: {
        input: (options: { target: string }) => json(Schema.toEncoded(schema), options),
        output: (options: { target: string }) => json(Schema.toType(schema), options),
      },
    },
  };
}

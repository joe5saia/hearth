import { Schema } from "effect";

export const FeedbackSchema = Schema.Struct({
  id: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  ),
  request: Schema.String.check(Schema.isLengthBetween(1, 4000), Schema.isPattern(/\S/)),
  context: Schema.Struct({
    page: Schema.Literals(["plan", "recipes", "shopping", "groceries", "recipe-checklist"]),
    location: Schema.String.check(Schema.isLengthBetween(1, 300), Schema.isPattern(/^\/(?:#[a-z-]+)?$/)),
    detail: Schema.String.check(Schema.isMaxLength(300)),
    display: Schema.Literals(["browser", "standalone"]),
  }),
});

export type Feedback = typeof FeedbackSchema.Type;

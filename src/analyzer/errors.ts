import { Schema } from "effect"

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound, { readonly brand: unique symbol }>()("ProjectNotFound", {
  tsconfig: Schema.String,
}) {}

export class ProjectParseFailed extends Schema.TaggedError<ProjectParseFailed, { readonly brand: unique symbol }>()("ProjectParseFailed", {
  tsconfig: Schema.String,
  diagnostics: Schema.Array(Schema.String),
}) {}

export class AnalyzerUnavailable extends Schema.TaggedError<AnalyzerUnavailable, { readonly brand: unique symbol }>()("AnalyzerUnavailable", {
  cause: Schema.Defect(),
}) {}

export type AnalysisError = ProjectNotFound | ProjectParseFailed | AnalyzerUnavailable | GraphFileInvalid

export class GraphFileInvalid extends Schema.TaggedError<GraphFileInvalid, { readonly brand: unique symbol }>()("GraphFileInvalid", {
  path: Schema.String,
  issue: Schema.String,
}) {}

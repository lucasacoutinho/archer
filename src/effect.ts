/** The Effect surface that the root export wraps. */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { type FileSystem, Layer, type Path } from "effect"
import { Analyzer } from "./analyzer/Analyzer.ts"

export { Analyzer, Workspace } from "./analyzer/Analyzer.ts"
export { AnalyzerUnavailable, GraphFileInvalid, ProjectNotFound, ProjectParseFailed, type AnalysisError } from "./analyzer/errors.ts"
export { formatGraphFile, GraphFile, readGraphFile } from "./analyzer/graph-file.ts"
export { ArcherConfig, ConfigInvalid, type Configuration, decodeConfiguration } from "./config/input.ts"
export { ConfigSelector } from "./core/config.ts"
export { Graph, Selector, SourceFile, Target } from "./core/model.ts"
export { Rule, Violation } from "./core/rule.ts"
export { SelectorText } from "./core/text.ts"
export { Format, render } from "./report/render.ts"
export { Report } from "./report/report.ts"
export { checkGraph, ConfigNotFound, ConfigRejected, run, type BaselineMode, type RunError, type RunOptions, type RunResult } from "./run.ts"
export { BaselineError } from "./shell/baseline-file.ts"
export { ConfigLoadError } from "./shell/load-config.ts"

export type ArcherServices = Analyzer | FileSystem.FileSystem | Path.Path

/** The TypeScript analyzer and Node's platform services. */
export const ArcherLive: Layer.Layer<ArcherServices> = Analyzer.typescript.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

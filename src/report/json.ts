import { Schema } from "effect"
import { Report } from "./report.ts"

export const json = (report: Report): string => JSON.stringify(Schema.encodeSync(Report)(report), undefined, 2)

import { z } from "zod";

/** Parse deployment JSON without echoing its contents (which can include credentials). */
export function jsonSetting<T extends z.ZodType>(schema: T, maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .transform((value, context) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        context.addIssue({ code: "custom", message: "Use valid JSON for this setting." });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

import { z } from "zod";

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
/** Records must already be canonical; readers never normalize or fill missing data. */
export const timestamp = z.string().datetime().refine(value => new Date(value).toISOString() === value, "Expected a canonical UTC timestamp");
export const requestTimestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const absolutePath = z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0"), "Expected an absolute path without NUL");
export const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && value.trim() === value, "Expected normalized nonempty text");

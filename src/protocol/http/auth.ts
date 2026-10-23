import { timingSafeEqual } from "node:crypto";

export function bearerVerifier(token: string): (header: string | undefined) => boolean {
  const expected = Buffer.from("Bearer " + token);
  return header => {
    const actual = Buffer.from(header ?? "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

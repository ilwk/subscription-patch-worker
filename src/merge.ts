export type Config = Record<string, unknown>;
export function isObject(value: unknown): value is Config {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function validate(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(validate);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error("Unsafe configuration key");
    validate(child);
  }
}
function mergeObject(base: Config, override: Config): Config {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = isObject(value)
      ? mergeObject(isObject(result[key]) ? result[key] : {}, value)
      : structuredClone(value);
  }
  return result;
}
function mergeTagged(base: unknown, override: unknown): unknown[] {
  if (!Array.isArray(override) || (base !== undefined && !Array.isArray(base)))
    throw new Error("Expected tagged array");
  // Explicit [] clears the array.
  if (override.length === 0) return [];
  const result: unknown[] = structuredClone(base ?? []);
  const indexes = new Map<string, number>();
  result.forEach((item, index) => {
    if (!isObject(item)) throw new Error("Invalid base entry");
    if (typeof item.tag === "string") {
      if (indexes.has(item.tag)) throw new Error("Duplicate base tag");
      indexes.set(item.tag, index);
    }
  });
  const seen = new Set<string>();
  for (const item of override) {
    if (
      !isObject(item) ||
      typeof item.tag !== "string" ||
      !item.tag.trim() ||
      seen.has(item.tag)
    )
      throw new Error("Override entries require unique nonempty tags");
    seen.add(item.tag);
    const index = indexes.get(item.tag);
    if (index === undefined) {
      if (typeof item.type !== "string" || !item.type.trim())
        throw new Error("New tagged entry requires type");
      result.push(structuredClone(item));
    } else {
      result[index] = mergeObject(result[index] as Config, item);
    }
  }
  return result;
}
export function mergeConfig(
  base: Config,
  override: unknown,
  format: "sing-box" | "mihomo",
): Config {
  if (!isObject(override)) throw new Error("Override must be an object");
  validate(base);
  validate(override);
  const result = mergeObject(base, override);
  if (format === "sing-box") {
    for (const key of ["inbounds", "outbounds"]) {
      if (Object.hasOwn(override, key))
        result[key] = mergeTagged(base[key], override[key]);
    }
  }
  return result;
}

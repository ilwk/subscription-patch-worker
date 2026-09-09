import { parseDocument, stringify } from "yaml";
type Config = Record<string, unknown>;
function object(x: unknown): x is Config {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
function merge(c: Config, key: string, cidrs: string[]) {
  const old = c[key] ?? [];
  if (!Array.isArray(old) || old.some((x) => typeof x !== "string"))
    throw new Error("Invalid exclusions");
  c[key] = [...new Set([...old, ...cidrs])];
}
const adapters = [
  {
    matches: (c: Config) => Array.isArray(c.inbounds),
    patch(c: Config, cidrs: string[]) {
      const tuns = (c.inbounds as unknown[]).filter(
        (x): x is Config => object(x) && x.type === "tun",
      );
      if (!tuns.length) throw new Error("No TUN");
      for (const tun of tuns) merge(tun, "route_exclude_address", cidrs);
    },
  },
  {
    matches: (c: Config) =>
      "tun" in c || "proxies" in c || "proxy-providers" in c,
    patch(c: Config, cidrs: string[]) {
      if (c.tun === undefined) c.tun = {};
      if (!object(c.tun)) throw new Error("Invalid TUN");
      merge(c.tun, "route-exclude-address", cidrs);
    },
  },
];
export function transform(body: string, cidrs: string[]) {
  let c: unknown,
    json = true;
  try {
    c = JSON.parse(body);
  } catch {
    json = false;
    const doc = parseDocument(body, { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length)
      throw new Error("Invalid YAML");
    c = doc.toJS({ maxAliasCount: 50 });
  }
  if (!object(c)) throw new Error("Expected configuration");
  const adapter = adapters.find((a) => a.matches(c));
  if (!adapter) throw new Error("Unsupported format");
  adapter.patch(c, cidrs);
  return {
    body: json ? JSON.stringify(c) : stringify(c),
    contentType: json
      ? "application/json; charset=utf-8"
      : "application/yaml; charset=utf-8",
  };
}

import { parseDocument, stringify } from "yaml";
import singBoxOverride from "../overrides/sing-box.json";
import mihomoOverride from "../overrides/mihomo.yaml";
import { isObject, mergeConfig } from "./merge";

export interface Overrides {
  "sing-box": unknown;
  mihomo: unknown;
}
function parseYaml(source: string): unknown {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML");
  return doc.toJS({ maxAliasCount: 50 });
}
const defaults: Overrides = {
  "sing-box": singBoxOverride,
  mihomo: parseYaml(mihomoOverride) ?? {},
};
export function transform(body: string, overrides: Overrides = defaults) {
  let config: unknown,
    json = true;
  try {
    config = JSON.parse(body);
  } catch {
    json = false;
    config = parseYaml(body);
  }
  if (!isObject(config)) throw new Error("Expected configuration");
  const singBox =
    "inbounds" in config || "outbounds" in config || "endpoints" in config;
  const mihomo =
    "tun" in config ||
    "proxies" in config ||
    "proxy-providers" in config ||
    "proxy-groups" in config;
  if (singBox === mihomo) throw new Error("Unsupported or ambiguous format");
  const format = singBox ? "sing-box" : "mihomo";
  const override = overrides[format];
  const result = mergeConfig(config, override, format);
  return {
    // An empty override is a true passthrough, including comments and whitespace.
    body:
      isObject(override) && Object.keys(override).length === 0
        ? body
        : json
          ? JSON.stringify(result)
          : stringify(result),
    contentType: json
      ? "application/json; charset=utf-8"
      : "application/yaml; charset=utf-8",
  };
}

import { parseDocument, stringify } from "yaml";
import singBoxOverride from "../overrides/sing-box.json";
import mihomoOverride from "../overrides/mihomo.yaml";
import { isObject, mergeConfig } from "./merge";
import { SubscriptionError } from "./errors";

export interface Overrides {
  "sing-box": unknown;
  mihomo: unknown;
}
function parseYaml(source: string): unknown {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML");
  return doc.toJS({ maxAliasCount: 50 });
}
export function transform(body: string, overrides?: Overrides) {
  let config: unknown,
    json = true;
  try {
    config = JSON.parse(body);
  } catch {
    json = false;
    try {
      config = parseYaml(body);
    } catch {
      throw new SubscriptionError(
        "UPSTREAM_PARSE_ERROR",
        "Upstream is not valid JSON/YAML. Check UPSTREAM_USER_AGENT and the subscription format.",
      );
    }
  }
  if (!isObject(config))
    throw new SubscriptionError(
      "UNSUPPORTED_FORMAT",
      "Expected a sing-box or Mihomo configuration, not a node list or web page. Check UPSTREAM_USER_AGENT.",
    );
  const singBox =
    "inbounds" in config || "outbounds" in config || "endpoints" in config;
  const mihomo =
    "tun" in config ||
    "proxies" in config ||
    "proxy-providers" in config ||
    "proxy-groups" in config;
  if (singBox === mihomo)
    throw new SubscriptionError(
      "UNSUPPORTED_FORMAT",
      "Unsupported or ambiguous configuration. Check UPSTREAM_USER_AGENT; expected sing-box or Mihomo.",
    );
  const format = singBox ? "sing-box" : "mihomo";
  let override: unknown;
  try {
    override = overrides
      ? overrides[format]
      : singBox
        ? singBoxOverride
        : (parseYaml(mihomoOverride) ?? {});
    if (!isObject(override)) throw new Error("Expected object");
  } catch {
    throw new SubscriptionError(
      "INVALID_OVERRIDE",
      "Override must be a valid configuration object. Check the selected overrides file.",
      500,
    );
  }
  let result;
  try {
    result = mergeConfig(config, override, format);
  } catch {
    throw new SubscriptionError(
      "MERGE_FAILED",
      "Cannot merge configuration. Check override tags, new entry types and configuration structure.",
      500,
    );
  }
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

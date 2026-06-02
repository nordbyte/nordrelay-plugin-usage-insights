import { readState, upsertPriceRule, writeState } from "./storage.js";

export const DEFAULT_PRICE_CATALOG_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export function normalizeSettings(settings = {}) {
  return {
    priceCatalogUrl: String(settings.priceCatalogUrl || DEFAULT_PRICE_CATALOG_URL).trim() || DEFAULT_PRICE_CATALOG_URL,
    autoRefreshPrices: settings.autoRefreshPrices !== false && settings.autoRefreshPrices !== "false",
    priceRefreshHours: Math.max(1, Number(settings.priceRefreshHours) || 24),
    retentionDays: Math.max(1, Number(settings.retentionDays) || 365),
  };
}

export async function refreshPriceCatalog(db, settings = {}, options = {}) {
  const normalized = normalizeSettings(settings);
  const state = readState(db, "price_catalog") || {};
  const fetchedAt = Date.parse(String(state.fetchedAt || ""));
  const stale = !Number.isFinite(fetchedAt) || Date.now() - fetchedAt > normalized.priceRefreshHours * 60 * 60 * 1000;
  if (!options.force && !stale) {
    return { refreshed: false, source: state.source || normalized.priceCatalogUrl, fetchedAt: state.fetchedAt || "", rules: state.rules || 0 };
  }
  if (!globalThis.fetch) {
    throw new Error("Global fetch is not available in this Node.js runtime.");
  }
  const response = await fetch(normalized.priceCatalogUrl, {
    headers: { "accept": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Price catalog request failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const rules = liteLlmPriceRules(payload);
  const updatedAt = new Date().toISOString();
  for (const rule of rules) {
    upsertPriceRule(db, { ...rule, updatedAt });
  }
  const result = { refreshed: true, source: normalized.priceCatalogUrl, fetchedAt: updatedAt, rules: rules.length };
  writeState(db, "price_catalog", result);
  return result;
}

export async function maybeRefreshPriceCatalog(db, settings) {
  const normalized = normalizeSettings(settings);
  if (!normalized.autoRefreshPrices) {
    return { refreshed: false, disabled: true };
  }
  try {
    return await refreshPriceCatalog(db, normalized);
  } catch (error) {
    const previous = readState(db, "price_catalog") || {};
    writeState(db, "price_catalog", {
      ...previous,
      source: normalized.priceCatalogUrl,
      error: error instanceof Error ? error.message : String(error),
      errorAt: new Date().toISOString(),
    });
    return { refreshed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function liteLlmPriceRules(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const rules = [];
  for (const [model, raw] of Object.entries(payload)) {
    if (!raw || typeof raw !== "object") continue;
    const input = perMillion(raw.input_cost_per_token);
    const output = perMillion(raw.output_cost_per_token);
    const cachedInput = perMillion(raw.cache_read_input_token_cost ?? raw.input_cost_per_token_cache_read);
    const cacheWrite = perMillion(raw.cache_creation_input_token_cost ?? raw.input_cost_per_token_cache_write);
    const reasoning = perMillion(raw.output_cost_per_reasoning_token ?? raw.reasoning_output_cost_per_token);
    if ([input, output, cachedInput, cacheWrite, reasoning].every((value) => value === null)) continue;
    rules.push({
      provider: providerFromLiteLlmRecord(model, raw),
      model,
      inputPer1M: input,
      cachedInputPer1M: cachedInput,
      cacheWritePer1M: cacheWrite,
      outputPer1M: output,
      reasoningOutputPer1M: reasoning ?? output,
      source: "litellm",
    });
  }
  return rules;
}

function providerFromLiteLlmRecord(model, raw) {
  const provider = String(raw.litellm_provider || raw.provider || "").trim();
  if (provider) return provider;
  const text = String(model || "");
  if (text.includes("/")) return text.split("/")[0];
  if (/^claude/i.test(text)) return "anthropic";
  if (/^gpt-|^o\\d|^text-|^davinci/i.test(text)) return "openai";
  return "unknown";
}

function perMillion(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : null;
}

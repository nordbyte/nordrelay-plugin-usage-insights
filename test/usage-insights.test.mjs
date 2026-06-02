import test from "node:test";
import assert from "node:assert/strict";

import { liteLlmPriceRules } from "../src/pricing.js";

test("maps LiteLLM prices including cached token rates", () => {
  const rules = liteLlmPriceRules({
    "openai/example": {
      litellm_provider: "openai",
      input_cost_per_token: 0.000001,
      cache_read_input_token_cost: 0.00000025,
      cache_creation_input_token_cost: 0.00000125,
      output_cost_per_token: 0.000004,
      output_cost_per_reasoning_token: 0.000003,
    },
  });

  assert.equal(rules.length, 1);
  assert.equal(rules[0].provider, "openai");
  assert.equal(rules[0].inputPer1M, 1);
  assert.equal(rules[0].cachedInputPer1M, 0.25);
  assert.equal(rules[0].cacheWritePer1M, 1.25);
  assert.equal(rules[0].outputPer1M, 4);
  assert.equal(rules[0].reasoningOutputPer1M, 3);
});

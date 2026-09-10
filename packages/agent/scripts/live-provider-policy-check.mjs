#!/usr/bin/env node
import assert from "node:assert/strict";
import { rejectsPersonalOpenAiCredential } from "./live-provider-policy.mjs";

const profile = (overrides = {}) => ({
  provider: { type: "builtin", providerId: "anthropic" },
  modelId: "claude-sonnet-4-5",
  credentialSource: "managed",
  ...overrides,
});

assert.equal(rejectsPersonalOpenAiCredential(profile()), false);
assert.equal(rejectsPersonalOpenAiCredential(profile({
  provider: { type: "builtin", providerId: "openai-codex" },
  modelId: "gpt-5.2-codex",
})), true);
assert.equal(rejectsPersonalOpenAiCredential(profile({
  provider: { type: "builtin", providerId: "OPENAI" },
  modelId: "gpt-5",
})), true);
assert.equal(rejectsPersonalOpenAiCredential(profile({
  provider: { type: "builtin", providerId: "custom-provider" },
  modelId: "gpt-5-codex",
})), true);
assert.equal(rejectsPersonalOpenAiCredential(profile({
  provider: {
    type: "custom",
    providerId: "custom-provider",
    baseUrl: "https://api.openai.com/v1",
  },
  modelId: "custom-model",
})), true);
assert.equal(rejectsPersonalOpenAiCredential(profile({
  provider: { type: "builtin", providerId: "custom-provider" },
  modelId: "custom-model",
  credentialSource: "environment",
  environmentVariable: "OPENAI_API_KEY",
})), true);
assert.equal(rejectsPersonalOpenAiCredential(profile({
  provider: { type: "builtin", providerId: "custom-provider" },
  modelId: "custom-model",
  credentialSource: "environment",
  environmentVariable: "CODEX_TOKEN",
})), true);
assert.equal(rejectsPersonalOpenAiCredential(profile({
  provider: {
    type: "custom",
    providerId: "custom-provider",
    baseUrl: "not-a-url",
  },
  modelId: "custom-model",
})), true);

process.stdout.write("Live provider credential policy check passed.\n");

const normalizeIdentifier = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";

export const rejectsPersonalOpenAiCredential = (profile) => {
  const providerId = normalizeIdentifier(profile.provider?.providerId);
  const modelId = normalizeIdentifier(profile.modelId);
  const environmentVariable = normalizeIdentifier(profile.environmentVariable);
  let hostname = "";
  if (profile.provider?.type === "custom") {
    try {
      hostname = new URL(profile.provider.baseUrl).hostname.toLowerCase();
    } catch {
      return true;
    }
  }
  return providerId.includes("openai")
    || providerId.includes("codex")
    || modelId.includes("codex")
    || hostname === "openai.com"
    || hostname.endsWith(".openai.com")
    || environmentVariable.includes("openai")
    || environmentVariable.includes("codex");
};

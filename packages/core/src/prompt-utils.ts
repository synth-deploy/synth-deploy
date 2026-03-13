/**
 * Utilities for safely constructing LLM prompts with user-controlled input.
 */

/**
 * Sanitize a user-controlled string before inclusion in an LLM prompt.
 * Strips characters and patterns commonly used in prompt injection attacks:
 * - Control characters (except newline/tab)
 * - Role injection patterns (System:, Assistant:, Human:)
 * - Triple backtick blocks that could reframe context
 * - XML-style tags used to inject system instructions
 */
export function sanitizeForPrompt(input: string): string {
  // Strip control characters except \n and \t
  let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Neutralize prompt injection patterns
  sanitized = sanitized
    .replace(/\b(system|assistant|human)\s*:/gi, (match) => match.replace(":", "\uFF1A"))
    .replace(/```/g, "'''")
    .replace(/<\/?(?:system|prompt|instruction|context|message)[^>]*>/gi, "");

  return sanitized;
}

/**
 * Mask the value of a variable if its key looks like it may contain a secret.
 * Returns the original value for non-sensitive keys.
 */
export function maskIfSecret(key: string, value: string): string {
  if (/key|password|secret|token|credential|auth|passwd|pwd|api_key/i.test(key)) {
    return "***";
  }
  return value;
}

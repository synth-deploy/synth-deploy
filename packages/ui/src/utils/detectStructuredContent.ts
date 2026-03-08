/**
 * Heuristically detects whether a text response contains structured content
 * (tables, code blocks, diffs, multi-step lists) that warrants rendering in
 * the split canvas output panel rather than inline in the chat history.
 */
export function detectStructuredContent(text: string): boolean {
  // Markdown table: line starting with |
  if (/^\|.+\|/m.test(text)) return true;
  // Fenced code block
  if (/^```/m.test(text)) return true;
  // Unified diff
  if (/^(\+\+\+|---|@@)/m.test(text)) return true;
  // Numbered multi-step list (3 or more items)
  const numberedItems = text.match(/^\d+\./gm);
  if (numberedItems && numberedItems.length >= 3) return true;
  return false;
}

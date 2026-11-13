/**
 * Compare database IDs that may arrive as numbers (JSON) or strings (URL,
 * notification payloads, localStorage caches). Missing IDs never match.
 */
export function sameId(a, b) {
  if (a == null || b == null) return false
  return String(a).trim() === String(b).trim()
}

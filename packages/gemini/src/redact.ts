/**
 * Redaction layer (spec §21): field-name denylist + basic secret regexes.
 * Applied to anything forwarded to Gemini. Raw payloads are not forwarded
 * by default — query results only, and these still get scrubbed.
 */

const DENYLISTED_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
  "cookie",
  "set-cookie",
]);

const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9\-._~+/]+=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:sk|pk|key|token|secret|password)[_-]?[a-z0-9]{16,}/gi,
];

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, "[REDACTED]");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(record)) {
      out[key] = DENYLISTED_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactValue(v);
    }
    return out;
  }
  return value;
}

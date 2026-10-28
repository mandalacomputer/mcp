/**
 * The platform limits this server mirrors, keyed the way the platform publishes
 * them: by what each number MEANS, in its surface manifest.
 *
 * One module with no imports, on purpose. scripts/check-surface.mjs imports it
 * natively — Node strips the types itself — and compares every entry against
 * the manifest, so a ceiling that moved upstream fails the platform's own CI
 * rather than turning a courtesy refusal into a refusal of a call the platform
 * would have taken. The named constants beside each caller derive from here, so
 * the number is written once and the reason for it stays where it is used.
 *
 * Every manifest limit on a route this server calls is here. The `browser.*`
 * ones are not: their routes are deliberately not exposed as tools.
 */
export const LIMITS = {
  'agent.maxSteps': 100,
  'agent.maxBackgroundSteps': 500,
  'clipboard.writeMaxBytes': 64 * 1024,
  /** Entries in one exec's `env`. */
  'exec.maxEnvEntries': 64,
  /** UTF-8 bytes in one `env` entry, counted as `NAME=value`. */
  'exec.maxEnvEntryBytes': 4096,
  'exec.maxTimeoutSeconds': 600,
  /** UTF-16 code units in a webhook `url`, as submitted — JavaScript's `length`. */
  'webhook.urlMaxChars': 2048,
  'webhook.descriptionMaxChars': 200,
  'webhook.computersMax': 64,
  /** How old a signed delivery may be and still verify; said to receivers. */
  'webhook.replayWindowSeconds': 300,
} as const;

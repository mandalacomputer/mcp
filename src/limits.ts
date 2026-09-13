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
 */
export const LIMITS = {
  'clipboard.writeMaxBytes': 64 * 1024,
  'webhook.descriptionMaxChars': 200,
  'webhook.computersMax': 64,
} as const;

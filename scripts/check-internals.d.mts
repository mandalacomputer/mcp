/**
 * Types for the checker, so the test can import it under `strict` without
 * `allowJs` loosening the build for everything else. Hand-written and tiny on
 * purpose: only the one function a test has any business calling.
 */
export declare function scanText(text: string, label: string, digests: Set<string>): string[];

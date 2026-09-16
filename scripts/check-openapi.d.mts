export const PUBLIC_OPENAPI_URL: string;
export type Operation = { method: string; path: string; segments: string[]; key: string };
export type Contract = { operations: Operation[]; excluded: string[] };
export type Evidence = { tool: string; requests: { method: string; path: string }[] }[];
export function parseOperations(document: unknown): Contract;
export function compareCoverage(
  contract: Contract,
  evidence: Evidence,
): { operations: number; requests: number; tools: number; excluded: string[] };
export class PublicationError extends Error {
  classification: string;
  status?: number;
  constructor(classification: string, status?: number);
}
export function fetchPublishedOpenApi(options?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<{ document: unknown; contract: Contract; digest: string; status: number }>;

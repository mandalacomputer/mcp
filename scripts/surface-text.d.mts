export function balanced(text: string, from: number, open: string, close: string): string;
export function topLevelKeys(body: string): string[];
export function entries(body: string): string[];
export function topLevelField(body: string, name: string): string | undefined;
export function topLevelValueAt(body: string, name: string): number;
export function stripComments(text: string): string;
export function listItems(body: string): string[];
export function objectFields(body: string): Map<string, string>;
export function moduleDeclarations(
  source: string,
  pattern: string,
): { index: number; length: number; groups: string[] }[];
export function stringLiteral(text: string): string | undefined;
export function tableArrayLiteral(text: string, what?: string, projections?: number | null): string;
export function declarationAssignment(source: string, from: number): number;

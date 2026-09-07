export interface Rect { x: number; y: number; width: number; height: number }
export type Model = 'gpt-5.6-sol' | 'gpt-5.6-luna';
export interface InkEmbed {
  start: number;
  end: number;
  line: number;
  raw: string;
  link: string;
  kind: 'inkWriting' | 'inkDrawing';
  viewport?: Rect;
  error?: string;
}
export interface PreparedImage {
  dataUrl: string;
  hash: string;
  viewport: Rect;
  width: number;
  height: number;
}
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface Recognition {
  markdown: string;
  unresolved: string[];
  usage?: Usage;
  responseId?: string;
  latencyMs: number;
}
export interface PairRecord {
  sourceRevision: string;
  generatedHash: string;
  appliedHash: string;
  model: Model;
  promptVersion: string;
  viewport: Rect;
  appliedAt: string;
}
export interface Settings {
  secretName: string;
  model: Model;
  budgetGBP: number;
  otherSpendGBP: number;
  gbpPerUsd: number;
  requestAllowanceGBP: number;
  cacheEnabled: boolean;
}
export interface SpendEntry {
  id: string;
  model: Model;
  startedAt: string;
  reservedGBP: number;
  gbpPerUsd: number;
  state: 'pending' | 'reported' | 'unknown' | 'reconciled';
  usage?: Usage;
  estimatedGBP?: number;
}
export interface PluginData {
  version: 1;
  settings: Settings;
  pairs: Record<string, PairRecord>;
  cache: Record<string, Recognition>;
  spend: SpendEntry[];
}
export const DEFAULT_SETTINGS: Settings = {
  secretName: '', model: 'gpt-5.6-sol', budgetGBP: 10, otherSpendGBP: 0,
  gbpPerUsd: 1, requestAllowanceGBP: 0.5, cacheEnabled: true,
};
export const freshData = (): PluginData => ({
  version: 1, settings: { ...DEFAULT_SETTINGS }, pairs: {}, cache: {}, spend: [],
});

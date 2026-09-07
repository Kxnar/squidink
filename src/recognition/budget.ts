import { SquidError } from '../errors';
import type { Model, PluginData, SpendEntry, Usage } from '../types';

// Published standard-tier token prices checked 2026-09-07; GBP amounts are estimates.
export const PRICE_DATE = '2026-09-07';
const PRICES = { 'gpt-5.6-sol': [4, 0.4, 20], 'gpt-5.6-luna': [0.2, 0.02, 1.2] } as const;
export function estimatedUSD(model: Model, usage: Usage): number {
  const [input, cached, output] = PRICES[model];
  return ((usage.inputTokens - usage.cachedInputTokens) * input + usage.cachedInputTokens * cached + usage.outputTokens * output) / 1_000_000;
}
export function usedGBP(data: PluginData): number {
  return data.settings.otherSpendGBP + data.spend.reduce((sum, item) => sum +
    (item.state === 'reported' || item.state === 'reconciled' ? item.estimatedGBP ?? item.reservedGBP : item.reservedGBP), 0);
}
export function reserve(data: PluginData, model: Model): SpendEntry {
  const s = data.settings;
  if (![s.budgetGBP, s.gbpPerUsd, s.requestAllowanceGBP].every(n => Number.isFinite(n) && n > 0)
    || !Number.isFinite(s.otherSpendGBP) || s.otherSpendGBP < 0) throw new SquidError('Set valid evaluation budget values in Squid settings.', 'budget');
  if (s.requestAllowanceGBP < 0.5 * s.gbpPerUsd) throw new SquidError('Reserve at least US $0.50 per request at your chosen conversion rate.', 'budget');
  if (usedGBP(data) + s.requestAllowanceGBP > s.budgetGBP + 1e-9) {
    throw new SquidError('The evaluation budget has no room for another request allowance. Check usage and unknown charges in settings.', 'budget');
  }
  const entry: SpendEntry = { id: crypto.randomUUID(), model, startedAt: new Date().toISOString(),
    reservedGBP: s.requestAllowanceGBP, gbpPerUsd: s.gbpPerUsd, state: 'pending' };
  data.spend.push(entry);
  return entry;
}
export function report(entry: SpendEntry, usage: Usage): void {
  entry.usage = usage;
  entry.estimatedGBP = estimatedUSD(entry.model, usage) * entry.gbpPerUsd;
  entry.state = 'reported';
}

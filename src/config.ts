import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';

export type ReviewMode = 'advisory' | 'enforce';
export const REVIEW_MODES: readonly ReviewMode[] = ['advisory', 'enforce'];

export interface Config {
  apiKey: string;
  threshold: number;
  // TRUS-2595: advisory (default) reports the score without blocking a merge;
  // enforce makes a below-threshold or unscored PR a failing commit status.
  mode: ReviewMode;
  framework?: string;
  detectPatterns: string[];
  baseUrl: string;
}

export async function readTrustmodelConfig(overrides: Omit<Config, 'threshold' | 'mode'> & { threshold?: number; mode?: string }): Promise<Config> {
  let doc: { detect?: unknown; eval?: { threshold?: unknown; framework?: unknown; mode?: unknown } } = {};
  if (existsSync('.trustmodel.yml')) {
    const raw = readFileSync('.trustmodel.yml', 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new Error('Trust Review configuration is too large.');
    const parsed = yaml.load(raw);
    if (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
      throw new Error('Invalid Trust Review configuration.');
    }
    doc = (parsed || {}) as typeof doc;
  }
  const threshold = overrides.threshold ?? doc.eval?.threshold ?? 65;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
    throw new Error('threshold must be an integer from 1 to 100; the server may enforce a higher minimum.');
  }
  const detectPatterns = overrides.detectPatterns.length ? overrides.detectPatterns : (doc.detect ?? []);
  if (!Array.isArray(detectPatterns) || detectPatterns.some(p => typeof p !== 'string' || p.length > 512)) {
    throw new Error('detect must be an array of file-path patterns.');
  }
  const base = new URL(overrides.baseUrl);
  if (base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)
      || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('base_url must be an HTTPS gateway origin (HTTP is supported only for localhost tests).');
  }
  // Input wins, then .trustmodel.yml, then advisory. The input default is empty
  // so the file can take effect (an input default would always win).
  const mode = overrides.mode || doc.eval?.mode || 'advisory';
  if (typeof mode !== 'string' || !(REVIEW_MODES as readonly string[]).includes(mode)) {
    throw new Error('mode must be advisory or enforce.');
  }
  const framework = overrides.framework || doc.eval?.framework;
  if (framework !== undefined && (typeof framework !== 'string' || framework.length > 64)) throw new Error('Invalid framework.');
  return { ...overrides, baseUrl: base.origin, threshold, framework, detectPatterns, mode: mode as ReviewMode };
}

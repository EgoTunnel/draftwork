// The built-in demo assignment used by "Try it as a student". Its settings are fixed (including the
// nonce), so a visitor's draft survives reloads. Timestamps are simulated in the browser, which is
// only acceptable because it is a test assignment.
import { BROWSER_DEMO_TSA } from './tsa.js';

export const DEMO_CONFIG = Object.freeze({
  v: 1,
  title: 'Demo: A Place That Shaped You',
  nonce: 'd3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0',
  created: '2026-10-15T00:00:00.000Z',
  policy: { paste: 'block', sources_pane: true, words_min: 150, words_max: 600 },
  tsa_url: BROWSER_DEMO_TSA,
  thresholds: {},
  allow_demo_tsa: true,
  ai_disclosure: true,
});

export const isTestAssignment = (config) => !!(config && config.allow_demo_tsa);

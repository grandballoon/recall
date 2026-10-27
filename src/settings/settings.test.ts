/* Reading settings back.
 *
 * `data.json` is a file in the reader's vault that they can edit, that an old
 * build may have written, and that syncs. None of those produce a guaranteed
 * shape, and an unknown model would fail every check with a 404 that reads
 * like a key problem — which is a bad way to find out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MODEL } from '../checker/protocol';
import { DEFAULT_SETTINGS, normaliseSettings } from './settings';

test('a fresh install gets the model the product is designed around', () => {
  assert.deepEqual(normaliseSettings(null), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.model, MODEL);
  assert.equal(DEFAULT_SETTINGS.effort, null, 'no effort sent is the API default');
  assert.equal(DEFAULT_SETTINGS.demoMode, false);
});

test('settings that were saved are read back', () => {
  const settings = normaliseSettings({ model: 'claude-haiku-4-5-20251001', effort: 'low', demoMode: true });

  assert.deepEqual(settings, {
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    demoMode: true,
  });
});

test('a model this build does not offer falls back rather than 404ing every check', () => {
  assert.equal(normaliseSettings({ model: 'claude-2' }).model, MODEL);
  assert.equal(normaliseSettings({ model: 42 }).model, MODEL);
});

test('an effort this build does not send falls back to the default', () => {
  assert.equal(normaliseSettings({ effort: 'extreme' }).effort, null);
  assert.equal(normaliseSettings({ effort: '' }).effort, null);
});

test('demo mode is only on when it says so', () => {
  assert.equal(normaliseSettings({ demoMode: 'yes' }).demoMode, false);
  assert.equal(normaliseSettings({}).demoMode, false);
});

test('the key is not a setting, so it can never reach data.json', () => {
  // Belt and braces: `saveSettings` writes exactly what this returns, so if a
  // key ever appeared in the shape it would sync to every device in plaintext.
  const settings = normaliseSettings({ apiKey: 'sk-ant-should-not-survive', model: MODEL });

  assert.deepEqual(Object.keys(settings).sort(), ['demoMode', 'effort', 'model']);
  assert.equal(JSON.stringify(settings).includes('sk-ant'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../apps/shell/pages.ts';
import { launchBrowser } from './support/browser.mjs';
const option = (value, label) => ({ value, label });
// An invented catalog: the page lists four team roles and two image tools in three groups.
const props = {
  error: '',
  notice: '',
  alerts: [],
  networkMode: 'providers',
  keys: { openai: true, anthropic: false },
  roles: ['primary', 'ui', 'verify', 'escalation'].map((id) => ({
    id,
    label: 'Role ' + id,
    value: 'openai|model-a',
    effort: id === 'escalation' ? 'high' : 'auto',
    options: [option('openai|model-a', 'OpenAI · Model A'), option('anthropic|model-b', 'Anthropic · Model B')],
  })),
  images: ['precise', 'fast'].map((id) => ({
    id,
    label: 'Image ' + id,
    value: 'none',
    options: [option('image-x', 'Image X')],
  })),
  returnTo: '/site/',
  mailWarning: false,
};
test('AI-33: the AI models screen has the settings band, three groups, labels above the fields and model with effort side by side', async () => {
  const html = await renderPage('aiapi', props);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(html);
    assert.deepEqual(await page.locator('legend').allTextContents(), [
      'API klíče',
      'Modely pro tým',
      'Obrazové nástroje',
    ]);
    assert.equal(await page.locator('.settings-nav a[aria-current="page"]').textContent(), 'Modely AI studia');
    assert.equal(await page.locator('select[name^="role_"]').count(), 4);
    assert.equal(await page.locator('select[name^="image_"]').count(), 2);
    assert.equal(await page.locator('select[name=effort_escalation]').inputValue(), 'high');
    assert.equal(await page.locator('select[name=effort_primary] option[value="auto"]').count(), 1);
    // The saved key is never in the page; the field only says it is set.
    assert.equal(await page.locator('input[name=key_openai]').inputValue(), '');
    // Label above, then the model and its reasoning effort on one row.
    const label = await page.locator('label', { has: page.locator('select[name=role_primary]') }).boundingBox(),
      model = await page.locator('select[name=role_primary]').boundingBox(),
      effort = await page.locator('select[name=effort_primary]').boundingBox();
    assert.ok(label && model && effort);
    assert.ok(model.y > label.y + 10);
    assert.ok(Math.abs(model.y - effort.y) < 2 && effort.x >= model.x + model.width);
  } finally {
    await browser.close();
  }
});

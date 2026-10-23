import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../apps/shell/pages.ts';
import { launchBrowser } from './support/browser.mjs';
const option = (value, label) => ({ value, label });
// An invented catalog: the page lists four team roles and two image tools in one team group.
const props = {
  error: '',
  notice: '',
  alerts: [],
  networkMode: 'providers',
  keys: [{ id: 'openai', name: 'OpenAI' }],
  keyError: '',
  teams: [
    { id: 'performance', name: 'Výkonný tým', isDefault: false },
    { id: 'custom-1', name: 'Vlastní tým', isDefault: true },
  ],
  shown: { id: 'custom-1', kind: 'custom', name: 'Vlastní tým', description: '', isDefault: true, source: '' },
  teamNotice: '',
  confirmKey: '',
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
test('AI-33: the AI models screen has the settings band, the keys and one team group with a tab for every team, labels above the fields and model with effort side by side', async () => {
  const html = await renderPage('aiapi', props);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(html);
    assert.deepEqual(await page.locator('legend').allTextContents(), [
      'API klíče',
      'Tým AI',
    ]);
    // The shown custom team is the default one: its tab is current with the default mark, the line says it, it can
    // be renamed and saved but not deleted.
    assert.deepEqual(await page.locator('.team-tabs a[aria-current=page]').allTextContents(), ['Vlastní tým']);
    assert.deepEqual(await page.locator('.team-tabs a[data-default]').allTextContents(), ['Vlastní tým']);
    assert.equal(await page.locator('.team-status span').textContent(), 'Výchozí tým');
    assert.equal(await page.locator('input[name=teamName]').inputValue(), 'Vlastní tým');
    assert.equal(await page.locator('#team-delete').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Uložit', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.settings-nav a[aria-current="page"]').textContent(), 'Modely AI studia');
    assert.equal(await page.locator('select[name^="role_"]').count(), 4);
    assert.equal(await page.locator('select[name^="image_"]').count(), 2);
    assert.equal(await page.locator('select[name=effort_escalation]').inputValue(), 'high');
    assert.equal(await page.locator('select[name=effort_primary] option[value="auto"]').count(), 1);
    // The saved key is never in the page; the field only says it is set.
    assert.equal(await page.locator('input[name=key]').inputValue(), '');
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

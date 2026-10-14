const test = require('node:test');
const assert = require('node:assert');

const { slugify, planCategoryCreate, BUILTIN_LABELS } = require('./categoryRules');

const CUSTOM_ID = /^custom_[a-z0-9]+(?:_[a-z0-9]+)*$/;

test('slugify makes a custom_ id from the label', () => {
  assert.equal(slugify('Pest or sanitation hazard'), 'custom_pest_or_sanitation_hazard');
});

test('slugify never leaves a trailing underscore after the 40-char slice', () => {
  // 39 letters then a space: the slice lands right after the underscore.
  const label = `${'a'.repeat(39)} bcd`;
  const id = slugify(label);
  assert.match(id, CUSTOM_ID);
  assert.ok(!id.endsWith('_'));
});

test('slugify returns empty for a label with no ASCII letters or digits', () => {
  assert.equal(slugify('!!! ???'), '');
  assert.equal(slugify('虫害'), '');
});

test('a label with no slug still gets a valid random id', () => {
  const plan = planCategoryCreate('虫害', [], () => 'abc123');
  assert.equal(plan.action, 'create');
  assert.equal(plan.id, 'custom_abc123');
  assert.match(plan.id, CUSTOM_ID);
});

test('rejects a label equal to a built-in label, ignoring case and spacing', () => {
  const plan = planCategoryCreate(`  ${BUILTIN_LABELS[2].toUpperCase()} `, []);
  assert.equal(plan.status, 400);
  assert.match(plan.error, /built-in/);
});

test('rejects an active category with the same name instead of overwriting it', () => {
  const rows = [{ id: 'custom_pest', label: 'Pest', active: true }];
  const plan = planCategoryCreate('  pest ', rows);
  assert.equal(plan.status, 409);
  assert.match(plan.error, /already exists/);
});

test('revives a retired category with the same name', () => {
  const rows = [{ id: 'custom_pest', label: 'Pest', active: false }];
  assert.deepEqual(planCategoryCreate('Pest', rows), { action: 'revive', id: 'custom_pest' });
});

test('a different label that slugs the same gets its own id', () => {
  const rows = [{ id: 'custom_pest', label: 'Pest!', active: true }];
  const plan = planCategoryCreate('Pest?', rows, () => 'ff00aa');
  assert.equal(plan.action, 'create');
  assert.equal(plan.id, 'custom_pest_ff00aa');
  assert.match(plan.id, CUSTOM_ID);
});

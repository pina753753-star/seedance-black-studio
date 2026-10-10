const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Supabase migration versions are unique', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));
  const versions = new Map();

  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    assert.ok(match, `migration filename must begin with a numeric version: ${file}`);
    const version = match[1];
    assert.equal(
      versions.has(version),
      false,
      `duplicate Supabase migration version ${version}: ${versions.get(version)} and ${file}`
    );
    versions.set(version, file);
  }
});

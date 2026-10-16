// scripts/enrich-ex-demo.mjs
// Enriches real exercises with description, goal, starter code, and
// concepts so the student loop (banner + goal + compare + gate) can
// be demoed end-to-end.

import Database from 'better-sqlite3';
const db = new Database('codeteach.db');

const EXERCISES = {
  'ex-1': {
    title: 'Sum an array',
    description:
      'Loop over the array and print each element on its own line. ' +
      'The program should run without errors.',
    expectedOutput: '6',
    starterCode:
      'const arr = [1, 2, 3];\n' +
      'for (let i = 0; i < arr.length; i++) {\n' +
      '  // your code here\n' +
      '}',
    expectedConcepts: ['for loop', 'array indexing'],
  },
  'ex-demo-1': {
    title: 'Sum an array',
    description:
      'Loop over the array and print each element on its own line. ' +
      'The program should run without errors.',
    expectedOutput: '6',
    starterCode:
      'const arr = [1, 2, 3];\n' +
      'for (let i = 0; i < arr.length; i++) {\n' +
      '  // your code here\n' +
      '}',
    expectedConcepts: ['for loop', 'array indexing'],
  },
};

for (const [slug, data] of Object.entries(EXERCISES)) {
  const row = db.prepare('SELECT id FROM exercises WHERE slug = ?').get(slug);
  if (!row) {
    console.log('[enrich] missing, skipped:', slug);
    continue;
  }
  db.prepare(
    `UPDATE exercises SET
       title = ?, description = ?, starter_code = ?,
       expected_output = ?, expected_concepts = ?,
       updated_at = datetime('now')
     WHERE slug = ?`
  ).run(
    data.title, data.description, data.starterCode,
    data.expectedOutput, JSON.stringify(data.expectedConcepts), slug
  );
  console.log('[enrich] enriched:', slug);
}

// Show what exercises the student's cohort actually has, so we can
// see which ones to point the picker at.
console.log('');
console.log('[enrich] exercises in DB:');
for (const r of db.prepare('SELECT slug, title, expected_output FROM exercises ORDER BY slug').all()) {
  console.log('  ' + r.slug.padEnd(20) + '  goal=' + JSON.stringify(r.expected_output) + '  (' + r.title + ')');
}

db.close();
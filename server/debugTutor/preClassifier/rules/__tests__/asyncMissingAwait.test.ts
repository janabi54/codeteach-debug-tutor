import { RuleTester } from 'eslint';
import { asyncMissingAwait } from '../asyncMissingAwait.js';
const rt = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } } as any);
rt.run('codeteach/async-missing-await', asyncMissingAwait, {
  valid: [
    `async function f() { const x = await fetch(url); }`,
    `function f() { return fetch(url); }`,
    `fetch(url).then(r => r.json());`,
  ],
  invalid: [
    { code: `function f() { fetch(url); }`, errors: [{ message: /looks async but its result is not awaited/ }] },
    { code: `function f() { save(data); }`, errors: [{ message: /save\(\).*not awaited/ }] },
  ],
});

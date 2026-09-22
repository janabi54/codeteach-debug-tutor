import { RuleTester } from 'eslint';
import { mutationInIteration } from '../mutationInIteration.js';
const rt = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } } as any);
rt.run('codeteach/mutation-in-iteration', mutationInIteration, {
  valid: [
    `for (const x of arr) { console.log(x); }`,
    `for (const x of arr) { other.push(x); }`,
    `const evens = arr.filter(x => x % 2 === 0);`,
    `for (const k in obj) { obj[k] = null; }`,
  ],
  invalid: [
    { code: `for (const x of arr) { arr.push(x); }`, errors: [{ message: /is mutated with \.push\(\)/ }] },
    { code: `arr.forEach(x => { arr.pop(); });`, errors: [{ message: /mutated with \.pop/ }] },
  ],
});

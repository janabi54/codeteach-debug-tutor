import { RuleTester } from 'eslint';
import { loopBoundHeuristic } from '../loopBoundHeuristic.js';
const rt = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } } as any);
rt.run('codeteach/loop-bound-heuristic', loopBoundHeuristic, {
  valid: [
    `for (let i = 0; i < arr.length; i++) {}`,
    `for (let i = arr.length - 1; i >= 0; i--) {}`,
    `for (let i = 0; i <= 10; i++) {}`,
    `for (const x of arr) {}`,
    `let i = 0; while (i < arr.length) { i++; }`,
  ],
  invalid: [
    { code: `for (let i = 0; i <= arr.length; i++) {}`, errors: [{ message: /'<=' against \.length/ }] },
    { code: `for (let i = arr.length; i >= arr.length; i--) {}`, errors: [{ message: /'>=' against \.length/ }] },
    { code: `for (let i = 1; i < arr.length; i++) {}`, errors: [{ message: /first element may be skipped/ }] },
    { code: `let i = 0; while (i <= arr.length) { i++; }`, errors: [{ message: /'<=' against \.length/ }] },
  ],
});

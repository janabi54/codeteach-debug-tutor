import { preClassify } from '../index.js';
describe('preClassify (integration)', () => {
  it('detects off-by-one', async () => {
    const r = await preClassify(`const arr = [1,2,3]; for (let i = 0; i <= arr.length; i++) {}`, 'javascript', `TypeError: Cannot read properties of undefined`);
    expect(r.topPattern).toBe('off-by-one');
  });
  it('returns empty for clean code', async () => {
    const r = await preClassify(`function add(a, b) { return a + b; }`, 'javascript', '');
    expect(r.candidates).toHaveLength(0);
  });
  it('does not throw on syntax errors', async () => {
    const r = await preClassify(`for (let i = 0; i <= ; i++) {`, 'javascript', 'SyntaxError');
    expect(Array.isArray(r.candidates)).toBe(true);
  });
});

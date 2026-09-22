import type { Rule } from 'eslint';
const HINTS = /^(fetch|save|load|read|write|get|post|put|delete|request|query)/i;

export const asyncMissingAwait: Rule.RuleModule = {
  meta: { type: 'problem', docs: { description: 'Missing await on async call' } },
  create(context) {
    function handled(node: any): boolean {
      let cur = node;
      while (cur.parent) {
        const p = cur.parent;
        if (p.type === 'AwaitExpression' && p.argument === cur) return true;
        if (p.type === 'ReturnStatement') return true;
        if (p.type === 'MemberExpression' && p.property?.type === 'Identifier' &&
            ['then', 'catch', 'finally'].includes(p.property.name)) return true;
        if (p.type === 'VariableDeclarator' && p.init === cur) { cur = p; continue; }
        if (p.type === 'ExpressionStatement') return false;
        cur = p;
      }
      return false;
    }
    return {
      CallExpression(node: any) {
        const c = node.callee;
        if (c.type !== 'Identifier' || !HINTS.test(c.name)) return;
        if (handled(node)) return;
        context.report({ node, message: `\`${c.name}()\` looks async but its result is not awaited, returned, or .then()'d` });
      },
    };
  },
};

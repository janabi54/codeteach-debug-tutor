import type { Rule } from 'eslint';
const MUT = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']);

export const mutationInIteration: Rule.RuleModule = {
  meta: { type: 'problem', docs: { description: 'Mutation during iteration' } },
  create(context) {
    const getName = (c: any) => c?.type === 'Identifier' ? c.name : null;
    function check(name: string | null, body: any) {
      if (!name || !body) return;
      const visit = (n: any) => {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' &&
            n.callee.object?.type === 'Identifier' && n.callee.object.name === name &&
            n.callee.property?.type === 'Identifier' && MUT.has(n.callee.property.name)) {
          context.report({ node: n, message: `\`${name}\` is mutated with .${n.callee.property.name}() inside a loop over the same collection — may skip elements or loop forever` });
        }
        for (const k of Object.keys(n)) {
          if (k === 'parent') continue;
          const c = (n as any)[k];
          if (Array.isArray(c)) c.forEach(visit);
          else if (c && typeof c === 'object') visit(c);
        }
      };
      visit(body);
    }
    return {
      ForOfStatement(node: any) { check(getName(node.right), node.body); },
      ForInStatement(node: any) { check(getName(node.right), node.body); },
      CallExpression(node: any) {
        if (node.callee?.type === 'MemberExpression' && node.callee.property?.type === 'Identifier' &&
            ['forEach', 'map', 'filter', 'reduce'].includes(node.callee.property.name)) {
          const name = getName(node.callee.object);
          const cb = node.arguments[0];
          if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression'))
            check(name, cb.body);
        }
      },
    };
  },
};

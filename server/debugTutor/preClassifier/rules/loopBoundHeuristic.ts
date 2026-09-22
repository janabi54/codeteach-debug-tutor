import type { Rule } from 'eslint';

export const loopBoundHeuristic: Rule.RuleModule = {
  meta: { type: 'problem', docs: { description: 'Detect likely off-by-one loop bounds' } },
  create(context) {
    const isLen = (n: any) => n?.type === 'MemberExpression' &&
      n.property?.type === 'Identifier' && n.property.name === 'length';
    const isId = (n: any) => n?.type === 'Identifier';
    return {
      ForStatement(node: any) {
        const test = node.test;
        if (!test || test.type !== 'BinaryExpression') return;
        const { operator, left, right } = test;
        if (!['<', '<=', '>', '>='].includes(operator)) return;
        if (operator === '<=' && isId(left) && isLen(right)) {
          context.report({ node: test, message: `Loop condition uses '<=' against .length — reads one past the last valid index` });
          return;
        }
        if (operator === '>=' && isId(left) && isLen(right)) {
          context.report({ node: test, message: `Loop condition uses '>=' against .length — check your boundary` });
          return;
        }
        const init = node.init;
        if (init?.type === 'VariableDeclaration' && init.declarations[0]?.init?.type === 'Literal' &&
            init.declarations[0].init.value === 1 && operator === '<' && isLen(right)) {
          context.report({ node, message: `Loop starts at 1 and stops before .length — first element may be skipped` });
        }
      },
      WhileStatement(node: any) {
        const test = node.test;
        if (test.type !== 'BinaryExpression' || test.operator !== '<=') return;
        const r = test.right;
        if (r.type === 'MemberExpression' && r.property.type === 'Identifier' && r.property.name === 'length') {
          context.report({ node: test, message: `while loop uses '<=' against .length — likely one iteration too many` });
        }
      },
    };
  },
};

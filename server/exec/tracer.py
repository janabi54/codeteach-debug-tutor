"""
Python AST tracer for CodeTeach.

Reads Python source from stdin, writes instrumented source to stdout.
The instrumented source records every iteration of every single-variable
`for` loop, so the runner can reconstruct an execution trace.
"""

import ast
import sys

TRACE_OPEN = '__CT_TRACE__'
TRACE_CLOSE = '__CT_TRACE_END__'


class Tracer(ast.NodeTransformer):
    def visit_For(self, node):
        self.generic_visit(node)

        if not isinstance(node.target, ast.Name):
            return node

        loop_var = node.target.id
        line = node.lineno
        inject_src = (
            f'_CT_TRACE.append({{"line": {line}, '
            f'"loopVar": {loop_var!r}, "value": repr({loop_var})}})'
        )
        inject_node = ast.parse(inject_src).body[0]
        node.body.insert(0, inject_node)
        return node


PRELUDE = 'import sys as _ct_sys, json as _ct_json\n\n_CT_TRACE = []\n'

EPILOGUE = (
    '\nif _CT_TRACE:\n'
    '    _ct_sys.stderr.write('
    + repr(TRACE_OPEN) + ' + _ct_json.dumps(_CT_TRACE) + '
    + repr(TRACE_CLOSE) + ' + "\\n")\n'
)


def instrument(source: str) -> str:
    tree = ast.parse(source)
    tree = Tracer().visit(tree)
    ast.fix_missing_locations(tree)
    instrumented = ast.unparse(tree)
    return PRELUDE + instrumented + '\n' + EPILOGUE


def main():
    source = sys.stdin.read()
    try:
        print(instrument(source))
    except SyntaxError as e:
        sys.stderr.write(f'__CT_SYNTAX_ERROR__{e.lineno}:{e.offset}:{e.msg}\n')
        sys.exit(1)


if __name__ == '__main__':
    main()

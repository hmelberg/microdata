# Kildekode-vakt mot Brython-fellen (verifisert 2026-07-11): en metode som
# refererer en global funksjon med SAMME navn som metoden blir stille en
# no-op i Brython 3.12 (CPython er korrekt, så vanlige tester er blinde).
# Testen bruker ast — den kjører kun i CPython (pytest), aldri i Brython.
import ast, glob, os

BRYTHON_DIR = os.path.join(os.path.dirname(__file__), '..')

def test_no_method_global_name_collisions():
    offenders = []
    for path in sorted(glob.glob(os.path.join(BRYTHON_DIR, '*.py'))):
        with open(path) as f:
            tree = ast.parse(f.read())
        module_funcs = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            for meth in node.body:
                if not isinstance(meth, ast.FunctionDef) or meth.name not in module_funcs:
                    continue
                for sub in ast.walk(meth):
                    if (isinstance(sub, ast.Name) and sub.id == meth.name
                            and isinstance(sub.ctx, ast.Load)):
                        offenders.append('%s: %s.%s' % (
                            os.path.basename(path), node.name, meth.name))
                        break
    assert offenders == [], (
        'Brython-felle: metode refererer global med samme navn som metoden '
        '(stille no-op i Brython) — bruk underscore-alias som i '
        'matplotlib_brython.py: ' + ', '.join(offenders))

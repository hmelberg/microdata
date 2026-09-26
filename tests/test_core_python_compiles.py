"""getInterpreterCorePython() i index.html bygger Pyodide-kjernens Python-kilde
inni en JS-template-literal. Der blir "\\n" en EKTE linjeskift i Python-koden —
et "...\\n) _q"-strengliteral ble dermed en uavsluttet streng og hele
kjerne-initen (Python-modus) feilet (regresjon 2026-09-26). Testen rendrer
templaten med node (ukjente fri navn stubbes) og kompilerer resultatet."""
import ast
import pathlib
import shutil
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent

RENDER_JS = r"""
const fs = require('fs');
const html = fs.readFileSync(process.argv[1], 'utf8');
const start = html.indexOf('    function getInterpreterCorePython(');
if (start < 0) { console.error('fant ikke getInterpreterCorePython'); process.exit(2); }
const retEnd = html.indexOf('\n`;', start);
const end = html.indexOf('\n    }', retEnd) + 6;
const stub = new Proxy({}, {
  has: (t, k) => typeof k === 'string' && !(k in globalThis),
  get: (t, k) => k === Symbol.unscopables ? undefined : (k === 'window' ? {} : (() => '2')),
});
const fn = new Function('__stub', 'with (__stub) {\n' + html.slice(start, end) +
  '\nreturn getInterpreterCorePython;\n}')(stub);
process.stdout.write(fn('null', '/base/', null));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node mangler")
def test_kjerne_python_kompilerer():
    out = subprocess.run(
        ["node", "-e", RENDER_JS, str(ROOT / "index.html")],
        check=True, capture_output=True, text=True,
    ).stdout
    assert "import" in out
    ast.parse(out)

# Persistent Brython execution environment for openstat/safestat.
# Pattern from code2web's brython_shared_module.py; output uses the app's
# stdout embed-marker protocol so buildOutputNodes() renders it unchanged.
import sys, json, traceback
from io import StringIO

_EMBED_S = '__micro_transform_start_'
_EMBED_E = '__micro_transform_end__'

_shared_vars = {}
_last_error = ''

def _fmt(obj):
    """Format one object as output text (embed markers for figures/frames)."""
    if obj is None:
        return ''
    if hasattr(obj, 'to_plotly_json_str'):
        return _EMBED_S + 'figure__' + '\n' + obj.to_plotly_json_str() + '\n' + _EMBED_E
    if hasattr(obj, 'to_html'):
        html = obj.to_html()
        if '<table class=' not in html:
            html = html.replace('<table', '<table class="output-table"', 1)
        return _EMBED_S + 'tablehtml__' + '\n' + html + '\n' + _EMBED_E
    if isinstance(obj, str):
        return obj
    return repr(obj)

def _show(*objs):
    """User-facing show(): print each object in its rendered form."""
    for o in objs:
        print(_fmt(o))

_shared_vars['show'] = _show

def _execute_code(code):
    """Run code in the persistent globals; return output text ('' on error)."""
    global _last_error
    _last_error = ''
    buf = StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        lines = code.rstrip().split(chr(10))
        last_raw = lines[-1] if lines else ''
        last = last_raw.strip()
        result = None
        # Try exec-all-but-last + eval-last so the final expression displays
        # (REPL semantics). Only safe when the last line is top-level (no
        # leading whitespace) — an indented last line belongs to a block
        # (if/for/while/with) and evaling it alone would run it out of
        # context. Fall back to plain exec for statements and indented lines.
        if last and not last.startswith('#') and last_raw[:1] not in (' ', chr(9)):
            try:
                body = compile(chr(10).join(lines[:-1]) or 'pass', '<brython>', 'exec')
                tail = compile(last, '<brython>', 'eval')
                exec(body, _shared_vars)
                result = eval(tail, _shared_vars)
            except SyntaxError:
                exec(compile(code, '<brython>', 'exec'), _shared_vars)
        else:
            exec(compile(code, '<brython>', 'exec'), _shared_vars)
        out = buf.getvalue()
        shown = _fmt(result)
        if shown:
            out = out + ('' if not out or out.endswith(chr(10)) else chr(10)) + shown
        return out
    except Exception:
        _last_error = traceback.format_exc()
        return buf.getvalue()
    finally:
        sys.stdout = old

def _get_last_error():
    return _last_error

def _bind_datasets(spec_json):
    """Bind datasets from JS into user globals. spec: {name: {kind, payload}}.
    kind 'csv' → payload is CSV text; kind 'columns' → payload is {col: [values]}."""
    try:
        import pandas_brython as _pd
        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
        for name, d in spec.items():
            if d['kind'] == 'csv':
                _shared_vars[name] = _pd.read_csv(StringIO(d['payload']))
            else:
                _shared_vars[name] = _pd.DataFrame(d['payload'])
        return ''
    except Exception:
        return traceback.format_exc()

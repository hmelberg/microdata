import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import brython_runner as br

ES = '__micro_transform_start_'
EE = '__micro_transform_end__'

def test_stdout_and_last_expression():
    out = br._execute_code('print("hei")\n1 + 1')
    assert 'hei' in out and '2' in out
    assert br._get_last_error() == ''

def test_state_persists_between_runs():
    br._execute_code('xx = 41')
    out = br._execute_code('xx + 1')
    assert '42' in out

def test_figure_embed_marker():
    br._execute_code('import pandas_brython as pd\nimport plotly_express_brython as pe\n'
                     'df = pd.DataFrame({"x":[1,2],"y":[3,4]})')
    out = br._execute_code('pe.scatter(df, x="x", y="y")')
    assert (ES + 'figure__') in out and EE in out
    payload = out.split(ES + 'figure__')[1].split(EE)[0].strip()
    assert 'data' in json.loads(payload)

def test_dataframe_tablehtml_marker():
    out = br._execute_code('df')
    assert (ES + 'tablehtml__') in out and '<table' in out

def test_show_multiple():
    out = br._execute_code('show(df, "tekst")')
    assert (ES + 'tablehtml__') in out and 'tekst' in out

def test_error_returns_traceback():
    out = br._execute_code('1/0')
    err = br._get_last_error()
    assert 'ZeroDivisionError' in err

def test_bind_datasets_csv_and_columns():
    spec = {'iris': {'kind': 'csv', 'payload': 'a,b\n1,x\n2,y\n'},
            'tall': {'kind': 'columns', 'payload': {'v': [1, 2, 3]}}}
    msg = br._bind_datasets(json.dumps(spec))
    assert msg == ''
    out = br._execute_code('str(len(iris)) + "," + str(len(tall))')
    assert '2,3' in out

def test_indented_last_line_not_evaled_out_of_context():
    # Last physical line is indented (inside the if-block) but is itself a
    # valid expression after .strip() ('y'). Must not be split into
    # exec(body) + eval(tail) — that execs the block without the last line
    # and then evals 'y' at top level, raising a spurious NameError.
    out = br._execute_code('if False:\n    y = 99\n    y')
    assert br._get_last_error() == ''
    assert out == ''

def test_indented_last_line_in_for_loop_not_displayed():
    br._execute_code('nums_rt = {"a": 10, "b": 30}')
    out = br._execute_code('for k_rt in nums_rt:\n    v_rt = nums_rt[k_rt]\n    v_rt')
    assert br._get_last_error() == ''
    assert '30' not in out

if __name__ == '__main__':
    # NOTE: iterate in declaration order (not sorted alphabetically) — several
    # tests share state via module globals (e.g. test_figure_embed_marker
    # defines `df`, which test_dataframe_tablehtml_marker and test_show_multiple
    # consume). CPython 3.7+ guarantees globals() preserves definition order.
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)

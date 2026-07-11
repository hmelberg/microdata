import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import matplotlib_brython as plt

ES = '__micro_transform_start_'
EE = '__micro_transform_end__'


def setup_function(_fn):
    plt.figure()   # nullstiller modulstaten mellom tester


def test_plot_x_y_builds_line_trace():
    plt.plot([1, 2, 3], [4, 5, 6])
    fig = plt.gcf()
    assert len(fig.data) == 1
    t = fig.data[0]
    assert t['type'] == 'scatter' and t['mode'] == 'lines'
    assert t['x'] == [1, 2, 3] and t['y'] == [4, 5, 6]
    assert t['line']['color'] == '#1f77b4'          # C0 i tab10-syklusen

def test_plot_y_only_gets_index_x():
    plt.plot([10, 20, 30])
    t = plt.gcf().data[0]
    assert t['x'] == [0, 1, 2] and t['y'] == [10, 20, 30]

def test_plot_fmt_string_color_marker_dash():
    plt.plot([1, 2], [3, 4], 'ro--')
    t = plt.gcf().data[0]
    assert t['line']['color'] == 'red'
    assert t['line']['dash'] == 'dash'
    assert t['mode'] == 'lines+markers'
    assert t['marker']['symbol'] == 'circle'

def test_plot_repeated_triples_and_color_cycle():
    plt.plot([1, 2], [3, 4], [1, 2], [5, 6])
    fig = plt.gcf()
    assert len(fig.data) == 2
    assert fig.data[0]['line']['color'] == '#1f77b4'
    assert fig.data[1]['line']['color'] == '#ff7f0e'  # C1

def test_labels_and_title():
    plt.plot([1], [1])
    plt.title('Tittel')
    plt.xlabel('X-akse')
    plt.ylabel('Y-akse')
    lay = plt.gcf().layout
    assert lay['title'] == {'text': 'Tittel'}
    assert lay['xaxis']['title'] == {'text': 'X-akse'}
    assert lay['yaxis']['title'] == {'text': 'Y-akse'}

def test_figure_figsize_inches_to_px():
    plt.figure(figsize=(7, 4))
    lay = plt.gcf().layout
    assert lay['width'] == 700 and lay['height'] == 400

def test_show_prints_embed_marker_and_resets(capsys):
    plt.plot([1, 2], [3, 4])
    plt.show()
    out = capsys.readouterr().out
    assert (ES + 'figure__') in out and EE in out
    payload = out.split(ES + 'figure__')[1].split(EE)[0].strip()
    spec = json.loads(payload)
    assert spec['data'][0]['y'] == [3, 4]
    assert spec['layout']['showlegend'] is False      # ingen legend() kalt
    plt.show()                                        # tom stat → ingenting
    assert capsys.readouterr().out == ''

def test_values_accepts_range_and_duck_typed_series():
    class FakeSeries:                                  # pandas_brython-duck
        def tolist(self):
            return [7, 8]
    plt.plot(range(2), FakeSeries())
    t = plt.gcf().data[0]
    assert t['x'] == [0, 1] and t['y'] == [7, 8]

def test_gcf_returns_live_current_figure():
    plt.plot([1], [1])
    fig = plt.gcf()
    fig.update_layout(xaxis_title='Levende')   # PlotlyFigure-mutatorer virker på gjeldende figur
    assert plt.gcf().layout['xaxis']['title'] == 'Levende'

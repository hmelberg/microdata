import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pytest
import matplotlib_brython as plt
import seaborn_brython as sns

DF = {
    'alder':   [25.0, 32.0, 41.0, 28.0, 55.0, 47.0],
    'inntekt': [420.0, 500.0, 610.0, 455.0, 720.0, 650.0],
    'region':  ['N', 'S', 'N', 'S', 'N', 'S'],
}


def setup_function(_fn):
    plt.figure()


def test_scatterplot_draws_into_current_figure():
    sns.scatterplot(data=DF, x='alder', y='inntekt')
    fig = plt.gcf()
    assert len(fig.data) == 1
    assert fig.data[0]['type'] == 'scatter'
    assert fig.data[0]['x'] == DF['alder']

def test_scatterplot_hue_gives_groups_and_legend():
    sns.scatterplot(data=DF, x='alder', y='inntekt', hue='region')
    fig = plt.gcf()
    assert len(fig.data) == 2                      # én trace per region
    names = {t.get('name') for t in fig.data}
    assert names == {'N', 'S'}
    assert fig.layout['showlegend'] is True

def test_axis_titles_from_pe_layout_not_overwriting():
    plt.xlabel('Egen tittel')
    sns.scatterplot(data=DF, x='alder', y='inntekt')
    lay = plt.gcf().layout
    assert lay['xaxis']['title'] == {'text': 'Egen tittel'}   # min vinner

def test_composes_with_plt(capsys):
    sns.lineplot(data=DF, x='alder', y='inntekt')
    plt.title('Kombinert')
    plt.show()
    out = capsys.readouterr().out
    assert 'figure__' in out and 'Kombinert' in out

def test_regplot_adds_trend_trace():
    sns.regplot(data=DF, x='alder', y='inntekt')
    fig = plt.gcf()
    assert len(fig.data) >= 2                      # punkter + OLS-linje
    modes = [t.get('mode', '') for t in fig.data]
    assert any('lines' in m for m in modes)

def test_vectors_directly_without_data():
    sns.scatterplot(x=[1.0, 2.0, 3.0], y=[2.0, 4.0, 6.0])
    assert plt.gcf().data[0]['y'] == [2.0, 4.0, 6.0]

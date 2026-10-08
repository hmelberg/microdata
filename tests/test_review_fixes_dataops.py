"""Regresjonstester for review-funn i dataoperasjonene:

D1  merge … into: navnekollisjon (x_x/x_y), ikke-unik kildenøkkel,
    nøkkel-dtype-mismatch ("0301" mot 301).
D2  collapse/aggregate (p25)/(p75) og øvrige dokumenterte statistikker.
D3  polars keep/drop: betingelsen før kolonnefilteret; drop beholder null.
D4  reshape-from-panel: ingen panel@date-søppelkolonner, ingen tapte enheter.
"""
import numpy as np
import pandas as pd
import pytest

import m2py
from m2py_runtime import pandas_ops as ops


@pytest.fixture(autouse=True)
def _disclosure_off(monkeypatch):
    monkeypatch.setattr(m2py, "M2PY_DISCLOSURE_CONTROL", "0", raising=False)


def _interp(datasets, active):
    it = m2py.MicroInterpreter(metadata_path=None)
    for k, v in datasets.items():
        it.datasets[k] = v.copy()
    it.active_name = active
    return it


def _log(it):
    return "\n".join(str(m) for m in it.output_log)


# ── D1: merge … into ────────────────────────────────────────────────────────

def _persons():
    return pd.DataFrame({"PERSONID_1": [1, 2, 3, 4],
                         "kommune": ["0301", "0301", "1103", "5001"],
                         "x": [1.0, 2, 3, 4]})


def test_merge_into_existing_variable_is_error_not_suffix():
    k = pd.DataFrame({"kommune": ["0301", "1103"], "x": [9.0, 8], "snitt": [1.5, 3.0]})
    it = _interp({"p": _persons(), "k": k}, "k")
    it.run_script("merge snitt x into p on kommune")
    out = it.datasets["p"]
    assert "x_x" not in out.columns and "x_y" not in out.columns
    assert "FEIL" in _log(it) and "'x'" in _log(it)
    # målet er urørt
    assert out["x"].tolist() == [1.0, 2, 3, 4]
    assert "snitt" not in out.columns


def test_merge_into_non_unique_source_key_is_error():
    k = pd.DataFrame({"kommune": ["0301", "1103", "1103"], "snitt": [1.5, 3.0, 99.0]})
    it = _interp({"p": _persons(), "k": k}, "k")
    it.run_script("merge snitt into p on kommune")
    assert "FEIL" in _log(it) and "unik" in _log(it)
    assert "snitt" not in it.datasets["p"].columns


def test_merge_into_duplicate_source_rows_with_identical_values_ok():
    # Duplikater med identiske verdier er entydige — ingen stille valg.
    k = pd.DataFrame({"kommune": ["0301", "1103", "1103"], "snitt": [1.5, 3.0, 3.0]})
    it = _interp({"p": _persons(), "k": k}, "k")
    it.run_script("merge snitt into p on kommune")
    assert "FEIL" not in _log(it)
    assert it.datasets["p"]["snitt"].tolist()[:3] == [1.5, 1.5, 3.0]


@pytest.mark.parametrize("src_key", [[301, 1103], [301.0, 1103.0]])
def test_merge_into_string_vs_int_kommune_key(src_key):
    k = pd.DataFrame({"kommune": src_key, "snitt": [1.5, 3.0]})
    it = _interp({"p": _persons(), "k": k}, "k")
    it.run_script("merge snitt into p on kommune")
    out = it.datasets["p"]
    assert "FEIL" not in _log(it), _log(it)
    assert out["kommune"].tolist() == ["0301", "0301", "1103", "5001"]  # målets nøkkel urørt
    s = out["snitt"].tolist()
    assert s[:3] == [1.5, 1.5, 3.0] and np.isnan(s[3])


def test_merge_into_int_target_string_source_key():
    p = _persons().assign(kommune=[301, 301, 1103, 5001])
    k = pd.DataFrame({"kommune": ["0301", "1103"], "snitt": [1.5, 3.0]})
    it = _interp({"p": p, "k": k}, "k")
    it.run_script("merge snitt into p on kommune")
    assert "FEIL" not in _log(it), _log(it)
    assert it.datasets["p"]["snitt"].tolist()[:3] == [1.5, 1.5, 3.0]


def test_pandas_ops_merge_into_same_semantics():
    k = pd.DataFrame({"kommune": [301, 1103], "x": [9.0, 8], "snitt": [1.5, 3.0]})
    with pytest.raises(ValueError):
        ops.merge_into(_persons(), k, ["snitt", "x"], "kommune", "kommune")
    k2 = pd.DataFrame({"kommune": [301, 1103, 1103], "snitt": [1.5, 3.0, 99.0]})
    with pytest.raises(ValueError):
        ops.merge_into(_persons(), k2, ["snitt"], "kommune", "kommune")
    out = ops.merge_into(_persons(), k, ["snitt"], "kommune", "kommune")
    assert out["snitt"].tolist()[:3] == [1.5, 1.5, 3.0]


# ── D2: collapse/aggregate-statistikker ─────────────────────────────────────

def _stat_df():
    return pd.DataFrame({"x": [1.0, 2, 3, 4, 5, 6, 7, 8], "g": [1, 1, 1, 1, 2, 2, 2, 2]})


@pytest.mark.parametrize("cmd", ["collapse", "aggregate"])
def test_p25_p75_supported(cmd):
    it = _interp({"d": _stat_df()}, "d")
    it.run_script(f"{cmd} (p25) x -> a (p75) x -> b, by(g)")
    assert "FEIL" not in _log(it), _log(it)
    out = it.datasets["d"].drop_duplicates("g").sort_values("g")
    assert out["a"].tolist() == [1.75, 5.75]
    assert out["b"].tolist() == [3.25, 7.25]


@pytest.mark.parametrize("stat", ["count", "sum", "mean", "sd", "median", "min",
                                  "max", "p25", "p75", "gini", "iqr", "percent",
                                  "semean", "sebinomial"])
def test_all_documented_collapse_stats_run(stat):
    it = _interp({"d": _stat_df()}, "d")
    it.run_script(f"collapse ({stat}) x -> s, by(g)")
    assert "FEIL" not in _log(it), _log(it)
    assert len(it.datasets["d"]) == 2


def test_pandas_ops_collapse_p25():
    out = ops.collapse(_stat_df(), [{"stat": "p25", "src": "x", "target": "a"}], by="g")
    assert out["a"].tolist() == [1.75, 5.75]


# ── D3: polars keep/drop ────────────────────────────────────────────────────

def _cond_df():
    return pd.DataFrame({"x": [1, 2, 3, 4], "y": [1.0, 0.0, np.nan, 1.0]})


def test_polars_keep_condition_on_dropped_column():
    pl = pytest.importorskip("polars")
    from m2py_runtime import polars_ops as po
    out = po.keep(pl.from_pandas(_cond_df()).lazy(), ["x"], "y == 1").collect()
    assert out.columns == ["x"] and out["x"].to_list() == [1, 4]


def test_polars_drop_condition_on_dropped_column():
    pl = pytest.importorskip("polars")
    from m2py_runtime import polars_ops as po
    out = po.drop(pl.from_pandas(_cond_df()).lazy(), ["y"], "y == 1").collect()
    assert out.columns == ["x"] and out["x"].to_list() == [2, 3]


def test_polars_drop_keeps_null_rows_like_pandas():
    pl = pytest.importorskip("polars")
    from m2py_runtime import polars_ops as po
    out = po.drop(pl.from_pandas(_cond_df()).lazy(), None, "y > 0").collect()
    ref = ops.drop(_cond_df(), None, "y > 0")
    assert out["x"].to_list() == ref["x"].tolist() == [2, 3]


@pytest.mark.parametrize("stat", ["p25", "p75", "iqr", "gini", "percent"])
def test_polars_collapse_extra_stats_match_pandas(stat):
    pl = pytest.importorskip("polars")
    from m2py_runtime import polars_ops as po
    targets = [{"stat": stat, "src": "x", "target": "s"}]
    out = po.collapse(pl.from_pandas(_stat_df()).lazy(), targets, by="g").collect()
    out = out.to_pandas().sort_values("g").reset_index(drop=True)
    ref = ops.collapse(_stat_df(), targets, by="g").sort_values("g").reset_index(drop=True)
    assert np.allclose(out["s"].to_numpy(float), ref["s"].to_numpy(float))


@pytest.mark.parametrize("stat", ["p25", "p75", "iqr"])
def test_polars_aggregate_extra_stats_match_pandas(stat):
    pl = pytest.importorskip("polars")
    from m2py_runtime import polars_ops as po
    targets = [{"stat": stat, "src": "x", "target": "s"}]
    out = po.aggregate(pl.from_pandas(_stat_df()).lazy(), targets, by="g").collect().to_pandas()
    ref = ops.aggregate(_stat_df(), targets, by="g")
    assert np.allclose(out["s"].to_numpy(float), ref["s"].to_numpy(float))


# ── D4: reshape-from-panel ──────────────────────────────────────────────────

def _wide():
    return pd.DataFrame({"PERSONID_1": [1, 2, 3], "lonn2014": [10.0, np.nan, 30],
                         "lonn2018": [11.0, np.nan, np.nan]})


def test_reshape_from_panel_no_panel_date_columns_and_keeps_entities():
    it = _interp({"d": _wide()}, "d")
    it.run_script("reshape-to-panel lonn\nreshape-from-panel")
    out = it.datasets["d"]
    assert "FEIL" not in _log(it), _log(it)
    assert not any(c.startswith("panel@date") for c in out.columns)
    assert sorted(out.columns) == ["PERSONID_1", "lonn2014", "lonn2018"]
    assert out["PERSONID_1"].tolist() == [1, 2, 3]      # person 2 (bare NaN) beholdes


def test_reshape_from_panel_keeps_all_nan_year_column():
    wide = pd.DataFrame({"PERSONID_1": [1, 2], "lonn2014": [10.0, 20.0],
                         "lonn2018": [np.nan, np.nan]})
    it = _interp({"d": wide}, "d")
    it.run_script("reshape-to-panel lonn\nreshape-from-panel")
    out = it.datasets["d"]
    assert "lonn2018" in out.columns and out["lonn2018"].isna().all()


def test_reshape_from_panel_invariant_column_is_time_suffixed_like_manual():
    # microdata.no-manualens eksempel 2.13 gjør `drop kjonn20; rename kjonn19
    # kjonn` etter reshape-from-panel: tidsinvariante kolonner FÅR tidssuffiks.
    wide = _wide().assign(kjonn=[1, 2, 1])
    it = _interp({"d": wide}, "d")
    it.run_script("reshape-to-panel lonn\nreshape-from-panel")
    out = it.datasets["d"]
    assert {"kjonn2014", "kjonn2018"} <= set(out.columns)


def test_pandas_ops_reshape_from_panel_same():
    long = ops.reshape_to_panel(_wide(), ["lonn"])
    out = ops.reshape_from_panel(long)
    assert sorted(out.columns) == ["PERSONID_1", "lonn2014", "lonn2018"]
    assert out["PERSONID_1"].tolist() == [1, 2, 3]

"""Review-fikser: tabulate summarize()/missing (C1), T6-omgåelse (C2) og
T5 for summarize() basert på bidragsytende enheter (C3)."""
import os
import sys
import warnings

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
warnings.filterwarnings("ignore")

import m2py  # noqa: E402
from m2py import MicroInterpreter, StatsEngine  # noqa: E402


@pytest.fixture
def dc_off(monkeypatch):
    monkeypatch.setattr(m2py, "M2PY_DISCLOSURE_CONTROL", "0", raising=False)


@pytest.fixture
def dc_on(monkeypatch):
    monkeypatch.setattr(m2py, "M2PY_DISCLOSURE_CONTROL", "1", raising=False)


def _small_df():
    return pd.DataFrame({
        "g": [1, 1, 2, 2, np.nan, np.nan],
        "h": [1, 2, 1, 2, 1, 2],
        "y": [1., 2, 3, 4, 100, 200],
    })


def _run(df, *lines):
    it = MicroInterpreter(metadata_path=None)
    it.datasets["d"] = df.copy()
    it.active_name = "d"
    it.run_script("\n".join(lines))
    out = "\n".join(str(m) for m in it.output_log)
    return it, out


def _has_nan_label(index):
    return any(isinstance(v, float) and np.isnan(v) for v in index)


# ---------------------------------------------------------------------------
# C1: tabulate ..., summarize() og missing
# ---------------------------------------------------------------------------

class TestSummarizeMissing:
    def test_oneway_without_missing_hides_nan_group_and_total(self, dc_off):
        tb = StatsEngine().execute("tabulate", _small_df(), ["g"], {"summarize": "y"})
        assert not _has_nan_label(tb.index)
        assert tb["Total"] == pytest.approx(2.5)

    def test_oneway_with_missing_shows_nan_group(self, dc_off):
        tb = StatsEngine().execute("tabulate", _small_df(), ["g"],
                                   {"summarize": "y", "missing": True})
        assert _has_nan_label(tb.index)
        nan_lbl = [v for v in tb.index if isinstance(v, float) and np.isnan(v)][0]
        assert tb[nan_lbl] == pytest.approx(150.0)
        assert tb["Total"] == pytest.approx(310 / 6)

    def test_oneway_multi_var_without_missing(self, dc_off):
        tb = StatsEngine().execute("tabulate", _small_df(), ["g"], {"summarize": "y,h"})
        assert not _has_nan_label(tb.index)
        assert tb.loc["Total", "y"] == pytest.approx(2.5)

    def test_oneway_sum_total_matches_displayed_rows(self, dc_off):
        tb = StatsEngine().execute("tabulate", _small_df(), ["g"],
                                   {"summarize": "y", "sum": True})
        assert tb["Total"] == pytest.approx(10.0)

    def test_twoway_summarize_missing_margins(self, dc_off):
        tb = StatsEngine().execute("tabulate", _small_df(), ["g", "h"],
                                   {"summarize": "y", "missing": True})
        nan_lbl = [v for v in tb.index if isinstance(v, float) and np.isnan(v)][0]
        assert tb.loc[nan_lbl, "Total"] == pytest.approx(150.0)
        assert tb.loc["Total", "Total"] == pytest.approx(310 / 6)
        assert tb.loc["Total", 1] == pytest.approx(104 / 3)

    def test_twoway_summarize_without_missing(self, dc_off):
        tb = StatsEngine().execute("tabulate", _small_df(), ["g", "h"], {"summarize": "y"})
        assert not _has_nan_label(tb.index)
        assert tb.loc["Total", "Total"] == pytest.approx(2.5)


class TestTwowayMissingMargins:
    def test_counts_nan_row_total(self, dc_off):
        ct = StatsEngine().execute("tabulate", _small_df(), ["g", "h"], {"missing": True})
        nan_lbl = [v for v in ct.index if isinstance(v, float) and np.isnan(v)][0]
        assert ct.loc[nan_lbl, "Total"] == 2
        assert ct.loc["Total", "Total"] == 6

    def test_rowpct_missing_uses_total_label(self, dc_off):
        ct = StatsEngine().execute("tabulate", _small_df(), ["g", "h"],
                                   {"missing": True, "rowpct": True})
        assert "Total" in ct.index
        assert "All" not in ct.index

    def test_counts_without_missing_unchanged(self, dc_off):
        ct = StatsEngine().execute("tabulate", _small_df(), ["g", "h"], {})
        assert not _has_nan_label(ct.index)
        assert ct.loc["Total", "Total"] == 4


# ---------------------------------------------------------------------------
# C2: T6 kan ikke omgås med prefix() eller replace på ny variabel
# ---------------------------------------------------------------------------

def _t6_df():
    return pd.DataFrame({
        "x": np.r_[np.arange(3.), np.full(2000, 50.)],
        "g": np.r_[[1, 1, 1], np.full(2000, 2)],
    })


class TestT6Bypass:
    def test_recode_inplace_blocked(self, dc_on):
        it, out = _run(_t6_df(), "recode x (0/2 = 99)")
        assert "FEIL" in out

    def test_recode_prefix_blocked(self, dc_on):
        it, out = _run(_t6_df(), "recode x (0/2 = 99), prefix(n_)")
        assert "FEIL" in out
        assert "n_x" not in it.datasets["d"].columns

    def test_recode_prefix_many_rows_ok(self, dc_on):
        it, out = _run(_t6_df(), "recode x (0/2 = 99) (50 = 1), prefix(n_)")
        assert "FEIL" not in out
        assert "n_x" in it.datasets["d"].columns

    def test_replace_new_column_blocked(self, dc_on):
        it, out = _run(_t6_df(), "replace newv = 1 if x < 3")
        assert "FEIL" in out
        assert "newv" not in it.datasets["d"].columns

    def test_replace_new_column_all_rows_ok(self, dc_on):
        it, out = _run(_t6_df(), "replace newv = 1")
        assert "FEIL" not in out
        assert it.datasets["d"]["newv"].notna().all()

    def test_dc_off_allows_small_prefix_recode(self, dc_off):
        it, out = _run(_t6_df(), "recode x (0/2 = 99), prefix(n_)")
        assert "FEIL" not in out
        assert "n_x" in it.datasets["d"].columns


# ---------------------------------------------------------------------------
# C3: T5 for summarize() teller enheter med verdi, ikke rader
# ---------------------------------------------------------------------------

class TestT5SummarizeNotna:
    def _df(self):
        rng = np.random.default_rng(0)
        x = np.r_[[61.37], [np.nan] * 19, [42.0], [np.nan] * 19, rng.normal(50, 10, 2000)]
        g = np.r_[[1] * 20, [3] * 20, [2] * 2000]
        return pd.DataFrame({"x": x, "g": g})

    def test_blocks_when_cells_have_few_values(self, dc_on):
        with pytest.raises(ValueError):
            StatsEngine().execute("tabulate", self._df(), ["g"], {"summarize": "x"})

    def test_plain_tabulate_still_ok(self, dc_on):
        # Frekvenstabellen teller rader — 20/20/2000 er ingen små celler.
        StatsEngine().execute("tabulate", self._df(), ["g"], {})

    def test_dc_off_not_blocked(self, dc_off):
        StatsEngine().execute("tabulate", self._df(), ["g"], {"summarize": "x"})


# ---------------------------------------------------------------------------
# C3b: per-celle-undertrykkelse av små celler (DC på), i tillegg til >50 %-regelen
# ---------------------------------------------------------------------------

def _is_nan(v):
    try:
        return bool(pd.isna(v))
    except (TypeError, ValueError):
        return False


def _lines_safe(tb):
    """Ingen rad/kolonne (inkl. marginer) har nøyaktig én undertrykt celle."""
    if isinstance(tb, pd.Series):
        return int(tb.isna().sum()) != 1
    m = tb.isna().to_numpy()
    return all(int(r.sum()) != 1 for r in m) and all(int(c.sum()) != 1 for c in m.T)


def _freq_df(counts):
    rows = []
    for k, n in counts.items():
        rows += [k] * n
    return pd.DataFrame({"g": rows})


def _t18_df():
    x = np.r_[[61.37], [np.nan] * 19, np.random.default_rng(0).normal(50, 10, 2000)]
    return pd.DataFrame({"x": x, "g": np.r_[[1] * 20, [2] * 2000]})


class TestCellSuppression:
    def test_t18_two_groups_value_not_shown(self, dc_on):
        tb = StatsEngine().execute("tabulate", _t18_df(), ["g"], {"summarize": "x"})
        assert _is_nan(tb[1])
        assert not any(np.isclose(v, 61.37) for v in tb.dropna().to_numpy())
        # Total + én synlig gruppe ville avslørt gruppe 1 → sekundærundertrykkelse
        assert _is_nan(tb[2])
        assert _lines_safe(tb)

    def test_t18_via_interpreter(self, dc_on):
        _, out = _run(_t18_df(), "tabulate g, summarize(x)")
        assert "61.37" not in out
        assert "FEIL" not in out

    def test_oneway_single_small_gets_secondary(self, dc_on):
        tb = StatsEngine().execute("tabulate", _freq_df({1: 3, 2: 100, 3: 200}), ["g"], {})
        assert _is_nan(tb[1]) and _is_nan(tb[2])
        assert tb[3] == 200 and tb["Total"] == 303

    def test_oneway_two_small_no_secondary(self, dc_on):
        tb = StatsEngine().execute("tabulate", _freq_df({1: 3, 2: 4, 3: 100, 4: 200}), ["g"], {})
        assert _is_nan(tb[1]) and _is_nan(tb[2])
        assert tb[3] == 100 and tb[4] == 200 and tb["Total"] == 307

    def test_oneway_pct_suppressed(self, dc_on):
        tb = StatsEngine().execute("tabulate", _freq_df({1: 3, 2: 100, 3: 200}), ["g"],
                                   {"rowpct": True})
        assert _is_nan(tb[1]) and _is_nan(tb[2])

    def _twoway_df(self):
        cells = {(1, 1): 3, (1, 2): 50, (1, 3): 60, (2, 1): 40, (2, 2): 50, (2, 3): 60,
                 (3, 1): 70, (3, 2): 80, (3, 3): 90}
        g, h = [], []
        for (a, b), n in cells.items():
            g += [a] * n
            h += [b] * n
        return pd.DataFrame({"g": g, "h": h})

    def test_twoway_counts_suppressed_and_lines_safe(self, dc_on):
        ct = StatsEngine().execute("tabulate", self._twoway_df(), ["g", "h"], {})
        assert _is_nan(ct.loc[1, 1])
        assert _lines_safe(ct)
        assert ct.loc["Total", "Total"] == 503
        assert ct.loc[3, 3] == 90

    def test_twoway_pct_variants_suppressed(self, dc_on):
        for opt in ("rowpct", "colpct", "cellpct"):
            ct = StatsEngine().execute("tabulate", self._twoway_df(), ["g", "h"], {opt: True})
            assert _is_nan(ct.loc[1, 1]), opt

    def test_twoway_zero_cells_not_suppressed(self, dc_on):
        df = pd.DataFrame({"g": [1] * 100 + [2] * 100, "h": [1] * 100 + [2] * 100})
        ct = StatsEngine().execute("tabulate", df, ["g", "h"], {})
        assert ct.loc[1, 2] == 0 and ct.loc[1, 1] == 100

    def test_twoway_summarize_uses_notna_counts(self, dc_on):
        df = self._twoway_df()
        df["y"] = 1.0
        # celle (3,3): 90 rader, men bare 2 med verdi
        idx = df.index[(df.g == 3) & (df.h == 3)]
        df.loc[idx[2:], "y"] = np.nan
        tb = StatsEngine().execute("tabulate", df, ["g", "h"], {"summarize": "y"})
        assert _is_nan(tb.loc[3, 3])
        assert _lines_safe(tb)

    def test_dc_off_unchanged(self, dc_off):
        tb = StatsEngine().execute("tabulate", _freq_df({1: 3, 2: 100, 3: 200}), ["g"], {})
        assert tb[1] == 3 and tb[2] == 100
        ct = StatsEngine().execute("tabulate", self._twoway_df(), ["g", "h"], {})
        assert ct.loc[1, 1] == 3

    def test_tabulate_panel_suppressed(self, dc_on):
        df = pd.DataFrame({"g": [1] * 3 + [2] * 100 + [3] * 100 + [1] * 50 + [2] * 50 + [3] * 50,
                           "tid": [2020] * 203 + [2021] * 150})
        ct = StatsEngine().execute("tabulate-panel", df, ["g"], {})
        assert _is_nan(ct.loc[1, 2020])
        assert ct.loc[3, 2021] == 50

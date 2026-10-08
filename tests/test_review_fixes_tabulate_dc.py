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

"""FHI-databankene (no.fhi.npr:1, no.fhi.kreftregisteret:1) i emulatoren.

Dekker enhetsstruktur (episode/prosedyre/krefttilfelle → person), konsistente
avledede verdier (år/datoer), values()/values_from() ved import, og at kjønn
er en fast egenskap per person.
"""
from pathlib import Path

import numpy as np
import pytest

from m2py import MicroInterpreter

META = str(Path(__file__).resolve().parent.parent / "variable_metadata.json")


def _run(script):
    it = MicroInterpreter(metadata_path=META)
    out = str(it.run_script(script))
    return it, out


HEADER = "require no.ssb.fdb:53 as db\nrequire no.fhi.npr:1 as dnpr\nrequire no.fhi.kreftregisteret:1 as krg\n"


def test_catalog_has_fhi_entries_with_databank_and_entity():
    it = MicroInterpreter(metadata_path=META)
    cat = it.data_engine.catalog
    assert cat["SOM_EP_HOVEDTILSTAND1"]["databank"] == "no.fhi.npr"
    assert cat["SOM_EP_HOVEDTILSTAND1"]["entity_type"] == "npr_episode"
    assert cat["SOM_PROS_PROSEDYREKODE"]["entity_type"] == "npr_prosedyre"
    assert cat["S_TOPOGRAFIICD10"]["entity_type"] == "krg_krefttilfelle"
    # De gamle DRAFT-variablene er borte fra den publiserte katalogen (emulatoren
    # beholder dem bare som innebygd reserve for eldre scripts).
    import json
    published = json.loads(Path(META).read_text(encoding="utf-8"))["variables"]
    assert "NPRID" not in published and "AGGRSHOPPID" not in published
    assert not any(str(v.get("databank", "")).endswith(":DRAFT") for v in published.values())


def test_values_filter_year_and_consistent_dates():
    it, out = _run(HEADER + """
create-dataset ep
import dnpr/SOM_EP_AAR as aar, values("2023")
import dnpr/SOM_EP_INNDATO as inn
import dnpr/SOM_EP_UTDATO as ut
import dnpr/SOM_EP_OMSORGSNIVA as oms
generate innaar = year(inn)
generate los = ut - inn
""")
    assert "FEIL" not in out
    df = it.datasets["ep"]
    assert len(df) > 0
    assert set(df["aar"]) == {"2023"}
    assert set(df["innaar"].astype(int)) == {2023}
    assert (df["los"] >= 0).all()
    # Bare døgnopphold (omsorgsnivå 1) har liggetid > 0.
    assert (df.loc[df["oms"] != "1", "los"] == 0).all()


def test_values_strips_quotes_on_ssb_import():
    it, out = _run(HEADER + """
create-dataset kom
import db/BEFOLKNING_KOMMNR_FORMELL 2022-01-01 as k, values("0301", "4601")
""")
    df = it.datasets["kom"]
    assert len(df) > 0
    assert set(df["k"]) <= {"0301", "4601"}


def test_person_ref_import_equals_ref_column_and_values_from_filters():
    it, out = _run(HEADER + """
create-dataset menn
import db/BEFOLKNING_KJOENN as kjonn, values("1")
create-dataset ep
import dnpr/SOM_EP_PERSONID as pid, values_from(menn)
import dnpr/SOM_EP_HOVEDTILSTAND1 as diag
""")
    assert "FEIL" not in out
    ep = it.datasets["ep"]
    menn = it.datasets["menn"]
    assert len(ep) > 0
    assert (ep["pid"] == ep["SOM_EP_PERSONID"]).all()
    assert ep["pid"].isin(menn["PERSONID_1"]).all()
    # ICD-10 uten punktum, 3–5 tegn
    codes = ep["diag"].dropna().astype(str)
    assert codes.str.fullmatch(r"[A-Z][0-9A-Za-z]{2,4}").all()


def test_procedures_link_to_real_episodes_and_same_person():
    it, out = _run(HEADER + """
create-dataset ep
import dnpr/SOM_EP_AAR as aar, values("2022")
import dnpr/SOM_EP_PERSONID as pid
create-dataset pros
import dnpr/SOM_PROS_EPISODEID as epid, values_from(ep)
import dnpr/SOM_PROS_PERSONID as ppid
import dnpr/SOM_PROS_PROSEDYREKODE as kode
""")
    assert "FEIL" not in out
    ep = it.datasets["ep"].set_index("NPR_EPISODEID")
    pros = it.datasets["pros"]
    assert len(pros) > 0
    assert pros["epid"].isin(ep.index).all()
    assert (pros["ppid"].values == ep.loc[pros["epid"].values, "pid"].values).all()


def test_cancer_site_respects_person_sex():
    it, out = _run(HEADER + """
create-dataset personer
import db/BEFOLKNING_KJOENN as kjonn
create-dataset kreft
import krg/P_PERSONIDMICRODATA as pid
import krg/S_TOPOGRAFIICD10 as sete
import krg/S_DIAGNOSEAR as aar
import krg/S_ALDERDIAGNOSE as alder
""")
    assert "FEIL" not in out
    kreft = it.datasets["kreft"]
    sex = it.datasets["personer"].set_index("PERSONID_1")["kjonn"]
    s = sex.reindex(kreft["pid"].values).values
    sete3 = kreft["sete"].astype(str).str[:3].values
    assert not ((sete3 == "C61") & (s == "2")).any()   # prostata: bare menn
    assert ((sete3 == "C50") & (s == "2")).sum() > ((sete3 == "C50") & (s == "1")).sum()
    assert kreft["aar"].between(1953, 2024).all()
    assert 50 <= float(np.median(kreft["alder"])) <= 80


def test_sex_is_per_person_regardless_of_subpopulation():
    it, _ = _run(HEADER + """
create-dataset alle
import db/BEFOLKNING_KJOENN as k
create-dataset utvalg
import db/BEFOLKNING_KOMMNR_FORMELL 2022-01-01 as kom, values("0301")
import db/BEFOLKNING_KJOENN as k
""")
    alle = it.datasets["alle"].set_index("PERSONID_1")["k"]
    utv = it.datasets["utvalg"].set_index("PERSONID_1")["k"]
    assert len(utv) > 0
    assert (alle.reindex(utv.index) == utv).all()


@pytest.mark.parametrize("missing", ["finnesikke"])
def test_values_from_unknown_dataset_is_an_error(missing):
    _, out = _run(HEADER + f"""
create-dataset ep
import dnpr/SOM_EP_PERSONID as pid, values_from({missing})
""")
    assert "FEIL" in out and missing in out

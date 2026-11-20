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


HEADER = "require no.ssb.fdb:60 as db\nrequire no.fhi.npr:1 as dnpr\nrequire no.fhi.kreftregisteret:1 as krg\n"


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


# ── Grunnkrets (SSB FDB v60) ────────────────────────────────────────────────

def test_grunnkrets_matches_kommune_and_year_valid_codes():
    import json
    it, out = _run("""require no.ssb.fdb:60 as db
create-dataset p
import db/BEFOLKNING_KOMMNR_FORMELL 2023-01-01 as kom
import db/BEFOLKNING_GRUNNKRETS 2023-01-01 as gk
generate delomr = substr(gk, 1, 6)
""")
    assert "FEIL" not in out
    df = it.datasets["p"]
    assert (df["gk"].str.len() == 8).all()
    assert (df["gk"].str[:4] == df["kom"]).all()
    gyldig = json.loads((Path(META).parent / "codelists" / "BEFOLKNING_GRUNNKRETS.json")
                        .read_text(encoding="utf-8"))["gyldig"]
    for code in df["gk"].unique()[:200]:
        fra, til = gyldig[code]
        assert fra <= 2023 and (til is None or til >= 2023)


def test_grunnkrets_codelist_follows_kommune_reform():
    import json
    d = json.loads((Path(META).parent / "codelists" / "BEFOLKNING_GRUNNKRETS.json")
                   .read_text(encoding="utf-8"))
    assert d["gyldig"]["12010101"] == [1990, 2019]      # Nordnes, Bergen før 2020
    assert d["gyldig"]["46010101"] == [2020, None]      # Nordnes, Bergen fra 2020
    assert d["labels"]["46010101"] == "Nordnes"


# ── citation ────────────────────────────────────────────────────────────────

def test_citation_lists_required_databanks_in_order():
    import datetime
    _, out = _run(HEADER + "create-dataset p\nimport db/BEFOLKNING_KJOENN as k\ncitation\n")
    assert ("Analysen er gjennomført i microdata.no med datagrunnlag fra: SSB (registerdata), "
            "FHI (Norsk pasientregister), FHI (Kreftregisteret). Data analysert: "
            + datetime.date.today().isoformat()) in out
    assert "Opprettet en kobling fra no.ssb.fdb:60 til db" in out


def test_citation_without_require_is_an_error():
    _, out = _run("create-dataset p\ncitation\n")
    assert "FEIL" in out and "require" in out


# ── KOSTRA (enhetstype Kommune) ─────────────────────────────────────────────

def test_kostra_is_one_row_per_kommune_and_merges_on_kommune():
    it, out = _run("""require no.ssb.fdb:60 as db
create-dataset bosted
import db/BOSATTEFDT_BOSTED 2023-12-31 as kommune
aggregate (count) kommune -> bosatte, by(kommune)
create-dataset kostradata
import db/SB12362_KOSTRA_LONNSUTGIFTER_F_BARNEHAGE 2023-12-31 as barnehage
import db/SB12362_KOSTRA_LONNSUTGIFTER_F_GRUNNSKOLE 2023-12-31 as grunnskole
merge barnehage grunnskole into bosted on kommune
use bosted
generate per_pers = barnehage / bosatte
""")
    assert "FEIL" not in out
    k = it.datasets["kostradata"]
    assert 350 <= len(k) <= 360                      # ~357 kommuner i 2023
    assert k["KOMMUNENR"].is_unique
    assert "4601" in set(k["KOMMUNENR"]) and "1201" not in set(k["KOMMUNENR"])
    b = it.datasets["bosted"]
    assert b["barnehage"].notna().mean() > 0.9
    # Samme kommune ⇒ samme KOSTRA-verdi for alle bosatte.
    assert (b.dropna(subset=["barnehage"]).groupby("kommune")["barnehage"].nunique() == 1).all()
    assert 1 < b["per_pers"].median() < 50           # 1000 kr per bosatt, plausibelt nivå


def test_kostra_kommune_list_follows_reform_year():
    it, _ = _run("""require no.ssb.fdb:60 as db
create-dataset k19
import db/SB12362_KOSTRA_LONNSUTGIFTER_F_BARNEHAGE 2019-12-31 as b
""")
    koms = set(it.datasets["k19"]["KOMMUNENR"])
    assert "1201" in koms and "4601" not in koms     # Bergen før 2020-reformen
    assert len(koms) > 400


# ── Bostedskommune: én kommune per person og år ─────────────────────────────

def test_residence_kommune_variables_agree_per_person():
    it, out = _run("""require no.ssb.fdb:60 as db
create-dataset p
import db/BOSATTEFDT_BOSTED 2023-12-31 as bosted
import db/BEFOLKNING_KOMMNR_FORMELL 2023-01-01 as formell
import db/BEFOLKNING_KOMMNR_FAKTISK 2023-01-01 as faktisk
create-dataset oslo
import db/BEFOLKNING_KOMMNR_FORMELL 2023-01-01 as k, values("0301")
import db/BOSATTEFDT_BOSTED 2023-06-30 as b
""")
    assert "FEIL" not in out
    p = it.datasets["p"]
    assert (p["bosted"] == p["formell"]).all()
    assert (p["faktisk"] == p["formell"]).all()
    o = it.datasets["oslo"]
    assert len(o) > 0 and (o["b"] == "0301").all()   # delutvalg: samme kommune som i full populasjon


def test_residence_is_mostly_stable_across_years_and_follows_reforms():
    it, out = _run("""require no.ssb.fdb:60 as db
create-dataset p
import db/BOSATTEFDT_BOSTED 2019-12-31 as k19
import db/BOSATTEFDT_BOSTED 2020-12-31 as k20
import db/BOSATTEFDT_BOSTED 2022-12-31 as k22
import db/BOSATTEFDT_BOSTED 2023-12-31 as k23
""")
    assert "FEIL" not in out
    df = it.datasets["p"]
    x = df[["k22", "k23"]].dropna()
    stay = (x["k22"] == x["k23"]).mean()
    assert 0.9 < stay < 0.99                         # ~4,5 % flytter per år
    assert "1201" in set(df["k19"]) and "4601" not in set(df["k19"])
    # Bergen 2019 (1201) og 2020 (4601) er samme kommune → de fleste «blir».
    berg = df[df["k19"] == "1201"]
    assert (berg["k20"] == "4601").mean() > 0.9


# ── collapse/merge-regler fra ekte microdata.no-kjøring (2026-11-20) ─────────

_EP = HEADER + """
create-dataset personer
import db/BEFOLKNING_KJOENN as kjonn
create-dataset ep
import dnpr/SOM_EP_AAR as aar, values("2024")
import dnpr/SOM_EP_PERSONID as pid
generate dm = 1
"""


def test_collapse_explicit_target_with_existing_name_is_an_error():
    _, out = _run(_EP + "collapse (max) dm -> dm, by(pid)\n")
    assert "FEIL" in out and "finnes allerede" in out


def test_merge_on_collapsed_by_variable_is_an_error_but_implicit_works():
    _, out = _run(_EP + "collapse (max) dm, by(pid)\nmerge dm into personer on pid\n")
    assert "FEIL" in out and "implisitte" in out
    it, out = _run(_EP + "collapse (max) dm, by(pid)\nmerge dm into personer\nuse personer\n")
    assert "FEIL" not in out
    assert it.datasets["personer"]["dm"].notna().sum() > 0


def test_regress_needs_two_coefficients(monkeypatch):
    import m2py
    monkeypatch.setattr(m2py, "M2PY_DISCLOSURE_CONTROL", "1", raising=False)
    base = """require no.ssb.fdb:60 as db
create-dataset p
import db/INNTEKT_WLONN 2022-12-31 as y
import db/BEFOLKNING_KJOENN as kjonn
import db/BEFOLKNING_FOEDSELS_AAR_MND as f
generate alder = 2022 - int(f/100)
"""
    _, out = _run(base + "regress y alder\n")
    assert "FEIL" in out and "to koeffisienter" in out
    _, out = _run(base + "regress y alder i.kjonn\n")
    assert "FEIL" not in out


def test_confidentiality_v1_allows_single_regressor_but_not_with_fhi(monkeypatch):
    import m2py
    monkeypatch.setattr(m2py, "M2PY_DISCLOSURE_CONTROL", "1", raising=False)
    body = """create-dataset p
import db/INNTEKT_WLONN 2022-12-31 as y
import db/BEFOLKNING_FOEDSELS_AAR_MND as f
generate alder = 2022 - int(f/100)
regress y alder
"""
    _, out = _run("configure confidentiality v1\nrequire no.ssb.fdb:60 as db\n" + body)
    assert "FEIL" not in out
    _, out = _run("configure confidentiality v1\nrequire no.ssb.fdb:60 as db\n"
                  "require no.fhi.npr:1 as dnpr\n" + body)
    assert "FEIL" in out and "NPR" in out

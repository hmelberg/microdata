"""Strukturtester for hjelp.html som gjelder på tvers av de fire repoene.

Kopiert fra safestat (Task 4/9) og tilpasset microdata sitt lag 1: fire
emulator-seksjoner (kommandoer/avsloring/avvik/oversettere) i stedet for
safestat sin tillitsmodell. Identitet, påkrevde seksjoner og forbudte
strenger. Testen finnes fordi askstat sin hjelpeside het «OpenStat» i to
måneder uten at noe fanget det — og microdata sin het «Microdata Script
Runner» før denne taskens."""
import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent

IDENTITY = {
    "microdata": {
        "title_no": "Microdata – Dokumentasjon",
        "title_en": "Microdata – Documentation",
        "h1": "Microdata",
        "nav_logo": "Microdata",
        "lead_no": "Emulator av microdata.no — skriv og kjør microdata-kode.",
    },
}

FORBUDT_OVERALT = ["Microdata Script Runner"]


def read(fil: str) -> str:
    return (REPO / fil).read_text(encoding="utf-8")


class _Grab(HTMLParser):
    """Plukker ut title, første h1, nav-logo, lead, alle section-id-er,
    overskrift-id-er og interne href="#..."-mål.
    Bruker stdlib — bs4 er ikke installert og skal ikke installeres."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = None
        self.h1 = None
        self.nav_logo = None
        self.lead = None
        self.section_ids = []
        self.heading_ids = set()
        self.hrefs = set()
        self._want = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self._want = "title"
        elif tag == "h1" and self.h1 is None:
            self._want = "h1"
        elif tag == "div" and a.get("class") == "nav-logo":
            self._want = "nav_logo"
        elif tag == "p" and a.get("class") == "lead":
            self._want = "lead"
        elif tag == "section" and a.get("id"):
            self.section_ids.append(a["id"])
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6") and a.get("id"):
            self.heading_ids.add(a["id"])
        href = a.get("href")
        if href and href.startswith("#") and len(href) > 1:
            self.hrefs.add(href[1:])

    def handle_data(self, data):
        if self._want and data.strip():
            setattr(self, self._want, data.strip())
            self._want = None

    def handle_endtag(self, tag):
        self._want = None


def grab(fil: str) -> _Grab:
    p = _Grab()
    p.feed(read(fil))
    return p


@pytest.mark.parametrize("fil", ["hjelp.html", "hjelp.en.html"])
def test_ingen_gammel_scrollspy(fil):
    """Den gamle scroll-highlighteren toggler .active, som har samme styling
    som .nav-active. To scrollspyer med ulik terskel fremhever ofte to
    navlenker samtidig. Bare IntersectionObserver-varianten skal stå."""
    text = read(fil)
    assert "function updateNav" not in text
    assert "classList.toggle('active'" not in text
    assert "initScrollspy" in text, f"den nye scrollspyen mangler i {fil}"


@pytest.mark.parametrize("fil", ["hjelp.html", "hjelp.en.html"])
def test_ingen_forbudte_strenger(fil):
    text = read(fil)
    for s in FORBUDT_OVERALT:
        assert s not in text, f"{fil} inneholder fortsatt «{s}»"


def test_identitet_norsk():
    ident = IDENTITY["microdata"]
    g = grab("hjelp.html")
    assert g.title == ident["title_no"]
    assert g.h1 == ident["h1"]
    assert g.nav_logo == ident["nav_logo"]
    assert g.lead == ident["lead_no"]


def test_identitet_engelsk():
    ident = IDENTITY["microdata"]
    g = grab("hjelp.en.html")
    assert g.title == ident["title_en"]
    assert g.h1 == ident["h1"]
    assert g.nav_logo == ident["nav_logo"]


def test_lag0_seksjoner_finnes():
    ids = grab("hjelp.html").section_ids
    assert "intro" in ids, "mangler seksjon #intro"


def test_navfilter_finnes():
    assert 'class="nav-filter"' in read("hjelp.html")


def test_denne_siden_dekker_tabell():
    """Lag 0 skal ha en oversiktstabell, ikke bare prosa."""
    text = read("hjelp.html")
    m = re.search(r'<section id="intro".*?</section>', text, re.DOTALL)
    assert m, "fant ikke intro-seksjonen"
    assert 'class="overview"' in m.group(0), "intro mangler oversiktstabell"


def test_ingen_hengende_interne_lenker():
    """Hver href="#x" skal treffe en seksjon eller overskrift som finnes.
    Fanger at en senere endring omdøper eller dropper en seksjon som lag 0
    allerede lenker til."""
    g = grab("hjelp.html")
    mal = set(g.section_ids) | g.heading_ids
    hengende = g.hrefs - mal
    assert not hengende, f"hengende interne lenker (mangler id): {sorted(hengende)}"


# ── Task 15: emulator-innhold (lag 1) ───────────────────────────────────────

def test_emulator_seksjonene_finnes():
    ids = grab("hjelp.html").section_ids
    for s in ("kommandoer", "avsloring", "avvik", "oversettere"):
        assert s in ids, f"mangler seksjon #{s}"


def _tabellrader(blokk: str) -> int:
    """Antall rader i <tbody> — en tom tabell er ikke dokumentasjon."""
    m = re.search(r"<tbody>(.*?)</tbody>", blokk, re.DOTALL)
    return len(re.findall(r"<tr>", m.group(1))) if m else 0


def test_avvik_seksjonen_er_konkret():
    """«Avvik fra microdata.no» skal liste faktiske avvik i en tabell — en
    vag ansvarsfraskrivelse hjelper ingen."""
    text = read("hjelp.html")
    m = re.search(r'<section id="avvik".*?</section>', text, re.DOTALL)
    assert m, "fant ikke avvik-seksjonen"
    blokk = m.group(0)
    assert 'class="doc-table"' in blokk, "avvik mangler tabell"
    assert _tabellrader(blokk) >= 2, (
        "avvikstabellen er tom eller har bare én rad — skjelettet er ikke fylt ut")


@pytest.mark.parametrize("seksjon", ["kommandoer", "avsloring", "oversettere"])
def test_emulatortabellene_er_fylt_ut(seksjon):
    """Skjelettene i planen har tomme <tbody>. Testen hindrer at de blir
    stående slik."""
    text = read("hjelp.html")
    m = re.search(rf'<section id="{seksjon}".*?</section>', text, re.DOTALL)
    assert m, f"fant ikke {seksjon}-seksjonen"
    assert _tabellrader(m.group(0)) >= 2, (
        f"#{seksjon} har en tom eller nesten tom tabell")


def test_ingen_html_kommentar_plassholdere():
    """Skjelettenes <!-- … --> skal være erstattet med innhold."""
    for fil in ("hjelp.html", "hjelp.en.html"):
        text = read(fil)
        rester = re.findall(r"<!--\s*(?:Én rad per|Et kort skript|Output kopiert|"
                            r"Faktiske terskler|Ett faktisk avvik|fra py2m|fra r2m|"
                            r"kjørt gjennom|faktisk oversetteroutput)[^>]*-->", text)
        assert not rester, f"{fil} har igjen plassholdere: {rester[:3]}"


def test_statx_er_dokumentert():
    """statx finnes fortsatt i microdata sitt modeRegistry, i motsetning til
    openstat der den ble fjernet."""
    text = read("hjelp.html")
    m = re.search(r'<section id="modes".*?</section>', text, re.DOTALL)
    assert m
    assert "Statx" in m.group(0), "modustabellen mangler Statx"


def test_avsloring_terskler_er_tall_ikke_ord():
    """Tersklene skal være konkrete tall (hentet fra m2py.py), ikke vage ord
    som «lav» eller «få»."""
    text = read("hjelp.html")
    m = re.search(r'<section id="avsloring".*?</section>', text, re.DOTALL)
    assert m, "fant ikke avsloring-seksjonen"
    blokk = m.group(0)
    for tall in ("1000", "10", "3 signifikante"):
        assert tall in blokk, f"avsloring-tabellen mangler terskelen «{tall}»"


def test_oversettere_nevner_py2m_og_r2m():
    text = read("hjelp.html")
    m = re.search(r'<section id="oversettere".*?</section>', text, re.DOTALL)
    assert m
    blokk = m.group(0)
    assert "py2m" in blokk and "r2m" in blokk


# ── Ikke-kjørte resultater skal være merket som illustrasjon ────────────────

def test_ikke_kjorte_resultater_er_merket():
    text = read("hjelp.html")
    for res in re.findall(r'<pre class="result([^"]*)">', text):
        if "illustration" in res:
            # Finnes bare hvis en senere seksjon legger inn en illustrasjon —
            # da må ordet «illustrasjon» også være synlig et sted i samme fil.
            assert "illustrasjon" in text.lower()


# ── Task 15: fellesdel (lag 2 og 3) i SYNC-blokker ─────────────────────────

SYNC_BLOKKER = [
    "felles-css", "felles-js", "felles-running", "felles-editor",
    "felles-sidebar", "felles-lagre", "felles-forklar", "felles-widgets",
    "felles-ai", "felles-eksempler", "felles-referanse-snarveier",
    "felles-referanse-tab",
]

APPNAVN = ["SafeStat", "OpenStat", "AskStat"]


def _block(text, name):
    pat = (r"(?:/\*|<!--)\s*SYNC:START\s+" + re.escape(name)
           + r"\s*(?:\*/|-->)(.*?)(?:/\*|<!--)\s*SYNC:END\s*(?:\*/|-->)")
    m = re.search(pat, text, re.DOTALL)
    return m.group(1) if m else None


@pytest.mark.parametrize("navn", SYNC_BLOKKER)
def test_sync_blokk_finnes(navn):
    assert _block(read("hjelp.html"), navn) is not None, f"mangler {navn}"


@pytest.mark.parametrize("navn", SYNC_BLOKKER)
def test_sync_blokk_er_repo_noytral(navn):
    """En fellesblokk skal ikke nevne et annet appnavn — da kan den ikke
    deles. «Microdata» er unntatt fordi DETTE er microdata-repoet."""
    blokk = _block(read("hjelp.html"), navn)
    assert blokk is not None
    for navn_app in APPNAVN:
        assert navn_app not in blokk, (
            f"{navn} nevner «{navn_app}»; flytt det til lag 0 eller lag 1")


def test_modustabell_finnes_og_er_utenfor_sync():
    """Modustabellen er repo-spesifikk og skal IKKE ligge i en SYNC-blokk."""
    text = read("hjelp.html")
    m = re.search(r'<section id="modes".*?</section>', text, re.DOTALL)
    assert m, "fant ikke modes-seksjonen"
    blokk = m.group(0)
    assert 'class="doc-table"' in blokk, "modes mangler tabell"
    assert "SYNC:START" not in blokk, "modustabellen skal ikke være i en SYNC-blokk"
    # Sju moduser: de seks i modeRegistry (index.html) pluss jamovi, som
    # registreres dynamisk fra js/modes/jamovi.js via M.registerMode() og
    # derfor ikke står i den statiske lista — men kjører like fullt.
    for modus in ("Microdata", "Python", "R", "DuckDB", "Brython", "Statx",
                  "jamovi"):
        assert modus in blokk, f"modustabellen mangler «{modus}»"


# ── Engelsk parallell ────────────────────────────────────────────────────────

EN_SEKSJONER = [
    "intro", "running", "kommandoer", "avsloring", "avvik", "oversettere",
    "editor", "tab-intro", "sidebar", "lagre-dele", "forklar", "widgets",
    "ai", "eksempler", "modes", "python", "r", "hybrid",
    "referanse-snarveier", "tab-full",
]


@pytest.mark.parametrize("seksjon", EN_SEKSJONER)
def test_engelsk_har_samme_seksjoner(seksjon):
    assert seksjon in grab("hjelp.en.html").section_ids


def test_engelsk_har_sync_blokkene():
    text = read("hjelp.en.html")
    for navn in SYNC_BLOKKER:
        assert _block(text, navn) is not None, f"mangler {navn} i hjelp.en.html"


def test_engelsk_har_ingen_norsk_rest():
    text = read("hjelp.en.html")
    for rest in ("Script Runner", "Microdata Script Runner"):
        assert rest not in text, f"«{rest}» står igjen i hjelp.en.html"


def test_engelsk_resultatblokker_er_identiske_med_norske():
    """Tall er tall. m2py sine meldinger er norske uansett UI-språk — en
    resultatblokk som avviker mellom språkene betyr at noen har redigert
    output for hånd."""
    import html as _html
    no = re.findall(r'<pre class="result">(.*?)</pre>', read("hjelp.html"), re.DOTALL)
    en = re.findall(r'<pre class="result">(.*?)</pre>', read("hjelp.en.html"), re.DOTALL)
    assert no, "fant ingen resultatblokker i hjelp.html"
    norm = lambda xs: sorted(_html.unescape(x).strip() for x in xs)
    assert norm(no) == norm(en), "resultatblokkene skiller seg mellom språkene"


# ── Eksempler skal stemme mot harnessen (docs/hjelp_examples) ───────────────

def test_alle_resultatblokker_har_harness_fil_eller_illustrasjon():
    """Enhver <pre class="result"> uten 'illustration' skal finnes ordrett i
    docs/hjelp_examples/output/ — ellers er den limt inn for hånd."""
    outdir = REPO / "docs" / "hjelp_examples" / "output"
    kjort = {f.read_text(encoding="utf-8").strip() for f in outdir.glob("*.txt")}
    assert kjort, "fant ingen harness-outputfiler"
    import html as _html
    for fil in ("hjelp.html", "hjelp.en.html"):
        text = read(fil)
        blokker = re.findall(r'<pre class="result">(.*?)</pre>', text, re.DOTALL)
        assert blokker, f"fant ingen resultatblokker i {fil}"
        for b in blokker:
            ren = _html.unescape(b).strip()
            assert ren in kjort, (
                f"{fil}: resultatblokk uten harness-fil og uten "
                f"illustrasjon-merking:\n{ren[:200]}")

#!/usr/bin/env node
// eval-motor.mjs — kjører evalspørsmål gjennom APPENS EGEN MOTOR.
//
// Forskjellen fra scripts/eval_svar.py er hele poenget: den kjører aldri
// script, men svarer med en simulert run_result. Denne driver en ekte
// nettleser, så scriptene faktisk kjøres i Brython/Pyodide/DuckDB-WASM og
// modellen ser VIRKELIGE tall — akkurat som når et menneske sitter der.
//
// Den feller ingen dommer. Den samler: spørsmål, script, ekte utskrift,
// sluttsvar, tid, hopp, konsollfeil og sporring-id-en som knytter kjøringen
// til feiljournalen. Vurderingen gjøres av /forbedringsrunde.
//
// Bruk:
//   node scripts/eval-motor.mjs --sporsmal "…" [--quality balanced]
//   node scripts/eval-motor.mjs --evalsett [--bare 1,2,9]
//   node scripts/eval-motor.mjs --evalsett --url http://localhost:8888
//
// Passordet leses fra .env (M2PY_ACCESS_TOKEN_PERSONAL) — det personlige, så
// kjøringene journalføres.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STD_URL = "https://microstat.melberg.app";
const EVALSETT = join(ROT, "docs/eval/svar-evalsett.md");

// Spørsmål som forutsetter et script i editoren. #10 tester at modellen leser
// konteksten den får — og er det eneste spørsmålet i settet som kan utøve
// kriterium 3 (kjørefeil → synlig ⚠️ → reparasjonsrunde), fordi de andre
// scriptene stort sett går gjennom på første forsøk.
const FIXTURES = { 10: "docs/eval/fixtures/feilende-script.txt" };

// ── Evalsett-parseren ────────────────────────────────────────────────────
// Eksportert og testet mot den EKTE fila: tabellformatet er en kontrakt med
// et dokument et menneske redigerer, og endres kolonnene der, skal testen
// ryke — ikke kjøringen stille hoppe over spørsmål.
export function parseEvalsett(md) {
  const ut = [];
  for (const linje of md.split("\n")) {
    const m = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(linje);
    if (!m) continue;
    ut.push({
      nr: Number(m[1]),
      mode: m[2].trim(),
      sporsmal: m[3].trim().replace(/`/g, ""),
      forventning: m[4].trim(),
    });
  }
  return ut;
}

function lesPassord() {
  const env = readFileSync(join(ROT, ".env"), "utf8");
  const m = /^\s*(?:export\s+)?M2PY_ACCESS_TOKEN_PERSONAL\s*=\s*(.+)$/m.exec(env);
  if (!m) throw new Error("M2PY_ACCESS_TOKEN_PERSONAL mangler i .env");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function argv(navn, standard) {
  const i = process.argv.indexOf(`--${navn}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : standard;
}
const harFlagg = (n) => process.argv.includes(`--${n}`);

/** Alle forekomster av et flagg — `--sporsmal A --sporsmal B` blir en samtale. */
function argvAlle(navn) {
  const ut = [];
  process.argv.forEach((a, i) => {
    if (a === `--${navn}` && process.argv[i + 1]) ut.push(process.argv[i + 1]);
  });
  return ut;
}

// ── Én spørring gjennom appen ────────────────────────────────────────────
async function kjorEn(side, sp, timeoutMs, tomTraad = true) {
  const t0 = Date.now();
  if (tomTraad) {
    // Nullstill tråden mellom spørsmål, ellers vokser DOM-en og høstingen
    // plukker opp forrige svar. I --samtale-modus er det nettopp poenget at
    // den IKKE tømmes: da bærer state.history videre, og oppfølgingen tester
    // samtalehukommelsen.
    await side.evaluate(() => {
      const b = document.getElementById("aiClearBtn");
      if (b) b.click();
    });
  }
  // Editoren fylles FØR spørsmålet stilles, og «Inkluder skript» hukes av —
  // ellers når scriptet aldri modellen, og #10 tester ingenting.
  await side.evaluate((script) => {
    const ed = document.getElementById("scriptInput");
    if (ed) {
      ed.value = script || "";
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const kryss = document.getElementById("aiIncludeScript");
    if (kryss) kryss.checked = !!script;
  }, sp.script || "");

  await side.fill("#aiInput", sp.sporsmal);
  await side.click("#aiSendFastBtn");

  // Ferdig når send-knappen er aktiv igjen: ai-chat.js slår den av under
  // sending og på igjen i sin finally, uansett utfall. Det er det eneste
  // signalet som gjelder like godt for svar, feil og avbrudd.
  let utfall = "OK";
  try {
    await side.waitForFunction(
      () => { const b = document.getElementById("aiSendFastBtn"); return b && !b.disabled; },
      null,
      { timeout: timeoutMs, polling: 500 },
    );
  } catch (_e) {
    utfall = "TIMEOUT";
  }

  const høst = await side.evaluate(() => {
    const tråd = document.getElementById("aiThread");
    // DIREKTE barn, ikke querySelectorAll: bobler er nøstet inne i
    // thinking-noder, så et bredt selektor-treff plukket samme tekst to
    // ganger og rapporten viste hele svaret duplisert (funnet 2026-08-29).
    const bobler = tråd ? [...tråd.children] : [];
    const kjøring = (typeof window.mdRunHarvest === "function")
      ? window.mdRunHarvest()
      : { ok: null, output: "" };
    const editor = document.getElementById("scriptInput");
    return {
      sporring: window.mdSisteSporring || null,
      tekst: bobler.map((b) => b.innerText).join("\n---\n"),
      prosesslogg: [...document.querySelectorAll(".ai-progress-line")].map((l) => l.textContent),
      kjoring: kjøring,
      script: editor ? editor.value : "",
      feilbobler: [...document.querySelectorAll(".ai-error")].map((e) => e.textContent),
    };
  });

  if (utfall === "OK" && høst.feilbobler.length) utfall = "FEIL";
  return { ...sp, utfall, sekunder: (Date.now() - t0) / 1000, ...høst };
}

async function main() {
  const { chromium } = await import("playwright");
  const url = argv("url", STD_URL);
  const quality = argv("quality", "balanced");
  const timeoutMs = Number(argv("timeout", "420")) * 1000;

  let sporsmal;
  if (harFlagg("evalsett")) {
    const alle = parseEvalsett(readFileSync(EVALSETT, "utf8"));
    const bare = argv("bare", null);
    sporsmal = bare
      ? alle.filter((s) => bare.split(",").map(Number).includes(s.nr))
      : alle;
    for (const sp of sporsmal) {
      if (FIXTURES[sp.nr]) sp.script = readFileSync(join(ROT, FIXTURES[sp.nr]), "utf8");
    }
  } else {
    const qs = argvAlle("sporsmal");
    if (!qs.length) { console.error("Trenger --sporsmal «…» eller --evalsett"); process.exit(2); }
    const scriptSti = argv("script", null);
    const script = scriptSti ? readFileSync(join(ROT, scriptSti), "utf8") : "";
    sporsmal = qs.map((q, i) => ({
      nr: i + 1, mode: argv("mode", "microdata"), sporsmal: q, forventning: "", script,
    }));
  }
  if (!sporsmal.length) { console.error("Ingen spørsmål valgt"); process.exit(2); }

  const passord = lesPassord();
  const nettleser = await chromium.launch();
  // ÉN kontekst for hele batchen: WASM-motorene (Brython/Pyodide/DuckDB) er
  // trege å boote, og en ny kontekst per spørsmål ville dominert kjøretiden.
  const ctx = await nettleser.newContext();
  await ctx.addInitScript(([p, q]) => {
    // Må settes FØR appen laster — den leser localStorage ved oppstart.
    localStorage.setItem("md_access_token", p);
    localStorage.setItem("md_ai_quality", q);
    localStorage.setItem("md_ai_autorun", "1");   // hopper over kjørebekreftelsen
    // Velkomstmodalen fanger klikket på #aiToggleBtn på en fersk profil —
    // funnet ved første smoke-kjøring 2026-08-29. Flagget er appens eget.
    localStorage.setItem("microdata_welcome_dismissed", "1");
  }, [passord, quality]);

  const side = await ctx.newPage();
  const konsoll = [];
  side.on("console", (m) => { if (m.type() === "error") konsoll.push(m.text().slice(0, 300)); });
  side.on("pageerror", (e) => konsoll.push("pageerror: " + String(e).slice(0, 300)));

  await side.goto(url, { waitUntil: "domcontentloaded" });
  await side.waitForSelector("#aiToggleBtn", { timeout: 60000 });
  await side.click("#aiToggleBtn");
  await side.waitForSelector("#aiInput", { timeout: 30000 });

  const samtale = harFlagg("samtale");
  const resultater = [];
  for (const sp of sporsmal) {
    process.stderr.write(`… #${sp.nr} ${sp.sporsmal.slice(0, 60)}\n`);
    // I samtalemodus tømmes tråden bare foran det FØRSTE spørsmålet.
    const r = await kjorEn(side, sp, timeoutMs, !samtale || sp === sporsmal[0]);
    r.konsoll = konsoll.splice(0);
    resultater.push(r);
    process.stderr.write(`  → ${r.utfall} (${r.sekunder.toFixed(1)} s)\n`);
  }
  await nettleser.close();

  const stempel = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const ut = join(ROT, `docs/eval/kjoringer/motor-${stempel}.md`);
  mkdirSync(dirname(ut), { recursive: true });
  writeFileSync(ut, rapport(resultater, { url, quality, stempel, samtale }));
  console.log(ut);
}

function rapport(res, meta) {
  const l = [
    `# Eval gjennom motoren — ${meta.stempel}`,
    "",
    `- URL: ${meta.url} · Quality: ${meta.quality}${meta.samtale ? " · SAMTALE (tråden beholdes)" : ""}`,
    "- Scriptene er FAKTISK kjørt i emulatoren (Brython/Pyodide/DuckDB-WASM).",
    "- Utfall er kun teknisk. Vurdering mot evalsettets kriterier gjøres av /forbedringsrunde.",
    "",
    "| # | Spørsmål | Utfall | Sek | Kjøring | Sporring |",
    "|---|----------|--------|-----|---------|----------|",
    ...res.map((r) =>
      `| ${r.nr} | ${r.sporsmal.slice(0, 50).replace(/\|/g, "\\|")} | ${r.utfall} `
      + `| ${r.sekunder.toFixed(1)} | ${r.kjoring.ok === null ? "–" : r.kjoring.ok ? "OK" : "FEIL"} `
      + `| \`${r.sporring || "–"}\` |`),
    "",
  ];
  for (const r of res) {
    l.push(`## ${r.nr}. ${r.sporsmal}`, "");
    if (r.forventning) l.push(`- Forventning: ${r.forventning}`);
    if (r.script) l.push("- Script FORHÅNDSLAGT i editoren («Inkluder skript» på)");
    l.push(`- Utfall: **${r.utfall}** · ${r.sekunder.toFixed(1)} s · sporring: \`${r.sporring || "–"}\``, "");
    if (r.prosesslogg.length) l.push("### Prosesslogg", "", ...r.prosesslogg.map((p) => `- ${p}`), "");
    if (r.script) l.push("### Script i editoren", "", "```", r.script, "```", "");
    l.push("### Motorens utskrift (EKTE)", "", "```",
      (r.kjoring.output || "(ingen)").slice(0, 4000), "```", "");
    l.push("### Svar", "", r.tekst || "(tomt)", "");
    if (r.feilbobler.length) l.push("### Feilbobler", "", ...r.feilbobler.map((f) => `- ${f}`), "");
    if (r.konsoll.length) l.push("### Konsollfeil", "", ...r.konsoll.map((c) => `- \`${c}\``), "");
  }
  return l.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e);
  process.exit(1);
});

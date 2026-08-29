// _lib/forord.ts — ett lynraskt Haiku-kall som gir brukeren noe ekte å lese
// mens Opus tenker. Målt 2026-08-28: tenkefasen sender ingenting på 26-31 s,
// og tenketeksten er kryptert, så det finnes ikke noe å strømme fra selve
// tenkingen. Dette er erstatningen.
//
// Haiku 4.5 tar ALDRI effort — det gir 400.
import { messageAnthropic } from "./anthropic.ts";
import { type JobbSkriver } from "./jobb-blobb.ts";

export interface ForordOpts {
  apiKey: string;
  question: string;
  /** Injiserbar for test; default er et ekte Haiku-kall. */
  kall?: () => Promise<string>;
}

const INSTRUKS =
  "Skriv én til to setninger om hvordan du vil gripe an spørsmålet under. " +
  "Ikke svar på det, ikke still spørsmål tilbake, ikke bruk overskrifter.";

export async function skrivForord(
  skriver: JobbSkriver,
  opts: ForordOpts,
): Promise<void> {
  try {
    const tekst = opts.kall
      ? await opts.kall()
      : (await messageAnthropic({
        apiKey: opts.apiKey,
        model: "claude-haiku-4-5",
        maxTokens: 150,
        system: INSTRUKS,
        prompt: opts.question,
        // Ingen effort: den gir 400 på Haiku 4.5.
      })).text;
    const ren = String(tekst ?? "").trim();
    if (!ren) return;
    await skriver.skriv(`data: ${JSON.stringify({ type: "forord", text: ren })}\n\n`);
  } catch (_e) {
    // Forordet er pynt. En feil her skal aldri koste brukeren svaret.
  }
}

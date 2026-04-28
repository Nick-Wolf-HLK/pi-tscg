# pi-tscg — Praxis-Bericht aus dem Feld

**Adressat:** Furkan / SKZL-AI (Maintainer von [@tscg/core](https://github.com/SKZL-AI/tscg))
**Verfasser:** Dominic Wolf
**Datum:** 28. April 2026
**Repo:** `pi-tscg` (lokal lauffähig; Ziel: npm-Veröffentlichung + Pi-Plugin-Verzeichnis)

---

## 1. Worum es geht

`@tscg/core` ist hier als **Pi-Coding-Agent-Extension** integriert, um TSCG in einer realen Coding-Agent-Loop zu betreiben — nicht als statischen Compiler-Lauf, sondern als Live-Hook bei jedem LLM-Request und bei jedem Tool-Result. Dabei sind drei Optimierungs-Hebel entstanden, von denen einer direkt auf deinem Core sitzt und zwei darüber hinausgehen.

Das Dokument zeigt:

1. **Was die Extension macht** — Architektur und Hook-Punkte in Pi
2. **Wie `@tscg/core` konkret eingebunden ist** — `principles`-Konfiguration, `compressDescriptions`-Aufruf
3. **Was wir on top gebaut haben** — Tool-Result-Compression und Anthropic-Prompt-Cache-Marker
4. **Reale Messdaten** aus einer Live-Session
5. **Wo Description-Only auf kompakten Tool-Schemas an die strukturelle Grenze stößt**
6. **Roadmap:** Veröffentlichung als npm-Package, Integration ins Pi-Plugin-Verzeichnis

---

## 2. Warum Pi — und nicht Claude Code, Aider oder Cursor

Pi (`@mariozechner/pi-coding-agent`) ist als Plattform für TSCG-Experimente und für Agent-Tooling generell aus mehreren Gründen besser geeignet als die etablierten Alternativen. Der Punkt ist nicht „schlechter sind die anderen" — der Punkt ist: Pi gibt einer Compression-Extension genau die Eingriffspunkte und die Provider-Breite, die wir brauchen, ohne Lock-in. Vergleich auf einen Blick:

| Eigenschaft | **Pi** | Claude Code | Aider | Cursor / Copilot |
|-------------|--------|-------------|-------|------------------|
| Lizenz / Open Source | MIT | proprietär | Apache-2.0 | proprietär |
| Provider-Support | Anthropic, OpenAI, Ollama, ... | Anthropic only | Multi-Provider | OpenAI / Anthropic über Cursor-Backend |
| Ausführung | CLI, headless-fähig (`pi -p`) | CLI, interaktiv | CLI | nur in IDE |
| Lokale Modelle als First-Class? | ja (Ollama nativ) | nein | teilweise | nein |
| Lifecycle-Hooks für Extensions | volle Tool-Schema- und Tool-Result-Mutation | nur Pre/Post-Tool-Events | begrenzt | keine |
| Self-Provisioning per Marketplace-Befehl | `pi install <pkg>` | Plugin-Verzeichnis (Hooks/MCP-fokussiert) | nein | proprietär (extension marketplace) |
| Telemetrie | keine | proprietär (anthropic) | optional | proprietär |
| Code-Größe (Anhaltspunkt) | mittlere CLI, lesbar | Black-Box | mittlere CLI, lesbar | Black-Box |

Konkret die fünf entscheidenden Punkte für die TSCG-Integration:

### 2.1 Schlanker, lesbarer Kern

Pi ist **ein einzelnes npm-Paket** mit klarer Lifecycle-Architektur. Keine Telemetrie, kein Editor-Integration-Wrapper, keine Cloud-Abhängigkeit, kein Account-Zwang. Der Source ist überschaubar (v0.70.5 — Größenordnung mittlere CLI). Das macht Performance-Messung deterministisch: jeder eingesparte Token ist nachvollziehbar im Hook-Output, ohne dass eine IDE-Schicht oder ein Cloud-Backend dazwischenfunkt.

### 2.2 Provider-Agnostik

Pi spricht direkt mit der **Anthropic API, OpenAI API und Ollama API** (über deren OpenAI-kompatibles Endpoint). Provider-Wechsel ist eine Flag-Sache (`pi --provider anthropic --model claude-haiku`), nicht ein Vendor-Switch. Für TSCG bedeutet das: ein und dieselbe Extension wirkt auf allen drei Welten. Hebel 1 + Hebel 2 sind komplett provider-agnostic, Hebel 3 (Cache) ist provider-aware mit unterschiedlichen Mechaniken pro API (Details in §5.2).

Im Kontrast: Claude Code ist an Anthropic gekoppelt, Cursor an dessen Backend, Copilot ans GitHub-Backend. Eine Compression-Extension dort hätte deutlich weniger Reichweite.

### 2.3 Lokale Modelle als First-Class

Ollama-Integration ist in Pi keine nachträgliche Erweiterung, sondern Default-Setup (siehe `~/.pi/agent/settings.json`: `defaultProvider: "ollama"`). Das matcht den Trend zu lokalen, mittel-großen Code-Modellen (Qwen 3, DeepSeek-Coder, Llama 3.x), die auf 24-32 GB RAM-Macs laufen. Für TSCG ist das relevant, weil **bei lokalen Modellen Tokens nicht Geld kosten, aber Zeit** — Compression beschleunigt das Modell direkt, was bei einem 9B-Modell mit 30-60 tk/s gut spürbar ist.

### 2.4 Self-Service-Tooling per Extension-API

Pi hat ein vollständiges Hook-System, mit dem eine Extension die Tool-Schemas, die Conversation-Messages, die Tool-Calls **und** die Tool-Results pro Lifecycle-Punkt mutieren kann. Das ist nicht selbstverständlich — Claude Code z.B. exponiert nur `hooks` für Pre-/Post-Tool-Events ohne Möglichkeit, das LLM-Payload selbst zu rewriten. Pi gibt der Extension den vollen Provider-Payload-Zugriff:

```ts
on(event: "before_provider_request", handler):  // Tool-Schemas + System
on(event: "context", handler):                    // Conversation-History
on(event: "tool_call", handler):                  // Tool-Argumente
on(event: "tool_result", handler):                // Tool-Output
on(event: "after_provider_response", handler):   // Antwort-Inspektion
```

Genau diese Punkte sind die natürlichen Eingriffsstellen für TSCG, sowohl für Schemas als auch für Result-Compression. Ohne diesen Layer hätten wir Hebel 2 gar nicht bauen können.

### 2.5 Self-Provisioning mit Add-ons

Pi-Agenten können sich **zur Laufzeit weitere Tools per Extension installieren** (`pi install <package>`). Das macht Pi zu einer interessanten Plattform für TSCG-Distribution: ein Nutzer kann mit einem einzigen Befehl

```bash
pi install pi-tscg
```

das gesamte Compression-System aktivieren — **ohne den Agent-Code zu modifizieren, ohne Cluster-Setup, ohne Account.** Genau dieser Workflow ist das mittelfristige Ziel (siehe Abschnitt 8). Vergleichbare Distribution gibt es bei Claude Code zwar über Plugins, aber dort wären wir an Anthropic-only gebunden — der TSCG-Wert über alle Provider hinweg geht verloren.

---

## 3. Architektur

```
                ┌─────────────────────────────────────────────────┐
                │           Pi Coding Agent (v0.70.5)             │
                │                                                 │
   User Prompt ─┼──► Agent Loop ────► Provider Adapter ──► LLM    │
                │       │  ▲                  │                   │
                │       │  │                  │                   │
                │  ┌────┴──┴──────────────────┴─────┐             │
                │  │   Extension Hook-Bus            │             │
                │  └─────────────────────────────────┘             │
                │       │  │                  │                   │
                │       ▼  │                  ▼                   │
                │  ┌────────┴───────┐    ┌──────────────────┐     │
                │  │  pi-tscg       │    │  pi-tscg         │     │
                │  │  Hook-Block A  │    │  Hook-Block B    │     │
                │  │                │    │                  │     │
                │  │  Hebel 1+3     │    │  Hebel 2         │     │
                │  └───┬────────────┘    └──────────────────┘     │
                │      │                                          │
                └──────┼──────────────────────────────────────────┘
                       │
                       ▼
                  ┌─────────────┐
                  │ @tscg/core  │  ← compressDescriptions(...)
                  │   v1.4.3    │     applySDMToText(...)
                  └─────────────┘     estimateTokens(...)
```

Drei Hebel, drei Hook-Punkte:

| Hebel | Hook | Wirkung | Provider-Reichweite | Quelle |
|-------|------|---------|---------------------|--------|
| **1** | `before_provider_request` | Tool-Schema-Compression | alle (Anthropic, OpenAI, Ollama, Gemini) | `@tscg/core: compressDescriptions` |
| **2** | `tool_result` | Tool-Output-Compression | alle (Provider-agnostisch, läuft im Pi-Hook) | eigener Code, nutzt `applySDMToText` aus core |
| **3** | `before_provider_request` | Provider-Cache-Awareness | provider-aware: Anthropic ✓, OpenAI ✓ implizit, Gemini Skeleton, Ollama no-op | eigener Code, siehe §5.2 |

---

## 4. Wie `@tscg/core` integriert ist

### 4.1 `compressDescriptions` mit voller Operator-Pipeline

Default-Aufruf war initial:

```ts
compressDescriptions(candidates, { model });
```

Inzwischen explizit alle acht Operatoren aktiviert (`description-only`-Mode bewahrt JSON-Strukturen, Tool-Names bleiben unangetastet):

```ts
compressDescriptions(candidates, {
  model,                 // gemappt aus ctx.model.id (Pi → ModelTarget)
  profile: "aggressive",
  principles: {
    sdm: true, dro: true, cas: true, ccp: true,
    cfl: true, cfo: true, sad: true, tas: true,
  },
});
```

Die Map von Pi-Modell-IDs auf deine `ModelTarget`-Werte sitzt in `mapPiModelId()` — deckt aktuell Claude (Opus/Sonnet/Haiku), GPT (4/4o-mini/5), Llama (3.1/3.2), Mistral, Gemma, Phi, Qwen, DeepSeek ab. Kann ich gerne als PR ins Core-Repo zurückspielen, wenn das für andere Adapter-Autoren nützlich ist.

### 4.2 Determinismus-Anforderung für Hebel 3

Damit Anthropic-Prompt-Caching greift (Hebel 3 unten), muss die Compression byte-deterministisch sein. Test bestätigt:

```
two consecutive compressDescriptions(tools, sameOpts).tools
→ JSON.stringify(a) === JSON.stringify(b)  ✓
```

Das ist im Core durchgängig der Fall — danke dafür, das ist nicht selbstverständlich für Pipeline-Compiler.

### 4.3 `applySDMToText` als Standalone-Operator

Für die Tool-Result-Compression (Hebel 2) nutze ich `applySDMToText` direkt auf rohen Bash-/Find-/WebFetch-Outputs. Das funktioniert hervorragend — die Filler-Pattern-Liste deckt npm-/Cargo-/pip-/git-Logs gut ab.

**Vorschlag:** Wenn du eine offizielle `applyDROToText` und `applyCCPToText` exportieren würdest (oder eine `compressFreeText(text, opts)` als Convenience-API), könnten Tool-Output-Compressors deutlich mehr aus dem Framework herausholen, ohne die Tool-Schema-spezifischen Operatoren zu missbrauchen.

---

## 5. Was wir on top gebaut haben

### 5.1 Hebel 2 — Tool-Result-Compression

Pi feuert `tool_result` nach jeder Tool-Ausführung. Das Event enthält `content: (TextContent | ImageContent)[]` plus `toolName`, mutable Return.

Die Extension registriert einen Hook und wendet pro Tool-Typ eine Pipeline an:

```ts
function compressToolResultText(toolName, text, budget, model) {
  let out = text;
  if (toolName === "bash" || isCustomTool(toolName)) {
    out = collapseWhitespace(out);     // run-of-newlines, trailing-WS
    out = foldDuplicateLines(out);     // identische Folgezeilen → "⤺ ×N"
    out = applySDMToText(out);         // ← @tscg/core
  }
  if (estimateTokens(out, model) > budget) {
    out = headTailTruncate(out, budget, model);  // 60% head + 35% tail + Marker
  }
  return out;
}
```

Token-Budget per Default 4 000 (settings-konfigurierbar). `Edit`/`Write`/`NotebookEdit` sind hard ausgeschlossen — Diffs müssen byte-exakt bleiben.

**Empirisch (synthetischer Test):** auf einem npm-install-artigen Output (~35 KB, 8 700 Tokens) liefert die Pipeline **58.5 % Reduktion** auf 3 600 Tokens. Auf live-`find`-Outputs in der unten dokumentierten Session sogar **63 %**.

### 5.2 Hebel 3 — Provider-Cache-Awareness Layer

Cache-Mechanismen sind **technisch grundverschieden** zwischen den Providern. Hebel 3 ist deshalb keine eine Aktion, sondern ein **Switch über den erkannten Provider**, mit pro Provider unterschiedlicher Implementation. Voraussetzung für alle Varianten: deterministische Compression aus 4.2 — wäre die Compression nicht byte-stabil, würde keiner der Cache-Mechanismen greifen.

Die Provider-Erkennung sitzt in einer dedizierten Helper-Funktion und nutzt mehrere Signale:

```ts
function detectProvider(payload, modelId): Provider {
  // 1. Tool-Format-Inspektion (zuverlässig)
  if (tools[0] has "input_schema")     return "anthropic";
  if (tools[0].type === "function")    return "openai";
  // 2. Anthropic-spezifisches `system`-Feld
  if (payload.system existiert)        return "anthropic";
  // 3. Model-ID-Heuristiken (Fallback)
  if (id startsWith "claude")          return "anthropic";
  if (id matches /^(gpt-|o1|o3|o4)/)   return "openai";
  if (id startsWith "gemini")          return "google";
  if (id matches /qwen|llama|mistral/) return "ollama";
  return "unknown";
}
```

Auf Basis dieser Erkennung springen unterschiedliche Cache-Strategien an:

#### 5.2.1 Anthropic API — `cache_control` Marker

Anthropic cached den gesamten Tools-Array, sobald ein `cache_control: { type: "ephemeral" }` auf einem Tool-Eintrag sitzt. Die Extension setzt den Marker auf das letzte Tool:

```ts
if (provider === "anthropic") {
  merged[lastIdx] = { ...lastTool, cache_control: { type: "ephemeral" } };
  stats.cachedRequests++;
  stats.cacheProviderMode = "marker";
}
```

Effekt: ab dem 2. LLM-Call zahlt der Tool-Block ~10 % (cache_read_input_tokens) statt 100 % der Input-Token-Kosten — multipliziert mit der TSCG-Ersparnis aus Hebel 1, nicht additiv. Über einen 20-Schritt-Loop kumuliert das auf ~85-90 % weniger Tool-Token-Cost.

#### 5.2.2 OpenAI API — automatische Prefix-Caching, kein Marker nötig

OpenAI's API cached **automatisch** Input-Prefixes ab 1024 Tokens, sobald sie identisch zu einem vorherigen Call sind. Es gibt keinen `cache_control`-Marker. Voraussetzung: der Prefix muss byte-stabil sein — was unsere deterministische TSCG-Compression genau liefert.

Die Extension setzt deshalb keinen Marker, sondern **zählt** Calls die für Auto-Cache qualifizieren (Heuristik: Tool-Block ≥ 1024 Tokens nach Compression):

```ts
if (provider === "openai" && compressedTokens >= 1024) {
  stats.cachedRequests++;
  stats.cacheProviderMode = "auto";
}
```

Effekt: 50 % Rabatt auf gecachte Tool-Tokens bei OpenAI ab dem 2. Call. **Wir tun nichts aktiv** — wir profitieren davon, dass TSCG deterministisch komprimiert.

#### 5.2.3 Ollama / lokale Modelle — kein Cache-Mechanismus

Ollama hat kein Token-Pricing und keinen API-level Tool-Cache. Modell-State bleibt im VRAM, aber das ist orthogonal zu Hebel 3. Die Extension macht hier **keine Aktion** — `lastProvider: "ollama"`, `cacheProviderMode: null`. Das ist korrekt, weil bei Ollama die Wirkung von Hebel 1+2 (Tokens reduzieren = Inferenzzeit reduzieren) ausreicht.

#### 5.2.4 Google Gemini API — Skeleton-Hook, noch nicht aktiv

Google's API kennt einen separaten `cachedContents`-Endpoint: man legt einen Cache **vor der Generation** explizit an, bekommt einen Cache-Namen, und referenziert diesen im nachfolgenden `generateContent`-Call statt den Inhalt inline mitzuschicken. Komplett anderer Mechanismus als bei Anthropic (Marker) oder OpenAI (auto).

Im Code sitzt ein klar markierter Skeleton-Hook, an dem ein PR sofort andocken kann:

```ts
} else if (provider === "google") {
  // TODO(gemini): Use cachedContents API.
  // Plan: on first call, POST to /v1beta/cachedContents with the tools
  // payload and TTL; receive a cache name; on subsequent calls reference
  // the cache name in `cachedContent` field instead of inlining tools.
}
```

**Status:** noch nicht implementiert. Hängt davon ab, ob Pi einen `google` Provider supporten wird (aktuell nicht im Default). Implementierungsaufwand: schätze ein bis zwei Tage Entwicklung plus Tests, weil cachedContents-API und google-genai-SDK eingebunden werden müssen.

#### 5.2.5 Telemetrie pro Provider

Die Stats halten zwei zusätzliche Felder:

```ts
cachedRequests: number;          // gesamt: Marker gesetzt ODER auto-eligibel
cacheProviderMode: "marker" | "auto" | null;   // letzter erkannter Modus
lastProvider: Provider;          // letzter erkannter Provider
```

Im Footer erscheint dadurch:

```
TSCG: ... · cache 12 marker (aggressive)        ← Anthropic-Lauf
TSCG: ... · cache 8 auto (aggressive)           ← OpenAI-Lauf
TSCG: ... (aggressive)                          ← Ollama-Lauf, kein Cache-Feld
```

Im `/tscg status` zusätzlich der erkannte Provider und der letzte Cache-Modus.

---

## 6. Reale Messdaten

Live-Session vom 28. April 2026, Pi v0.70.5, Modell `qwen3.5:9b` über lokales Ollama. **Endstand der Session:**

```
TSCG: last −8.3% · session −8.3% · res −62% · saved 14.6k (aggressive)
Pi:   ↑503k · ↓15k · 8.9%/262k context (auto)
```

| Metrik | Wert | Interpretation |
|--------|------|----------------|
| Schema-Compression (Hebel 1) | **8.3 %** stabil über die ganze Session | Beobachtung: konstant über *alle* Requests, weil Pi denselben Built-in-Tool-Set (read/bash/edit/write/grep/find/ls) bei jedem Call schickt → strukturelle Obergrenze auf diesem Set. Siehe Abschnitt 7. |
| Result-Compression (Hebel 2) | **62 %** | Dominanter Hebel. Greift bei `find`/`bash` mit großen Outputs (z.B. ein `find ~/pi-extensions/pi-tscg/node_modules` mit 11 356 Datei-Pfaden — über 4 000 Tokens, head/tail-Truncation aktiv). |
| Cache-Awareness (Hebel 3) | korrekt no-op | Provider-Detection erkannte `ollama`. Bei Ollama gibt es kein API-Cache, also keine Aktion. Mit `pi --provider anthropic --model claude-haiku` würde Hebel 3 in der Variante 5.2.1 anspringen (cache_control); mit OpenAI-API in Variante 5.2.2 (auto-Prefix-Cache via Determinismus). |
| Total saved | **14.6k Tokens** | ≈ 10 500 Wörter; Aufteilung: ~700 Schema, ~13 900 Result. |

### Verhältnis zur Gesamt-Token-Last

Pi hat in dieser Session insgesamt **↑503 K Input-Tokens** an das Modell geschickt. Davon:

- **Tool-Schemas (~6 K pro Request × N Requests)** → Hebel 1 wirkt direkt, aber der Anteil am Gesamt-Input ist klein
- **Tool-Results (Bash/Find/Read mit großen Outputs)** → Hebel 2 wirkt direkt
- **Conversation-History** (kumulierte vorherige Messages, System-Prompt, User-Turns) → wächst mit jedem Turn, **TSCG greift hier nicht** (siehe 8.3 als möglicher künftiger Hebel)

Das erklärt, warum 14.6 K saved sich zur ↑503 K Total-Last als „nur" 2.9 % anfühlt — die größere Hälfte des Token-Verbrauchs sitzt in der Conversation-History, an die TSCG nach Design nicht rangeht. Die wirklich relevante Vergleichsbasis ist Tool-Schemas + Tool-Results, nicht Total-Input — und auf dieser Basis ist die Wirkung deutlich (Schemas sauber an strukturellem Cap, Results dominant komprimiert).

### Aufgaben in der Session

- **Geschichten-Generierung** — Markdown-Datei (`der-furchtbare-wald-kaerger.md`) im Ordner `bear-story`. Reine `write`-Operationen, Result-Compression korrekt inaktiv (Edit/Write ist hard ausgeschlossen).
- **Interaktive HTML-Seite** — Sonnensystem mit Tag/Nacht-Animation (`sonnensystem-erd-animation.html`, `sonnensystem-v2.html` mit Mond-Erweiterung). 8-10 Tool-Calls, dominiert durch `write`/`edit`.
- **Datei-Inventar-Test** — `find ~/pi-extensions/pi-tscg/node_modules -type f \( -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.ts" \)` plus `wc -l`. Ergebnis: **11 356 Dateien**. Der erste `find`-Call lieferte einen Output deutlich über 4 000 Tokens — exakt der Fall, für den Hebel 2 designed ist. Truncation-Marker `[TSCG: N Zeilen / ~Xk Tokens ausgelassen — head + tail behalten]` wurde im Tool-Output sichtbar gesetzt, das Modell hat die anschließende `wc -l`-Folgeaktion korrekt durchgeführt.
- **Bericht-Erstellung** — Pi hat eigenständig eine `js-ts-dateien-bericht.md` plus eine als `.pdf` benannte Textversion (kein echtes PDF mangels Konverter) erzeugt. Erneut `write`-dominiert.

### Profil-Wechsel

Während der Session von `balanced` auf `aggressive` umgeschaltet (`/tscg profile aggressive`). Der zusätzliche Effekt von `aggressiveMaxDescChars=200` ist auf Pi-Built-ins gering, weil deren Top-Level-Descriptions alle unter 250 chars liegen.

---

## 7. Strukturelle Beobachtung — Description-Only-Cap auf Pi-Built-Tools

Die 8.3 %-Konstanz auf Pi's Built-in-Tools verdient eine eigene Erklärung, weil das für TSCG-Adoption auf vielen Coding-Agents relevant sein wird.

### Pi's Tool-Schemas sind bereits maximal kompakt

Beispiel (aus `dist/core/tools/`):

```js
// bash.js
command: Type.String({ description: "Bash command to execute" }),
                                     // 24 chars, 0 Filler
timeout: Type.Optional(Type.Number({
  description: "Timeout in seconds (optional, no default timeout)" })),
                                     // 47 chars, sehr knapp

// grep.js
pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
                                     // 39 chars, kein DRO-Material
```

Auf solchen Strings haben **SDM** (Filler-Pattern), **DRO** (Verbose-Phrase → Symbol) und **CCP** (Closure-Append) wenig Hebel. Nur die langen Top-Level-Tool-Descriptions (typisch 200-400 chars) bieten Substanz — aber das sind 7 Strings auf insgesamt ~6 000 Schema-Tokens.

### Was das für `@tscg/core` als Erkenntnis hergibt

Description-Only-Mode hat strukturell zwei verschiedene Use-Cases mit sehr unterschiedlichem Yield:

- **High-yield:** MCP-Server-Tools (Notion, Figma, Supabase…) mit verbosen, mehrzeiligen Descriptions, Examples, Constraints → 30-50 % messbar
- **Low-yield:** kompakte Built-in-Tools eines Coding-Agents (Pi, ähnlich vermutlich Aider/Continue) → 8-15 % strukturell maximal

**Vorschlag:** könnte sich als Hinweis im README oder als Logger-Output (`appliedPrinciples` enthält schon die Info) lohnen — Anwender könnten sonst denken, TSCG wäre wirkungslos, dabei haben sie nur den Worst-Case-Input-Set erwischt.

---

## 8. Roadmap und Vision

### 8.1 Kurzfristig — npm-Veröffentlichung als `pi-tscg`

Aktuell läuft die Extension lokal aus `~/pi-extensions/pi-tscg/`. Geplant ist die Publikation auf npm, sodass jeder Pi-Nutzer mit einem Befehl

```bash
pi install pi-tscg
```

**alle drei Hebel direkt aktivieren** kann — ohne Manual Setup, ohne `tar -xzf`, ohne `pi install <localpath>`. Anthropic-Cache greift ab Call 1, Schema-Compression läuft, Result-Compression läuft.

Vorbereitung dafür: peerDependencies auf `@mariozechner/pi-coding-agent` und `@tscg/core` deklariert, Build-Pipeline minimal (Pi lädt `.ts`-Extensions direkt via Node-TS-Loader).

### 8.2 Mittelfristig — Pi-Plugin-Verzeichnis-Eintrag

Pi pflegt eine kuratierte Liste registrierter Extensions (`@ollama/pi-web-search` ist im Default-Setup z.B. schon drin). Sobald `pi-tscg` auf npm liegt, kann es ins Pi-Plugin-Verzeichnis aufgenommen werden — dann sehen Nutzer die Extension direkt im Pi-Setup-Flow als optionalen Switch („Compression: ON").

Das wäre für `@tscg/core` ein sehr direkter Distribution-Channel: jeder Pi-Nutzer hat **Ein-Klick-Zugriff** auf TSCG, und über die Pi-Extension werden die Core-API-Aufrufe transparent gemacht. Adoption-Multiplier ohne dass Pi den TSCG-Code im eigenen Tree haben muss.

### 8.3 Langfristig — Optionen zum Ausweiten

| Idee | Wirkung | Aufwand | Risiko | Status |
|------|---------|---------|--------|--------|
| **Strategie A:** JSON-Schema-Pruning (`$schema`, `$id`, `$comment`, leere `examples`/`enum`, `default: undefined` droppen — `additionalProperties` und `$ref` bewusst behalten, weil semantisch) | +5-15 % auf Hebel 1 (Pi-Built-ins) bis +25-35 % (MCP-Tools mit Schema-Boilerplate) | gering | sehr niedrig | **implementiert** |
| **Strategie C:** Full-TSCG mit Reverse-Map im `tool_call` Hook (Symbol-Aliasing rückübersetzen) | +50-65 % auf Hebel 1 | hoch | mittel — Edge-Cases mit parallelen Tool-Calls | offen |
| **MCP-Auto-Erkennung:** wenn registrierte MCP-Server da sind, Profil automatisch auf `balanced` für deren Tools (high-yield) und `light` für Pi-Built-ins (low-yield) | besseres User-Erlebnis | mittel | niedrig | offen |
| **Live Cache-Hit-Logging** für Hebel 3 via `after_provider_response` Hook (Anthropic-`usage`-Felder auswerten, OpenAI-`cached_tokens` ebenso) | Telemetrie/Debugging | gering | keins | offen |
| **Gemini-Provider-Support für Hebel 3** (`cachedContents`-API-Integration, siehe §5.2.4) | nutzt Hebel 3 auch für Gemini-Nutzer | mittel — neue API-Integration | niedrig | **Skeleton im Code, PR-ready** |

### 8.4 Was `@tscg/core` davon haben könnte

Drei konkrete Anregungen aus dem Praxis-Lauf:

1. **`compressFreeText(text, opts)` Convenience-API** — Tool-Output-Compression als first-class Use-Case neben Tool-Schema-Compression. Dann fällt Hebel 2 in jede Pi/Aider/Continue-Integration nahezu trivial.
2. **`outputFormat: "compact"` mehr dokumentieren** — bin nicht sicher, was der echte Effekt davon im description-only Mode ist; ein Beispiel-Snippet im README würde helfen.
3. **Ein offizielles Pi-Adapter-Snippet im `examples/`-Ordner** — falls du Interesse hast, schick ich gerne PR mit `mapPiModelId()` und der `before_provider_request`-Pipeline als Referenz für andere Tool-Schemas-Extensions.

---

## 9. Zusammenfassung in einem Satz

Mit `@tscg/core` als Compression-Engine und Pi's Hook-System als Distribution-Vehikel gibt es einen pragmatischen Weg, TSCG **nicht als Library, sondern als On-Demand-Plugin** an Coding-Agent-Nutzer zu bringen — mit messbarem Effekt (14.6 K Tokens / Session bei einem 9B-Lokalmodell auf einem 7-Tools-Worst-Case-Set), klarem Skalierungspfad (MCP-Tools, Anthropic-Cache) und ohne dass der Agent selbst TSCG-Code mergen muss.

---

**Repo-Status (Stand 28.04.2026):**
- Lokal lauffähig, typgecheckt (`tsc --noEmit --strict` exit 0), live verifiziert auf Ollama+qwen3.5:9b
- npm-Paket gebaut: `pi-tscg-0.2.0.tgz` (27.3 KB packed, 82.3 KB unpacked, 7 Dateien)
- Pre-Release-Code-Review durchlaufen — 3 Blocker identifiziert und gefixt (cache_control nur auf wirklich-Anthropic-formatierte Tools, `$ref` aus Pruning-Liste entfernt weil load-bearing in MCP-Schemas, Tool-Exclusion auf case-insensitive normalisiert)
- Strategie A implementiert
- Veröffentlichungsweg: `npm publish --access public` → automatische Listung auf [pi.dev/packages](https://pi.dev/packages) durch `pi-package`-Keyword

Als Nächstes für die Pi-Seite:
- Mario Zechner kontaktieren mit Verweis auf diese Doku, Bitte um Aufnahme ins offizielle Plugin-Verzeichnis
- Nutzer-Workflow nach Aufnahme: `pi install pi-tscg` → fertig, alle drei Hebel aktiv

Wenn du Lust hast, die `mapPiModelId`-Map oder den `compressFreeText`-Vorschlag als PR im Core zu sehen — sag Bescheid, ich kann das vorbereiten.

— Dominic

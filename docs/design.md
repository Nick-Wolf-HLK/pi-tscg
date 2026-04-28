# pi-tscg — Design

## Zweck

Pi-Extension, die jeden ausgehenden LLM-Request transparent durch
[TSCG](https://github.com/SKZL-AI/tscg)
schickt und die Tool-Schemas komprimiert. Resultat: ~28 % weniger Tokens
in der `tools`-Sektion (description-only mode), ohne dass Pi oder das LLM
etwas davon merken müssen.

## Architektur

Eine einzelne Extension-Datei (`extensions/tscg.ts`), die Pi beim Start
auto-discovered.

```
   Pi-Agent                                      LLM-Provider
       │                                              ▲
       │  payload { model, messages, tools, ... }     │
       ▼                                              │
   ┌──────────────────────────────┐                   │
   │  before_provider_request     │                   │
   │  ────────────────────────    │                   │
   │  pi-tscg hook:               │                   │
   │   1. detect tool format      │                   │
   │   2. split exclude/include   │                   │
   │   3. compressDescriptions()  │                   │
   │   4. merge back              │                   │
   │   5. update stats            │                   │
   └──────────────────────────────┘                   │
       │                                              │
       │  payload { tools: [compressed] }  ───────────┘
       ▼
```

Tool-**Namen** und JSON-Schema bleiben unverändert (`compressDescriptions`
fasst nur `description`-Felder an). Damit funktioniert der Roundtrip ohne
Übersetzungstabelle: das LLM ruft `read_file` auf, Pi dispatcht
`read_file` — keine Magie nötig.

## Komponenten

| Datei | Verantwortung |
|---|---|
| `extensions/tscg.ts` | Hook, Command, Stats, Settings I/O |

Eine Datei, weil die Extension überschaubar bleibt und Pi `.ts`-Dateien
unter `extensions/` automatisch lädt.

## Settings

Persistiert in `<cwd>/.pi/tscg.json` (Projekt) mit Fallback auf
`~/.pi/tscg.json` (User-global). Eigene Datei, nicht Pis
`settings.json`, damit kein Merge-Konflikt mit Pi entsteht.

```json
{
  "enabled": true,
  "profile": "balanced",
  "excludeTools": [],
  "showFooterStats": true
}
```

Defaults greifen, wenn die Datei fehlt oder ein Feld nicht gesetzt ist.

## Commands

`/tscg` mit folgenden Subcommands:

| Form | Wirkung |
|---|---|
| `/tscg` | Status + kumulierte Session-Stats |
| `/tscg on` / `/tscg off` | Toggle, sofort wirksam |
| `/tscg profile <name>` | `conservative` / `balanced` / `aggressive` / `auto` |
| `/tscg exclude <toolname>` | Tool von Kompression ausnehmen |
| `/tscg include <toolname>` | Ausschluss aufheben |
| `/tscg reset` | Session-Stats auf 0 |

## Footer-Indikator

Wenn `showFooterStats: true`: `ctx.ui.setStatus("tscg", "TSCG: −47% · saved 24.3k tokens")`
nach jedem komprimierten Request.

## Modell-Mapping

Pi-Modell-IDs → TSCG-`ModelTarget`:

| Pi-ID-Pattern | TSCG-Target |
|---|---|
| `claude-opus-*` | `claude-opus` |
| `claude-sonnet-*` | `claude-sonnet` |
| `claude-haiku-*` | `claude-haiku` |
| `gpt-5*` | `gpt-5` |
| `gpt-4o*mini*` | `gpt-4o-mini` |
| `gpt-4*`, `o1-*`, `o3-*` | `gpt-4` |
| sonst | `auto` |

Modell wird per Request aus `ctx.model.id` gelesen (sicher gegen
Mid-Session-Modellwechsel).

## Edge-Cases

| Szenario | Verhalten |
|---|---|
| `compressDescriptions()` wirft | Original-Payload zurück, einmalige Notify, Fehler in Log |
| Kein `tools`-Array im Payload | No-op |
| `tools.length === 0` | No-op |
| Provider unbekannt (kein Anthropic/OpenAI-Format) | Tools unverändert (TSCG returned sie 1:1) |
| Tool in `excludeTools` | Vor Kompression rausfiltern, nach Kompression unverändert wieder einfügen |
| Komprimiert > Original (sehr selten) | Trotzdem komprimiert verwenden — TSCG ist deterministisch und Diff klein |
| Settings-Datei korrupt | Defaults nutzen, einmalige Warn-Notify |

## Was bewusst nicht drin ist (YAGNI)

- **Full-mode-Kompression** (~71 % statt ~28 %) erfordert Injection in den
  System-Prompt + leere `tools`-Array → bricht Pi's Tool-Dispatching.
- **Per-Provider-Konfiguration** — eine globale Profile-Setting reicht.
- **Custom Principles-Toggle** — die 8 TSCG-Principles brauchen keine
  Endbenutzer-UI; Profil reicht.
- **Persistente Cross-Session-Stats** — Session-Stats genügen, mehr wäre
  Daten-Bloat.

## Testing

`tsc --noEmit` validiert Typen gegen die echte Pi-API. Funktionstest läuft
manuell über `pi install ./pi-tscg` in einem Test-Projekt + ein paar
Prompts mit reichlich Tool-Calls.

## Lizenz & Credits

MIT, eigenes Copyright. `@tscg/core` ist Dependency (nicht vendored), Furkans
LICENSE wandert über `node_modules/@tscg/core/LICENSE` mit. Im README + in
`NOTICES.md` wird Furkan/SKZL-AI explizit erwähnt.

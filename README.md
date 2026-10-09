# context-guard

**Una mod per Claude Code che ti avvisa quando la chat si sta riempiendo e prepara da sola il passaggio alla chat successiva.**

> *In English:* a Claude Code plugin (function hooks) that watches the context window. At 45% it warns you; at 60% it asks the model to write a `HANDOFF.md` (what was done, what's next, a ready-to-paste prompt for a fresh chat) and to keep a short project "grimoire" up to date in `CLAUDE.md`. A pixel-art owl pops up, Pokémon-style, to tell you it's time to switch chats. Docs below are in Italian.

<p align="center"><img src="docs/bibliotecario.svg" alt="Il Bibliotecario: un gufo in pixel art accanto a un riquadro di dialogo in stile Pokémon" width="560"></p>

## Perché esiste

Nelle sessioni lunghe il contesto si riempie: le risposte peggiorano, la compattazione automatica perde dettagli e aprire una chat nuova significa rispiegare tutto. context-guard rende quel passaggio una cosa che succede da sola, prima che sia troppo tardi:

- ti dice **quando** è il momento di cambiare chat;
- scrive **cosa** la chat nuova deve sapere, nel progetto e non in chat;
- ti dà **il prompt** da incollare, a un tasto di distanza.

## Cosa fa

| Contesto | Azione |
| --- | --- |
| 45% | Avviso una tantum. Da qui in poi la status line mostra `ctx NN%`. |
| 60% | Il modello scrive l'handoff e aggiorna il grimorio, poi spunta il Bibliotecario. |
| 70%, 80%, 90% | Riscrive gli stessi file, così restano aggiornati. |
| `/ctx-handoff` | Fa tutto subito, a qualsiasi percentuale. |

Dopo un `/compact` o un `/clear` le soglie ripartono da zero.

### I due file

**`HANDOFF.md`**, specifico della sessione: cosa è stato fatto, stato attuale, prossimi passi numerati e un blocco con il prompt per la chat nuova.

**Il grimorio in `CLAUDE.md`**, stabile nel tempo: ragion d'essere del progetto, architettura e regole da rispettare. Vive tra due marcatori e il resto del file non viene mai toccato:

```markdown
<!-- context-guard:start -->
## Grimorio del progetto (aggiornato da context-guard il 2026-10-09)
...
<!-- context-guard:end -->
```

### Il Bibliotecario

Quando i file sono scritti, un gufo in pixel art 20x20 scivola dentro da sinistra con un riquadro di dialogo in stile Pokémon. Il testo appare a macchina da scrivere, poi lampeggia il cursore ▼. Nell'app desktop è un `Svg`, sul terminale un `Raster` colorato a mezzi blocchi.

- `C` copia il prompt per la nuova chat negli appunti.
- `O` o Esc chiude il dialogo.

## Le regole di sicurezza

La mod scrive file nei tuoi progetti, quindi è costruita per non rompere niente:

- **Handoff scritto da te:** se il file esiste e non l'ha scritto la mod, nessuna riga viene toccata. La mod aggiorna solo una sua sezione marcata sotto il titolo.
- **Handoff con un altro nome:** se trova `PASSAGGIO.md`, `consegne.md`, `NEXT_STEPS.md`, `handoff-*.md` o simili, aggiorna quello invece di crearne un altro.
- **Quale CLAUDE.md:** dentro un repo git risale al massimo fino alla root del repo. Fuori da un repo usa solo la cartella della sessione. Un CLAUDE.md "di cartella superiore", per esempio quello del Desktop, non viene mai toccato.
- **Controllo sul progetto:** prima di scrivere il grimorio la mod visita la cartella e verifica che i percorsi citati tra backtick esistano davvero. Se ne cita almeno 3 e meno del 60% esiste, il grimorio viene scartato e un avviso elenca i percorsi mancanti. Così il riassunto di un progetto non può finire nel CLAUDE.md di un altro.
- **Controllo all'avvio:** a ogni nuova sessione la mod verifica il grimorio già presente e avvisa se sembra di un altro progetto.
- **Niente doppioni:** il modello ha l'istruzione di non ricopiare ciò che è già in CLAUDE.md, AGENTS.md e nei file importati.

## Installazione

Serve Claude Code con il supporto ai plugin di function hooks. La mod è sviluppata e testata con la versione 2.1.278.

```bash
claude plugin marketplace add Rikdum18/context-guard
```

```bash
claude plugin install context-guard@riccardo-mods
```

Le sessioni avviate da quel momento caricano la mod, sia nel terminale sia nell'app desktop. Per aggiornarla:

```bash
claude plugin update context-guard@riccardo-mods
```

## Configurazione

Da `/plugin configure context-guard@riccardo-mods` in una sessione, oppure in `settings.json` sotto `pluginConfigs["context-guard"].options`.

| Campo | Default | Significato |
| --- | --- | --- |
| `warnAt` | 45 | Percentuale dell'avviso |
| `writeAt` | 60 | Percentuale della prima scrittura |
| `repeatEvery` | 10 | Riscrive ogni N punti oltre `writeAt`, 0 per scrivere una volta sola |
| `handoffFile` | `HANDOFF.md` | Nome del file di handoff |
| `updateClaudeMd` | true | Aggiorna il grimorio in CLAUDE.md |

## Come funziona

È un plugin di *function hooks*: un modulo TypeScript che il motore di Claude Code carica ed esegue in un ambiente isolato, senza DOM e senza Node. Tutto passa dall'interfaccia `$` del motore.

- **`turn.complete`:** a fine turno legge il riempimento del contesto con `$.session.usage()` e decide se avvisare o scrivere.
- **`$.model.fork`:** fa al modello una domanda sulla trascrizione della sessione stessa, così la richiesta riusa la cache dei prompt invece di rimandare tutto da capo.
- **`$.fs`:** scrive i file e visita la cartella per il controllo sul progetto.
- **`ui.render` sul componente `Pane`:** disegna il dialogo del Bibliotecario. Un timer da 50 ms fa avanzare l'animazione tramite `$.state`, che sopravvive anche al ricaricamento del modulo.
- **`session.compact` e `session.end`:** azzerano le soglie dopo una compattazione o un `/clear`.

```
context-guard/
├── .claude-plugin/plugin.json   manifest e opzioni configurabili
├── hooks/
│   ├── hooks.json               punta a register.tsx
│   ├── register.tsx             gli hook e il dialogo
│   ├── logic.ts                 logica pura: soglie, prompt, merge dei file, controllo sul progetto
│   ├── sprite.ts                il gufo e i suoi renderer SVG e Raster
│   └── *.test.ts                38 test
└── types/index.d.ts             contratto dello stato in $.state
```

La radice del repository è anche il marketplace (`.claude-plugin/marketplace.json`), per questo l'installazione è un solo comando.

## Sviluppo

```bash
claude plugin validate ./context-guard
```

```bash
claude plugin test ./context-guard
```

Per provare le modifiche senza installarle:

```bash
claude --plugin-dir ./context-guard
```

## Limiti noti

- Il riempimento viene letto a fine turno: un turno lunghissimo che passa dal 40% al 75% riceve avviso e scrittura insieme.
- Ogni scrittura costa una lettura in cache della trascrizione più qualche migliaio di token generati.
- Un aggiornamento della mod vale solo per le sessioni avviate dopo: quelle già aperte continuano con la versione vecchia.
- Il controllo sul progetto si basa sui percorsi citati: un grimorio che ne cita meno di 3 non viene giudicato.
- L'API dei function hooks è in accesso anticipato e può cambiare tra le versioni di Claude Code.

## Licenza

[MIT](LICENSE)

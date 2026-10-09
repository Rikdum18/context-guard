# Changelog

## 0.5.0
- Grimorio in attesa di conferma quando la sessione ha letto contenuti esterni: web, browser, connettori MCP, comandi shell che scaricano. Il Bibliotecario mostra le modifiche con i tasti Applica e Scarta.
- Nuovo comando `/ctx-grimorio` per riaprire il grimorio in attesa.
- Filtri che bloccano il grimorio se contiene istruzioni iniettate: ignorare istruzioni, eseguire codice scaricato, inviare credenziali, disattivare protezioni, blocchi codificati, caratteri invisibili, HTML attivo, indirizzi sconosciuti.
- Le regole negative come "non condividere mai il token" non vengono bloccate.

## 0.4.2
- Il nome del file di handoff configurato deve essere un semplice `.md` nella root: niente percorsi fuori dal progetto.
- Nessuna scrittura attraverso link simbolici.
- I marcatori `context-guard` vengono tolti dal testo del modello.
- Il modello non trascrive nel grimorio istruzioni provenienti da contenuti esterni.
- Un `package.json` malformato non blocca più la scrittura.

## 0.4.1
- Test con progetti di esempio generici.
- Metadati del repository nel manifest.

## 0.4.0
- Controllo sul progetto: il grimorio viene scartato se cita percorsi che nella cartella non esistono.
- Al modello vengono passati cartella, repo, `package.json` e grimorio attuale del progetto.
- All'avvio della sessione segnala un grimorio che sembra di un altro progetto.

## 0.3.0
- Un handoff scritto a mano non perde nulla: il mod aggiorna solo una sua sezione marcata.
- CLAUDE.md cercato solo dentro il repo git, mai sopra la cartella della sessione fuori da un repo.
- Il modello non ripete quanto già scritto in CLAUDE.md, AGENTS.md e file importati.

## 0.2.x
- Sprite del Bibliotecario in pixel art 20x20: `Svg` sul desktop, `Raster` a mezzi blocchi sul terminale.
- Riuso di un file di handoff esistente con altro nome (`PASSAGGIO.md`, `NEXT_STEPS.md`, ...).

## 0.1.x
- Avviso al 45%, scrittura di `HANDOFF.md` e del grimorio al 60%, comando `/ctx-handoff`.
- Dialogo del Bibliotecario con copia del prompt.

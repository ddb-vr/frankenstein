# Demo tasks

Type these exactly, in Czech, as a real accountant would. Never mention skills, tools or code. Wording follows `ares-notes.md`: ask only what ARES can answer (existence, active/dissolved, name, address, legal form, DIČ), not VAT reliability or bank accounts.

## Task 1 – verify one supplier from an invoice (session 1)

Starts with no installed skill, so the agent detects the gap, runs the intake (grill me, see `answers.md`), confirms the PRD and builds the skill.

> Přišla mi faktura od Alza.cz a.s., IČO 27082440, DIČ CZ27082440, sídlo Jankovcova 1522/53, Praha 7. Než ji zaplatím, potřebuju ověřit, že ta firma opravdu existuje, není zaniklá a že název, sídlo a DIČ sedí s tím, co je v ARESu. Tohle budu dělat u dodavatelů pravidelně.

Expected outcome after the build: Alza.cz a.s. found, active, address and DIČ `CZ27082440` match, legal form akciová společnost.

## Task 2 – check a whole list of suppliers (new session)

Start a **new** Claude Code session so the only shared state is the installed skill. The agent should find the skill from task 1 in `registry.json` and use it, with no new intake.

> Mám seznam dodavatelů v demo/suppliers.csv. Projeď mi je prosím všechny přes ARES a řekni mi, které jsou v pořádku a u kterých je nějaký problém.

Expected outcome: 7 suppliers found and active; `12345678` reported as an invalid IČO (bad checksum); Komerční banka found but without DIČ in ARES (VAT group – see `ares-notes.md`), reported as a note, not as an error.

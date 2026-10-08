# ARES API – what a company lookup by IČO really returns

Verified live on 2026-10-08 against the public ARES REST API (no key, no login).

## Sources

- Endpoint used: `GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}` with `Accept: application/json`.
- OpenAPI spec (machine-readable, the actual documentation of the fields): `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs` – title "ARES: REST API - veřejné", version 1.4.0.
- Swagger UI: `https://ares.gov.cz/swagger-ui/`
- Developer info page: `https://ares.gov.cz/stranky/vyvojar-info` (JavaScript app, not readable without a browser; usage limits were not verified from it).
- Code lists (legal forms, source states): `POST https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ciselniky-nazevniky/vyhledat` with body `{"kodCiselniku": "PravniForma", "zdrojCiselniku": "res"}` or `{"kodCiselniku": "StavZdroje", "zdrojCiselniku": "com"}`.

Domain needed for the skill and for fixture recording: `ares.gov.cz` only. Before the demo, set
`FIXTURE_ALLOWED_DOMAINS=ares.gov.cz` in `.env` (the recorder reads it only from `.env`, not from the shell
environment). Without it the build stops at the first fixture recording, and the agent cannot fix that itself
because it cannot read or edit `.env`.

## What one lookup returns

Example: IČO `45274649` (ČEZ, a. s.), HTTP 200. Relevant fields (the full response also contains NACE codes and a `dalsiUdaje` array with per-register duplicates):

| Area | Field | Example value | Meaning |
| --- | --- | --- | --- |
| Identity | `ico` | `45274649` | IČO, always 8 digits |
| Identity | `obchodniJmeno` | `ČEZ, a. s.` | Registered business name |
| Identity | `datumVzniku` | `1992-05-06` | Date of establishment |
| Identity | `datumZaniku` | (absent) | Date of dissolution; present only for dissolved subjects |
| Identity | `datumAktualizace` | `2026-09-17` | Last update of the ARES record |
| Address | `sidlo.textovaAdresa` | `Duhová 1444/2, Michle, 14000 Praha 4` | Ready-to-print registered address |
| Address | `sidlo.nazevUlice`, `cisloDomovni`, `cisloOrientacni`, `nazevObce`, `psc`, `kodStatu` | `Duhová`, `1444`, `2`, `Praha`, `14000`, `CZ` | Structured address parts (`psc` is a number) |
| Legal form | `pravniForma` | `121` | Code only; name comes from the `PravniForma` code list (121 = Akciová společnost, 112 = Společnost s ručením omezeným, 101 = Fyzická osoba podnikající dle živnostenského zákona, 301 = Státní podnik) |
| Tax | `dic` | `CZ45274649` | Tax ID (DIČ); absent for some subjects |
| Tax | `financniUrad` | `013` | Competent tax office code |
| Registers | `seznamRegistraci.stavZdrojeDph` | `AKTIVNI` | State of the subject in the VAT payer register (see below) |
| Registers | `seznamRegistraci.stavZdrojeVr` | `AKTIVNI` | State in the Commercial Register |
| Registers | `primarniZdroj` | `ros` | Primary source register |

Source state values (`StavZdroje` code list): `AKTIVNI`, `BUDOUCI`, `HISTORICKY`, `LOGICKY_SMAZANY`, `NEEXISTUJICI`, `POZASTAVENY`, `ZANIKLY`.

## Error responses (verified)

| Input | HTTP | Body `kod` / `subKod` |
| --- | --- | --- |
| `99999994` (valid checksum, no such subject) | 404 | `NENALEZENO` / `VYSTUP_SUBJEKT_NENALEZEN` |
| `00000000`, `12345678` (8 digits, invalid checksum) | 404 | `NENALEZENO` / `VYSTUP_SUBJEKT_NENALEZEN` |
| `abc` (not 8 digits) | 400 | `CHYBA_VSTUPU` / `VSTUP_NEVALIDNI_FORMAT_ICO` |

Important: ARES only checks the format (`[0-9]{8}`), **not the IČO checksum** (mod 11). `12345678` has an invalid checksum but ARES answers 404 "not found", not 400. If the demo should distinguish "invalid IČO" from "company not found", the skill must validate the checksum itself, before any network call.

## Is VAT payer status available?

**Partly – and not reliably enough to promise it in the demo.**

- ARES does expose `dic` and `seznamRegistraci.stavZdrojeDph` (`AKTIVNI` = the subject is active in the VAT register). There is no dedicated VAT endpoint in the API (no `ekonomicke-subjekty-dph` path in the OpenAPI spec).
- Members of a **VAT group** show up as not registered: Komerční banka (`45317054`) and Raiffeisenbank (`49240901`) return no `dic` and `stavZdrojeDph: NEEXISTUJICI`, although both are VAT payers via a group registration. A naive "is VAT payer" check would give a false "no".
- **Unreliable VAT payer status (nespolehlivý plátce) and the published bank accounts are not in ARES at all.** They live in the Ministry of Finance VAT register (ADIS, `adisspr.mfcr.cz`, a separate SOAP service). That is out of scope for an ARES-only skill.

### Adjusted demo task wording

Do not ask "je to spolehlivý plátce DPH?" or "sedí bankovní účet?". Ask what ARES can answer:

> existuje firma s tímto IČO, není zaniklá, a sedí název, sídlo a DIČ s tím, co je na faktuře?

If someone asks about VAT, the honest answer is: "ARES ukáže DIČ a jestli je subjekt v registru DPH aktivní; spolehlivost plátce a účty jsou v registru DPH na MF, to tenhle skill nedělá." The prepared answers in `answers.md` follow this wording.

## Other observations for the demo

- Legal form code `302` (Budějovický Budvar, národní podnik) is **not** in the `PravniForma` code list from source `res`; the skill should fall back to printing the code when no name is found, or the demo should avoid relying on a full code list.
- IČOs with leading zeros (Škoda Auto `00177041`) must stay strings; spreadsheets often strip the zeros.
- Responses are small (ČEZ is about 5 kB including `dalsiUdaje`), well under the 1 MB fixture limit.

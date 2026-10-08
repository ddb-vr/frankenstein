# Prepared "grill me" answers

Ready answers for the questions the `prd` agent is likely to ask during task 1 (see `tasks.md`). When the agent offers options, pick the one matching the answer below; otherwise paste the Czech text. Facts behind each answer are in `ares-notes.md`.

Aim: one round of questions, at most two. If the agent asks something not listed here, answer briefly and prefer its first sensible option.

## Input format

**Likely question:** Co bude vstupem – jedno IČO, nebo i další údaje z faktury? Jaký formát?

> Vstupem je IČO (8 číslic, jako text, aby se neztratily úvodní nuly) a volitelně název, sídlo a DIČ tak, jak jsou na faktuře. Když údaje z faktury nezadám, chci jen vypsat, co je v ARESu.

**Likely question:** Jedno IČO, nebo i seznam najednou?

> Jedno IČO na jedno volání. Seznam si projdu tak, že to zavolám pro každý řádek.

## Output shape

**Likely question:** Co přesně má být ve výsledku?

> Pro každé IČO: jestli firma existuje, jestli je aktivní nebo zaniklá (datum zániku), oficiální název, sídlo jako jeden řádek textu, právní forma (kód a název, pokud ho znáš), DIČ, a u každého zadaného údaje z faktury jestli sedí (ano/ne). Nakonec celkový výsledek: v pořádku / problém / chyba.

**Likely question:** Jak porovnávat název a adresu – přesně, nebo volně?

> Volně: ignoruj velikost písmen, mezery navíc a rozdíly typu „a.s.“ vs. „a. s.“. Adresu porovnej podle ulice s číslem a PSČ, část obce může chybět.

## Edge cases

**Likely question:** Co když IČO nemá správný formát nebo kontrolní číslici?

> Ověř formát (8 číslic) i kontrolní součet podle modulo 11 ještě před dotazem do ARESu. Když nesedí, vrať výsledek „neplatné IČO“ a do ARESu se vůbec neptej.

**Likely question:** Co když firma v ARESu není?

> Vrať „nenalezeno“ jako normální výsledek, ne jako pád. To je pro mě problém dodavatele, ne chyba nástroje.

**Likely question:** Co když je firma zaniklá?

> Vrať ji jako nalezenou, ale s výsledkem „problém“ a datem zániku.

**Likely question:** Co když chybí DIČ?

> Není to chyba. Napiš „DIČ v ARESu není uvedeno“ jako poznámku. U některých firem (třeba banky ve skupinové registraci k DPH) DIČ v ARESu prostě není.

**Likely question:** Neznámý kód právní formy?

> Vypiš aspoň kód, název nech prázdný.

## Error behavior

**Likely question:** Co dělat, když ARES neodpovídá nebo vrátí chybu?

> Žádné opakování. Vrať výsledek „chyba“ s krátkou zprávou (např. timeout nebo HTTP kód), ať je jasné, že to není problém dodavatele, ale ověření se nepovedlo. Timeout 10 sekund.

## Network and domains

**Likely question:** Potřebuje to přístup na internet? Kam?

> Ano, jen na veřejné ARES API, doména ares.gov.cz, bez klíče a bez přihlášení. Nic jiného.

**Likely question:** Ověřovat i spolehlivého plátce DPH nebo bankovní účet?

> Ne, to teď nechci. Stačí DIČ z ARESu. Spolehlivost plátce a účty jsou mimo rozsah.

## Confirmation step

When the agent shows the one-sentence goal and the examples table, check that it contains: a valid found company (Alza `27082440`), an IČO with a bad checksum (`12345678`), a well-formed IČO with a valid checksum that ARES does not know (`99999994`, verified 404), and a company without DIČ (Komerční banka `45317054`). Then answer:

> Ano, takhle to sedí.

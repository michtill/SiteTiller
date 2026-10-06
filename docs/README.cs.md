# AIWE — český návod

[English README](../README.md) · [Podrobná instalace](deployment.md) · [Architektura](architecture.md)

AIWE je aplikace pro tvorbu a úpravy statických webů pomocí přirozeného jazyka. Umožňuje vytvořit web od nuly, změnit jeho design, upravit obrázky a přidat funkce v HTML, CSS a JavaScriptu. Každá úprava je nejprve návrh. Publikování provedete samostatně.

## Instalace

Potřebujete Docker s Compose. Pro malou instalaci počítejte alespoň s 1 GB RAM a rezervou pro sestavení image a Chromium.

```sh
git clone https://github.com/michtill/AIWE.git
cd AIWE
cp .env.example .env
docker compose up -d --build web preview
```

Výchozí editor je na `http://127.0.0.1:8080`, náhled na `http://127.0.0.1:8081`. Porty jsou dostupné pouze lokálně. Pro server nastavte vlastní adresy `AIWE_ORIGIN` a `AIWE_PREVIEW_URL`, HTTPS a samostatné domény pro editor, náhled a produkční web. Podrobnosti jsou v instalačním návodu.

Instalační token načtete soukromě:

```sh
docker compose exec web cat /data/bootstrap-token
```

Na přihlašovací stránce zadejte token a vytvořte administrátorské heslo o délce 12–256 znaků. V Nastavení doplňte API klíče a zvolte dostupné modely. Účet OpenAI je potřeba pro výchozího Leada a obrázky; Anthropic pro výchozího specialistu. Modelová volání účtují jejich poskytovatelé.

## Jazyk a vzhled

V Nastavení vyberte češtinu nebo angličtinu. Volba se ukládá pro daný prohlížeč. Výchozí jazyk instalace nastavuje `AIWE_UI_LANGUAGE=cs` nebo `en`. Agent odpovídá v jazyce vašeho zadání; jazyk rozhraní to neovlivňuje. Komunikace uvnitř týmu zůstává stručná a strukturovaná.

Přepínač slunce/měsíce mění vzhled editoru. Vzhled vytvořeného webu nemění. Před změnou jazyka dokončete nahrávání obrázků; rozepsaný text a nahrané přílohy zůstanou zachované.

## Práce s návrhem

1. Napište požadavek. Obrázky přiložte tlačítkem `+` nebo vložením ze schránky.
2. Agent provede změnu, automatické kontroly a podle potřeby nezávislé ověření.
3. Zadání nebo oko vlevo přepíná náhled kroku. Kliknutí na odpověď rozbalí průběh.
4. Záložka **Aktuální návrh** vrací poslední krok. Předchozí krok lze načíst pro další úpravy.
5. V historii otevřete publikovanou verzi kliknutím na položku nebo oko. Náhled historii ani web nemění.

Krátké navazující zadání jako „Ještě trochu“ využívá paměť předchozích změn. Neúspěšné úpravy nejsou považované za aplikované.

## Publikování a podverze

Publikování je možné až po připojení publikační služby. Každé publikování ověřuje konkrétní Git snapshot. Výchozí volba vytvoří novou hlavní verzi. **Vytvořit podverzi k aktuální verzi** vytvoří například 12.1 a další 12.2. Předchozí publikace se nepřepisují.

Historie ukazuje nejnovější publikaci každé hlavní verze. Starší podverze rozbalíte přes **Podverze**; původní publikace je 12.0. Datum a čas se zobrazují v časové zóně Europe/Prague.

Při publikování předchozího kroku zůstanou novější rozpracované úpravy zachované. Publikování posledního návrhu uzavře jeho rozpracovanou historii. U aktuální publikované verze lze volbou **Nebudeme nic měnit** otevřít potvrzení odstranění všech rozpracovaných kroků. Publikovaný web se tím nezmění.

## Další weby a provoz

Každý web má samostatnou instalaci s vlastními doménami, porty, datovými svazky a přístupem. Nejde o sdílený systém více zákazníků. Podrobný návod popisuje volitelné produkční služby i připojení existujícího Git hostingu.

Zálohujte `aiwe_data` a při publikování také `aiwe_production`. Záloha obsahuje přístupové údaje, obrázky a historii: uchovávejte ji soukromě. Při aktualizaci datové svazky nemažte. Zdrojový repozitář neobsahuje vaše weby ani API klíče.

## Současné hranice

Výstup je statický web: HTML, CSS, JavaScript, SVG a obrázky. AIWE nevytváří vlastní backendové procesy ani nesestavuje projekty Next.js, Vue či React. Newsletter může využít existující HTTPS službu; vlastní serverové API musí být připojeno zvlášť. Automatický test blokuje externí služby a nemůže potvrdit skutečné odeslání formuláře, platbu či přihlášení k odběru.

Náhledová adresa má `noindex`, ale není soukromá jen tím, že není ve vyhledávači. Pro důvěrné návrhy použijte další přístupovou ochranu na hostingu. Skripty webu provozujte na oddělené doméně od editoru.

Licence: MIT.


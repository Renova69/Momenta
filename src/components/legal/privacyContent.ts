import type { LegalDoc } from './legalTypes';

/**
 * The privacy notice (N-163), written from what the code does: what it
 * collects, where it keeps it, who sees it, and for how long. `{{token}}`
 * marks a detail only the operator can give (src/config/operator.ts); an
 * empty one is shown as a visible placeholder. Needs a lawyer's reading
 * before the service takes real guests.
 */
export const PRIVACY: Record<'bg' | 'en', LegalDoc> = {
  bg: {
    title: `Политика за поверителност`,
    summary: `Тази политика обяснява какви лични данни обработваме, когато използвате WedMoments — като младоженци, организатори, фотографи или гости, — защо го правим, колко дълго пазим данните и какви права имате.`,
    sections: [
      {
        heading: `Кой обработва данните`,
        paragraphs: [
          `Администратор на личните данни е {{legalName}}, ЕИК {{companyId}}, със седалище и адрес на управление {{address}} („ние“).`,
          `За въпроси относно личните ви данни и за упражняване на правата си пишете ни на {{email}} или се обадете на {{phone}}.`,
        ],
      },
      {
        heading: `Какви данни събираме`,
        items: [
          `Младоженци и организатори: име, имейл адрес, парола (пазим я само като криптографски хеш, никога в четим вид), име на фирма за организаторите и данните на албума — имената на младоженците, датата и мястото на събитието, поздравителното съобщение и корицата.`,
          `Плащания: избраният план, платената сума и идентификаторите на клиента и абонамента, които ни връща Stripe. Данните на картата си въвеждате направо при Stripe; ние не ги получаваме и не ги пазим.`,
          `Гости: името, което въведете, и по желание номер на маса или роля и селфи; снимките, гласовите пожелания, надписите, коментарите и реакциите, които добавите, и изпълнените от вас фото предизвикателства.`,
          `Снимките пазим и в оригиналния им файл, с вградените в него метаданни — например часа на снимане и, ако телефонът ги записва, координатите на мястото. Оригиналите са достъпни само за младоженците; на гостите и на екрана на живо се показват копия, от които тези данни са премахнати.`,
          `Фотографи: снимките, качени през личния линк за фотограф, и името на фотографа, ако е посочено.`,
          `Технически данни: случаен идентификатор, който приложението създава и пази в браузъра ви, за да свързва качванията ви и да прилага лимита на снимките на гост; IP адресът ви, който сървърът държи кратко в паметта си само за защита от прекалено чести заявки; и обичайните технически записи на хостинг доставчика ни.`,
          `Избраният език на приложението.`,
        ],
      },
      {
        heading: `Защо обработваме данните и на какво основание`,
        items: [
          `За да предоставяме услугата — профила, албума, качването и показването на снимки и гласови пожелания, екрана на живо и плановете (изпълнение на договор, чл. 6, ал. 1, буква „б“ от Общия регламент относно защитата на данните).`,
          `За да покажем снимките и пожеланията на гостите в албума, в който младоженците са ги поканили (законен интерес на младоженците и наш, чл. 6, ал. 1, буква „е“). Гостите сами решават дали и какво да качат; селфито и номерът на маса не са задължителни.`,
          `За плащанията и счетоводството (изпълнение на договор и законово задължение, чл. 6, ал. 1, букви „б“ и „в“).`,
          `За сигурност и защита от злоупотреби (законен интерес, чл. 6, ал. 1, буква „е“).`,
          `За служебни съобщения по имейл — например че срокът на албума изтича (изпълнение на договор).`,
        ],
        paragraphs: [`Не използваме данните ви за реклама, не ги продаваме и не правим профилиране.`],
      },
      {
        heading: `Кой вижда данните`,
        items: [
          `Гостите в албума виждат одобрените снимки, имената и селфитата на хората, които са ги качили, надписите, коментарите и реакциите. Ако младоженците са включили предварително одобрение, гостите виждат снимката едва след като младоженците я одобрят.`,
          `Младоженците виждат всичко в албума си, включително снимките, които чакат одобрение, и оригиналните файлове, и могат да свалят архив.`,
          `Екранът на живо показва снимките и реакциите на мястото на събитието, на екран, който младоженците пускат.`,
          `Публичната витрина на началната страница показва името на албума, мястото и няколко снимки само ако младоженците изрично я включат. По подразбиране е изключена.`,
          `Страниците на албумите не се показват в търсачките.`,
        ],
      },
      {
        heading: `Доставчици, които обработват данни от наше име`,
        items: [
          `Stripe Payments Europe, Ltd. (Ирландия) — обработка на плащанията.`,
          `Cloudflare, Inc. — съхранение и доставяне на снимките и гласовите пожелания (Cloudflare R2).`,
          `{{hostingProvider}} — хостинг на приложението и базата данни.`,
          `{{emailProvider}} — изпращане на имейли.`,
        ],
        paragraphs: [
          `Те обработват данните само по наше указание и само за целите по-горе. Предаване на данни извън Европейското икономическо пространство: {{transferSafeguards}}`,
        ],
      },
      {
        heading: `Колко дълго пазим данните`,
        items: [
          `Албумът е активен за срока на избрания план, броен от датата на събитието (или от създаването на албума, ако е по-късна). След този срок албумът се затваря: снимките могат да се разглеждат и свалят, но не се приемат нови снимки, гласови пожелания, коментари и реакции. План с по-дълъг срок отваря албума отново.`,
          `След затварянето албумът и всичко в него — снимки, гласови пожелания, коментари и данните на гостите — се пазят {{retentionAfterClose}} и след това се изтриват. Преди изтриването младоженците получават предупреждение по имейл.`,
          `Профилът се пази, докато не го изтриете. Изтриването е незабавно и премахва всичките ви албуми и съдържанието им; активен абонамент се прекратява.`,
          `Данните за плащанията пазим толкова, колкото изисква счетоводното законодателство.`,
          `Данните в браузъра ви остават там, докато не ги изчистите или не излезете от профила си.`,
        ],
      },
      {
        heading: `Данни в браузъра ви (без бисквитки)`,
        paragraphs: [
          `Не използваме бисквитки, инструменти за анализ на посещенията или рекламни тракери. Приложението пази в локалното хранилище на браузъра ви само необходимото, за да работи: входа ви като младоженци, профила ви на гост в даден албум, случайния идентификатор на устройството, избрания език, копие от данните на албума за по-бързо зареждане и снимките, които чакат връзка, за да бъдат изпратени. Това е строго необходимо за услугата, която сте поискали, затова не изисква отделно съгласие.`,
        ],
      },
      {
        heading: `Вашите права`,
        items: [
          `Да поискате достъп до данните си и копие от тях.`,
          `Да поискате поправка на неточни данни.`,
          `Да поискате изтриване. Младоженците могат сами да изтрият профила си от „Моят профил“, а отделни снимки — от студиото. Гост, който иска да бъде премахната негова снимка или данни, може да се обърне към младоженците или към нас на {{email}}.`,
          `Да поискате ограничаване на обработването или да възразите срещу обработване, основано на законен интерес.`,
          `Да получите данните си в машинно четим формат. Младоженците могат да свалят архив на албума си.`,
        ],
        paragraphs: [
          `Отговаряме в срок до един месец. Имате право да подадете жалба до Комисията за защита на личните данни — гр. София 1592, бул. „Проф. Цветан Лазаров“ № 2, www.cpdp.bg.`,
        ],
      },
      {
        heading: `Сигурност`,
        paragraphs: [
          `Връзката с услугата е криптирана, паролите се пазят само като хеш, сървърът проверява всеки достъп до албум, а снимките, които чакат одобрение, се пазят отделно и не са публично достъпни.`,
        ],
      },
      {
        heading: `Деца`,
        paragraphs: [
          `Профил на младоженци или организатор може да създаде само пълнолетно лице. На сватби често има деца: гостите и младоженците отговарят снимки на деца да се споделят само с разрешението на родителите им.`,
        ],
      },
      {
        heading: `Промени в тази политика`,
        paragraphs: [
          `Ако променим политиката, ще публикуваме новата версия тук с новата дата. За съществени промени ще уведомим младоженците предварително.`,
        ],
      },
    ],
  },
  en: {
    title: `Privacy Policy`,
    summary: `This policy explains what personal data we process when you use WedMoments — as a couple, a planner, a photographer or a guest — why we do it, how long we keep the data and what your rights are.`,
    sections: [
      {
        heading: `Who processes your data`,
        paragraphs: [
          `The controller of your personal data is {{legalName}}, company number {{companyId}}, registered at {{address}} ("we").`,
          `For questions about your personal data and to exercise your rights, write to us at {{email}} or call {{phone}}.`,
        ],
      },
      {
        heading: `What data we collect`,
        items: [
          `Couples and planners: name, email address, password (kept only as a cryptographic hash, never readable), company name for planners, and the album's details — the couple's names, the date and venue, the welcome message and the cover photo.`,
          `Payments: the plan chosen, the amount paid and the customer and subscription identifiers Stripe returns to us. You enter your card details directly with Stripe; we never receive or store them.`,
          `Guests: the name you enter and, optionally, a table number or role and a selfie; the photos, voice messages, captions, comments and reactions you add, and the photo challenges you complete.`,
          `Photos are also kept in their original file, with the metadata embedded in it — such as the time taken and, if the phone records it, the location. Originals are available to the couple only; guests and the live screen are shown copies with that metadata removed.`,
          `Photographers: photos uploaded through the photographer's private link, and the photographer's name if given.`,
          `Technical data: a random identifier the app creates and keeps in your browser to link your uploads and apply the per-guest photo limit; your IP address, which the server holds briefly in memory only to guard against excessive requests; and our hosting provider's usual technical logs.`,
          `The language you chose for the app.`,
        ],
      },
      {
        heading: `Why we process it, and on what basis`,
        items: [
          `To provide the service — the account, the album, uploading and showing photos and voice messages, the live screen and the plans (performance of a contract, Article 6(1)(b) of the General Data Protection Regulation).`,
          `To show guests' photos and messages in the album the couple invited them to (the couple's and our legitimate interest, Article 6(1)(f)). Guests decide for themselves whether and what to upload; the selfie and table number are optional.`,
          `For payments and accounting (performance of a contract and legal obligation, Article 6(1)(b) and (c)).`,
          `For security and to prevent abuse (legitimate interest, Article 6(1)(f)).`,
          `For service emails — for example that an album's period is ending (performance of a contract).`,
        ],
        paragraphs: [`We do not use your data for advertising, do not sell it and do not profile you.`],
      },
      {
        heading: `Who sees the data`,
        items: [
          `Guests in an album see the approved photos, the names and selfies of the people who took them, captions, comments and reactions. If the couple has turned on approval, guests see a photo only after the couple approves it.`,
          `The couple sees everything in their album, including photos waiting for approval and the original files, and can download an archive.`,
          `The live screen shows photos and reactions at the venue, on a screen the couple sets up.`,
          `The public showcase on the home page shows an album's name, venue and a few photos only if the couple expressly turns it on. It is off by default.`,
          `Album pages are kept out of search engines.`,
        ],
      },
      {
        heading: `Providers that process data on our behalf`,
        items: [
          `Stripe Payments Europe, Ltd. (Ireland) — payment processing.`,
          `Cloudflare, Inc. — storing and delivering photos and voice messages (Cloudflare R2).`,
          `{{hostingProvider}} — hosting the app and its database.`,
          `{{emailProvider}} — sending email.`,
        ],
        paragraphs: [
          `They process the data only on our instructions and only for the purposes above. Transfers outside the European Economic Area: {{transferSafeguards}}`,
        ],
      },
      {
        heading: `How long we keep the data`,
        items: [
          `An album is active for the period of its plan, counted from the date of the event (or from the album's creation, if later). After that the album closes: its photos can still be viewed and downloaded, but it takes no new photos, voice messages, comments or reactions. A plan with a longer period opens it again.`,
          `After it closes, the album and everything in it — photos, voice messages, comments and guests' details — is kept for {{retentionAfterClose}} and then deleted. The couple is warned by email before deletion.`,
          `An account is kept until you delete it. Deletion is immediate and removes all your albums and their contents; an active subscription is cancelled.`,
          `Payment records are kept for as long as accounting law requires.`,
          `Data in your browser stays there until you clear it or sign out.`,
        ],
      },
      {
        heading: `Data in your browser (no cookies)`,
        paragraphs: [
          `We use no cookies, no analytics and no advertising trackers. The app keeps in your browser's local storage only what it needs to work: your couple's sign-in, your guest profile in an album, the random device identifier, your language, a copy of the album's details for faster loading, and photos waiting for a connection to be sent. This is strictly necessary for the service you asked for, so it needs no separate consent.`,
        ],
      },
      {
        heading: `Your rights`,
        items: [
          `To ask for access to your data and a copy of it.`,
          `To ask for inaccurate data to be corrected.`,
          `To ask for erasure. Couples can delete their own account from "My Profile" and individual photos from the studio. A guest who wants a photo or their details removed can ask the couple, or us at {{email}}.`,
          `To ask for processing to be restricted, or to object to processing based on legitimate interest.`,
          `To receive your data in a machine-readable format. Couples can download an archive of their album.`,
        ],
        paragraphs: [
          `We reply within one month. You may lodge a complaint with the Bulgarian Commission for Personal Data Protection — 2 Prof. Tsvetan Lazarov Blvd., Sofia 1592, www.cpdp.bg.`,
        ],
      },
      {
        heading: `Security`,
        paragraphs: [
          `The connection to the service is encrypted, passwords are kept only as hashes, the server checks every access to an album, and photos waiting for approval are stored separately and are not publicly reachable.`,
        ],
      },
      {
        heading: `Children`,
        paragraphs: [
          `Only adults may create a couple's or planner's account. Weddings often have children: guests and couples are responsible for sharing photos of children only with their parents' permission.`,
        ],
      },
      {
        heading: `Changes to this policy`,
        paragraphs: [
          `If we change this policy we will publish the new version here with its new date. We will tell couples in advance about significant changes.`,
        ],
      },
    ],
  },
};

import type { LegalDoc } from './legalTypes';

/**
 * The terms of use and sale (N-163), stating the rules the app actually
 * enforces: plans and their periods, the album closing (N-159), the grace
 * after a failed renewal, the pass kept under a subscription (N-164). The
 * consumer's 14-day right of withdrawal is stated as the law gives it by
 * default. `{{token}}` marks a detail only the operator can give
 * (src/config/operator.ts). Needs a lawyer's reading before the service takes
 * real payments.
 */
export const TERMS: Record<'bg' | 'en', LegalDoc> = {
  bg: {
    title: `Общи условия`,
    summary: `Тези общи условия уреждат използването на WedMoments и покупката на платени планове. Като създадете профил или платите план, вие ги приемате.`,
    sections: [
      {
        heading: `Кои сме ние`,
        items: [
          `Търговец: {{legalName}}`,
          `ЕИК: {{companyId}}; ДДС номер: {{vatId}}`,
          `Седалище и адрес на управление: {{address}}`,
          `Имейл: {{email}}; телефон: {{phone}}`,
          `Надзорни органи: Комисия за защита на потребителите (www.kzp.bg) и Комисия за защита на личните данни (www.cpdp.bg).`,
        ],
      },
      {
        heading: `Услугата`,
        paragraphs: [
          `WedMoments е онлайн албум за сватби и събития. Младоженците или организаторът създават албум, а гостите влизат в него чрез QR код или линк и качват снимки и гласови пожелания, които всички в албума виждат на живо. Функциите на всеки план са описани на страницата „Пакети и цени“.`,
        ],
      },
      {
        heading: `Профил`,
        items: [
          `Профил може да създаде само пълнолетно лице. Данните, които въвеждате, трябва да са верни.`,
          `Пазете паролата си в тайна. Отговаряте за действията от профила си; ако подозирате чужд достъп, сменете паролата от „Моят профил“ — това излиза от профила на всички други устройства.`,
          `Гостите не създават профил: въвеждат име и по желание селфи, за да участват в албума.`,
        ],
      },
      {
        heading: `Планове, цени и плащане`,
        items: [
          `Безплатният план не изисква плащане. Платените планове и цените им са посочени на страницата „Пакети и цени“. Цените са в евро и {{pricesIncludeVat}}.`,
          `Еднократните планове се плащат веднъж и важат за срока, посочен в описанието им. Месечният план за организатори е абонамент, който се подновява автоматично всеки месец, докато не го прекратите.`,
          `Плащането се извършва чрез Stripe. Планът се активира, щом Stripe потвърди плащането.`,
          `Не можете да купите план, който вече се съдържа в настоящия ви план.`,
        ],
      },
      {
        heading: `Абонамент: подновяване, прекратяване и неуспешно плащане`,
        items: [
          `Абонамента можете да прекратите по всяко време от страницата за плащане на Stripe, достъпна от „Пакети и цени“. Прекратяването важи от края на вече платения период; дотогава планът остава активен.`,
          `Ако плащането за подновяване не мине, планът остава активен още 7 дни, докато Stripe опитва отново и докато обновите картата си. След това планът се спира и албумите ви минават на по-нисък план — на еднократния план, който сте платили, ако имате такъв, иначе на безплатния. Ако плащането бъде извършено по-късно, планът се възстановява.`,
          `Ако освен абонамента имате и еднократен план, след края на абонамента запазвате еднократния план.`,
        ],
      },
      {
        heading: `Право на отказ`,
        paragraphs: [
          `Като потребител имате право да се откажете от договора за платен план в срок от 14 дни от сключването му, без да посочвате причина, като ни уведомите на {{email}}. Ако сте поискали услугата да започне преди изтичането на този срок — например като сте използвали платените функции, — дължите сума, пропорционална на предоставеното до момента на отказа. Възстановяваме дължимата сума в срок до 14 дни от уведомлението ви, по същия начин, по който сте платили.`,
        ],
      },
      {
        heading: `Срок на албума`,
        items: [
          `Албумът е активен за срока на плана си, броен от датата на събитието (или от създаването на албума, ако е по-късна). Ако промените датата на събитието, срокът се преизчислява.`,
          `След този срок албумът се затваря: снимките могат да се разглеждат и свалят, но не се приемат нови снимки, гласови пожелания, коментари и реакции. План с по-дълъг срок отваря албума отново.`,
          `Какво става с данните след затварянето, е описано в Политиката за поверителност. Препоръчваме да свалите снимките си навреме.`,
        ],
      },
      {
        heading: `Съдържание и поведение`,
        paragraphs: [
          `Всеки отговаря за съдържанието, което качва. Качвайте само снимки и записи, които имате право да споделите, и уважавайте хората на тях: ако някой поиска снимка с него да бъде премахната, младоженците могат да я изтрият.`,
        ],
        items: [
          `Забранено е съдържание, което е незаконно; което нарушава чужди права, включително авторски права и правото на собствен образ; което е обидно, дискриминационно или със сексуален характер.`,
          `Забранени са опитите за достъп до чужди албуми, претоварване на услугата или заобикаляне на ограниченията ѝ.`,
          `Младоженците управляват албума си: могат да включат предварително одобрение на снимките, да изтриват снимки и да прекратят сесиите на гостите. Ние можем да премахнем съдържание или да спрем достъп при нарушение на тези условия или по искане на компетентен орган.`,
        ],
      },
      {
        heading: `Права върху съдържанието`,
        paragraphs: [
          `Авторските права върху снимките и записите остават за хората, които са ги създали. С качването ни давате неизключителното и безвъзмездно право да ги съхраняваме, да правим умалени копия и да ги показваме на хората с достъп до албума — само доколкото това е нужно за услугата. Снимки се показват на началната страница само ако младоженците включат публичната витрина.`,
        ],
      },
      {
        heading: `Наличност и отговорност`,
        items: [
          `Стремим се услугата да работи непрекъснато, но не можем да гарантираме, че няма да има прекъсвания — например при поддръжка или при проблем у доставчик.`,
          `Не отговаряме за съдържание, качено от потребители, нито за вреди от прекъсвания, освен при умисъл или груба небрежност. Това не ограничава правата ви на потребител по закон.`,
        ],
      },
      {
        heading: `Прекратяване`,
        items: [
          `Можете да изтриете профила си по всяко време от „Моят профил“. Изтриването е незабавно, премахва албумите ви и прекратява активния абонамент.`,
          `Можем да прекратим достъпа до профил при сериозно или повторно нарушение на тези условия, като ви уведомим.`,
          `При прекратяване не се възстановява сума за неизползван период, освен в случаите на право на отказ и когато законът го изисква.`,
        ],
      },
      {
        heading: `Промени в условията`,
        paragraphs: [
          `Ако променим тези условия, ще уведомим младоженците поне 14 дни предварително. Ако не сте съгласни с промяната, можете да изтриете профила си, преди тя да влезе в сила.`,
        ],
      },
      {
        heading: `Приложимо право и спорове`,
        paragraphs: [
          `За тези условия се прилага българското право. Ще се опитаме да разрешим всеки спор по взаимно съгласие; можете да се обърнете и към Комисията за защита на потребителите. Неуредените спорове се решават от компетентния български съд.`,
        ],
      },
    ],
  },
  en: {
    title: `Terms of Use`,
    summary: `These terms govern the use of WedMoments and the purchase of paid plans. By creating an account or paying for a plan you accept them.`,
    sections: [
      {
        heading: `Who we are`,
        items: [
          `Trader: {{legalName}}`,
          `Company number: {{companyId}}; VAT number: {{vatId}}`,
          `Registered address: {{address}}`,
          `Email: {{email}}; phone: {{phone}}`,
          `Supervisory authorities: the Bulgarian Commission for Consumer Protection (www.kzp.bg) and Commission for Personal Data Protection (www.cpdp.bg).`,
        ],
      },
      {
        heading: `The service`,
        paragraphs: [
          `WedMoments is an online album for weddings and events. The couple or a planner creates an album; guests join it through a QR code or a link and upload photos and voice messages that everyone in the album sees live. What each plan includes is described on the "Plans & Pricing" page.`,
        ],
      },
      {
        heading: `Your account`,
        items: [
          `Only adults may create an account. The details you enter must be true.`,
          `Keep your password secret. You are responsible for what is done from your account; if you suspect someone else has access, change your password from "My Profile", which signs out every other device.`,
          `Guests do not create an account: they enter a name and, optionally, a selfie to take part in an album.`,
        ],
      },
      {
        heading: `Plans, prices and payment`,
        items: [
          `The free plan needs no payment. Paid plans and their prices are listed on the "Plans & Pricing" page. Prices are in euro and {{pricesIncludeVat}}.`,
          `One-time plans are paid once and last for the period stated in their description. The monthly plan for planners is a subscription that renews automatically every month until you cancel it.`,
          `Payment is processed by Stripe. A plan is activated as soon as Stripe confirms the payment.`,
          `You cannot buy a plan your current plan already includes.`,
        ],
      },
      {
        heading: `Subscriptions: renewal, cancellation and failed payments`,
        items: [
          `You can cancel a subscription at any time from Stripe's billing page, reached from "Plans & Pricing". Cancellation takes effect at the end of the period already paid for; until then the plan stays active.`,
          `If a renewal payment fails, the plan stays active for 7 more days while Stripe retries and while you update your card. After that the plan is suspended and your albums move to a lower plan — to the one-time plan you paid for, if you have one, otherwise to the free plan. If the payment is made later, the plan is restored.`,
          `If you hold a one-time plan as well as the subscription, you keep the one-time plan when the subscription ends.`,
        ],
      },
      {
        heading: `Right of withdrawal`,
        paragraphs: [
          `As a consumer you may withdraw from a contract for a paid plan within 14 days of making it, without giving a reason, by telling us at {{email}}. If you asked for the service to start before that period ends — for example by using the paid features — you owe an amount in proportion to what was provided up to your withdrawal. We refund what is due within 14 days of your notice, by the same means you paid.`,
        ],
      },
      {
        heading: `The album's period`,
        items: [
          `An album is active for its plan's period, counted from the date of the event (or from the album's creation, if later). If you change the event date, the period is recalculated.`,
          `After that period the album closes: its photos can still be viewed and downloaded, but it takes no new photos, voice messages, comments or reactions. A plan with a longer period opens it again.`,
          `What happens to the data after the album closes is described in the Privacy Policy. We recommend downloading your photos in good time.`,
        ],
      },
      {
        heading: `Content and conduct`,
        paragraphs: [
          `Everyone is responsible for what they upload. Upload only photos and recordings you have the right to share, and respect the people in them: if someone asks for a photo of them to be removed, the couple can delete it.`,
        ],
        items: [
          `Content that is illegal; that infringes others' rights, including copyright and the right to one's own image; or that is offensive, discriminatory or sexual is not allowed.`,
          `Attempts to access other people's albums, to overload the service or to get around its limits are not allowed.`,
          `The couple manages their album: they can require approval of photos, delete photos and end guests' sessions. We may remove content or suspend access for a breach of these terms or at the request of a competent authority.`,
        ],
      },
      {
        heading: `Rights in the content`,
        paragraphs: [
          `Copyright in photos and recordings stays with the people who made them. By uploading, you give us the non-exclusive, royalty-free right to store them, make reduced copies and show them to the people with access to the album — only as far as the service needs. Photos appear on the home page only if the couple turns on the public showcase.`,
        ],
      },
      {
        heading: `Availability and liability`,
        items: [
          `We aim to keep the service running without interruption but cannot guarantee it — for example during maintenance or a provider's outage.`,
          `We are not liable for content uploaded by users, or for loss caused by interruptions, except in cases of intent or gross negligence. This does not limit your statutory rights as a consumer.`,
        ],
      },
      {
        heading: `Ending the agreement`,
        items: [
          `You can delete your account at any time from "My Profile". Deletion is immediate, removes your albums and cancels an active subscription.`,
          `We may end access to an account for a serious or repeated breach of these terms, after telling you.`,
          `No refund is given for an unused period on ending the agreement, except under the right of withdrawal and where the law requires it.`,
        ],
      },
      {
        heading: `Changes to these terms`,
        paragraphs: [
          `If we change these terms we will tell couples at least 14 days in advance. If you do not agree with a change, you can delete your account before it takes effect.`,
        ],
      },
      {
        heading: `Governing law and disputes`,
        paragraphs: [
          `These terms are governed by Bulgarian law. We will try to settle any dispute by agreement; you may also turn to the Commission for Consumer Protection. Disputes not settled are decided by the competent Bulgarian court.`,
        ],
      },
    ],
  },
};

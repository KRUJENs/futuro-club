/**
 * VITAS · Correos al TUTOR del consentimiento parental (P1 bloque 3), en los 7 idiomas.
 *
 *   1. requestEmail      — lo manda api/auth/sign-consent.ts cuando el responsable del jugador
 *                          pide la firma: enlace a /auth/verify-consent?token=… (24 h). El
 *                          tutor revisa, escribe SU DNI, acepta y pulsa «Confirmo».
 *   2. confirmationEmail — lo manda api/auth/verify-consent.ts al confirmar: enlace de RETIRADA
 *                          (/auth/withdraw-consent?token=…), sin caducidad (RGPD art. 7.3).
 *
 * Los nombres los escribe una persona (responsable / tutor) ⇒ se escapan antes de ir al HTML.
 * Idioma: el de la interfaz de quien pide la firma (normalizeLocale; por defecto «es»).
 * Sin `node:*` → vale para Edge y Node.
 */
import { normalizeLocale, type ReportLocale } from "../../src/lib/shared/locale";

/** Escapa lo que va dentro del HTML del correo (nombres escritos por personas). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface RequestCopy {
  subject: string;
  title: string;
  hello: (parent: string) => string;
  intro: (child: string) => string;
  what: string;
  button: string;
  expiry: string;
  notYou: string;
  legal: string;
}

interface ConfirmationCopy {
  subject: string;
  title: string;
  hello: (parent: string) => string;
  body: (child: string) => string;
  withdrawIntro: string;
  button: string;
  keep: string;
  legal: string;
}

const REQUEST: Record<ReportLocale, RequestCopy> = {
  es: {
    subject: "VITAS · Confirma el consentimiento como tutor legal",
    title: "Consentimiento del tutor legal",
    hello: (p) => `Hola ${p}:`,
    intro: (c) => `El responsable de <strong>${c}</strong> en VITAS Football Intelligence te pide tu consentimiento como padre, madre o tutor legal.`,
    what: "Con tu consentimiento se podrán analizar los vídeos de entrenamientos y partidos en los que aparece el menor. En la página del enlace verás qué autorizas, escribirás tu DNI y confirmarás tú mismo.",
    button: "Revisar y confirmar",
    expiry: "El enlace caduca en 24 horas.",
    notYou: "Si no eres el tutor legal o no esperabas este correo, ignóralo: sin tu confirmación no se analiza nada.",
    legal: "Consentimiento exigido por el RGPD (art. 8) y la LOPDGDD (art. 7) para tratar datos de menores de 14 años. Cuando confirmes te enviaremos un enlace para retirarlo cuando quieras.",
  },
  "es-419": {
    subject: "VITAS · Confirma el consentimiento como tutor legal",
    title: "Consentimiento del tutor legal",
    hello: (p) => `Hola ${p}:`,
    intro: (c) => `El responsable de <strong>${c}</strong> en VITAS Football Intelligence te pide tu consentimiento como padre, madre o tutor legal.`,
    what: "Con tu consentimiento se podrán analizar los videos de entrenamientos y partidos en los que aparece el menor. En la página del enlace verás qué autorizas, escribirás tu documento de identidad y confirmarás tú mismo.",
    button: "Revisar y confirmar",
    expiry: "El enlace vence en 24 horas.",
    notYou: "Si no eres el tutor legal o no esperabas este correo, ignóralo: sin tu confirmación no se analiza nada.",
    legal: "Consentimiento exigido por el RGPD (art. 8) y la LOPDGDD (art. 7) para tratar datos de menores de 14 años. Cuando confirmes te enviaremos un enlace para retirarlo cuando quieras.",
  },
  en: {
    subject: "VITAS · Confirm your consent as legal guardian",
    title: "Legal guardian consent",
    hello: (p) => `Hello ${p},`,
    intro: (c) => `The person responsible for <strong>${c}</strong> in VITAS Football Intelligence is asking for your consent as parent or legal guardian.`,
    what: "With your consent, videos of training sessions and matches in which the minor appears can be analysed. On the linked page you will see what you are authorising, enter your ID number and confirm it yourself.",
    button: "Review and confirm",
    expiry: "The link expires in 24 hours.",
    notYou: "If you are not the legal guardian or were not expecting this email, ignore it: nothing is analysed without your confirmation.",
    legal: "Consent required by the GDPR (Art. 8) and Spanish law (LOPDGDD Art. 7) to process data of children under 14. Once you confirm we will send you a link to withdraw it at any time.",
  },
  de: {
    subject: "VITAS · Bestätige deine Einwilligung als Erziehungsberechtigte/r",
    title: "Einwilligung der/des Erziehungsberechtigten",
    hello: (p) => `Hallo ${p},`,
    intro: (c) => `Die verantwortliche Person für <strong>${c}</strong> bei VITAS Football Intelligence bittet dich um deine Einwilligung als Elternteil oder Erziehungsberechtigte/r.`,
    what: "Mit deiner Einwilligung können Videos von Trainings und Spielen, in denen das Kind zu sehen ist, analysiert werden. Auf der verlinkten Seite siehst du, was du erlaubst, gibst deine Ausweisnummer ein und bestätigst selbst.",
    button: "Prüfen und bestätigen",
    expiry: "Der Link läuft in 24 Stunden ab.",
    notYou: "Wenn du nicht erziehungsberechtigt bist oder diese E-Mail nicht erwartet hast, ignoriere sie: Ohne deine Bestätigung wird nichts analysiert.",
    legal: "Einwilligung gemäß DSGVO (Art. 8) und spanischem Recht (LOPDGDD Art. 7) für die Verarbeitung von Daten von Kindern unter 14 Jahren. Nach deiner Bestätigung senden wir dir einen Link, mit dem du sie jederzeit widerrufen kannst.",
  },
  fr: {
    subject: "VITAS · Confirmez votre consentement en tant que tuteur légal",
    title: "Consentement du tuteur légal",
    hello: (p) => `Bonjour ${p},`,
    intro: (c) => `Le responsable de <strong>${c}</strong> sur VITAS Football Intelligence vous demande votre consentement en tant que parent ou tuteur légal.`,
    what: "Avec votre consentement, les vidéos d'entraînements et de matchs où apparaît le mineur pourront être analysées. Sur la page du lien, vous verrez ce que vous autorisez, saisirez votre numéro de pièce d'identité et confirmerez vous-même.",
    button: "Vérifier et confirmer",
    expiry: "Le lien expire dans 24 heures.",
    notYou: "Si vous n'êtes pas le tuteur légal ou n'attendiez pas cet e-mail, ignorez-le : rien n'est analysé sans votre confirmation.",
    legal: "Consentement exigé par le RGPD (art. 8) et le droit espagnol (LOPDGDD art. 7) pour traiter les données de mineurs de moins de 14 ans. Après votre confirmation, nous vous enverrons un lien pour le retirer à tout moment.",
  },
  it: {
    subject: "VITAS · Conferma il consenso come tutore legale",
    title: "Consenso del tutore legale",
    hello: (p) => `Ciao ${p},`,
    intro: (c) => `Il responsabile di <strong>${c}</strong> su VITAS Football Intelligence ti chiede il consenso come genitore o tutore legale.`,
    what: "Con il tuo consenso si potranno analizzare i video di allenamenti e partite in cui compare il minore. Nella pagina del link vedrai cosa autorizzi, inserirai il numero del tuo documento d'identità e confermerai tu stesso.",
    button: "Rivedi e conferma",
    expiry: "Il link scade tra 24 ore.",
    notYou: "Se non sei il tutore legale o non ti aspettavi questa email, ignorala: senza la tua conferma non si analizza nulla.",
    legal: "Consenso richiesto dal GDPR (art. 8) e dalla legge spagnola (LOPDGDD art. 7) per trattare dati di minori di 14 anni. Quando confermi ti invieremo un link per revocarlo in qualsiasi momento.",
  },
  nl: {
    subject: "VITAS · Bevestig je toestemming als wettelijke voogd",
    title: "Toestemming van de wettelijke voogd",
    hello: (p) => `Hallo ${p},`,
    intro: (c) => `De verantwoordelijke voor <strong>${c}</strong> in VITAS Football Intelligence vraagt je toestemming als ouder of wettelijke voogd.`,
    what: "Met je toestemming kunnen video's van trainingen en wedstrijden waarin de minderjarige te zien is, worden geanalyseerd. Op de pagina van de link zie je wat je toestaat, vul je je identiteitsnummer in en bevestig je het zelf.",
    button: "Bekijken en bevestigen",
    expiry: "De link verloopt over 24 uur.",
    notYou: "Ben je niet de wettelijke voogd of verwachtte je deze e-mail niet? Negeer hem dan: zonder jouw bevestiging wordt niets geanalyseerd.",
    legal: "Toestemming vereist door de AVG (art. 8) en de Spaanse wet (LOPDGDD art. 7) voor het verwerken van gegevens van kinderen onder de 14. Na je bevestiging sturen we je een link om haar op elk moment in te trekken.",
  },
};

const CONFIRMATION: Record<ReportLocale, ConfirmationCopy> = {
  es: {
    subject: "VITAS · Consentimiento confirmado",
    title: "Consentimiento confirmado",
    hello: (p) => `Hola ${p}:`,
    body: (c) => `Has confirmado tu consentimiento como tutor legal de <strong>${c}</strong>. Desde ahora se pueden analizar los vídeos en los que aparece.`,
    withdrawIntro: "Puedes retirarlo cuando quieras con este enlace. Al retirarlo se dejan de analizar sus vídeos.",
    button: "Retirar el consentimiento",
    keep: "Guarda este correo: el enlace no caduca y solo sirve para retirar este consentimiento.",
    legal: "RGPD art. 7.3: retirar el consentimiento es tan fácil como darlo.",
  },
  "es-419": {
    subject: "VITAS · Consentimiento confirmado",
    title: "Consentimiento confirmado",
    hello: (p) => `Hola ${p}:`,
    body: (c) => `Confirmaste tu consentimiento como tutor legal de <strong>${c}</strong>. Desde ahora se pueden analizar los videos en los que aparece.`,
    withdrawIntro: "Puedes retirarlo cuando quieras con este enlace. Al retirarlo se dejan de analizar sus videos.",
    button: "Retirar el consentimiento",
    keep: "Guarda este correo: el enlace no vence y solo sirve para retirar este consentimiento.",
    legal: "RGPD art. 7.3: retirar el consentimiento es tan fácil como darlo.",
  },
  en: {
    subject: "VITAS · Consent confirmed",
    title: "Consent confirmed",
    hello: (p) => `Hello ${p},`,
    body: (c) => `You have confirmed your consent as legal guardian of <strong>${c}</strong>. From now on the videos in which they appear can be analysed.`,
    withdrawIntro: "You can withdraw it at any time with this link. Once withdrawn, their videos are no longer analysed.",
    button: "Withdraw consent",
    keep: "Keep this email: the link does not expire and only withdraws this consent.",
    legal: "GDPR Art. 7(3): withdrawing consent is as easy as giving it.",
  },
  de: {
    subject: "VITAS · Einwilligung bestätigt",
    title: "Einwilligung bestätigt",
    hello: (p) => `Hallo ${p},`,
    body: (c) => `Du hast deine Einwilligung als Erziehungsberechtigte/r von <strong>${c}</strong> bestätigt. Ab jetzt können die Videos, in denen das Kind zu sehen ist, analysiert werden.`,
    withdrawIntro: "Du kannst sie jederzeit mit diesem Link widerrufen. Danach werden seine Videos nicht mehr analysiert.",
    button: "Einwilligung widerrufen",
    keep: "Bewahre diese E-Mail auf: Der Link läuft nicht ab und dient nur zum Widerruf dieser Einwilligung.",
    legal: "DSGVO Art. 7 Abs. 3: Der Widerruf muss so einfach sein wie die Erteilung.",
  },
  fr: {
    subject: "VITAS · Consentement confirmé",
    title: "Consentement confirmé",
    hello: (p) => `Bonjour ${p},`,
    body: (c) => `Vous avez confirmé votre consentement en tant que tuteur légal de <strong>${c}</strong>. Les vidéos où il apparaît peuvent désormais être analysées.`,
    withdrawIntro: "Vous pouvez le retirer à tout moment avec ce lien. Une fois retiré, ses vidéos ne sont plus analysées.",
    button: "Retirer le consentement",
    keep: "Conservez cet e-mail : le lien n'expire pas et sert uniquement à retirer ce consentement.",
    legal: "RGPD art. 7.3 : il doit être aussi simple de retirer que de donner son consentement.",
  },
  it: {
    subject: "VITAS · Consenso confermato",
    title: "Consenso confermato",
    hello: (p) => `Ciao ${p},`,
    body: (c) => `Hai confermato il tuo consenso come tutore legale di <strong>${c}</strong>. Da ora si possono analizzare i video in cui compare.`,
    withdrawIntro: "Puoi revocarlo quando vuoi con questo link. Una volta revocato, i suoi video non vengono più analizzati.",
    button: "Revoca il consenso",
    keep: "Conserva questa email: il link non scade e serve solo a revocare questo consenso.",
    legal: "GDPR art. 7.3: revocare il consenso è facile quanto darlo.",
  },
  nl: {
    subject: "VITAS · Toestemming bevestigd",
    title: "Toestemming bevestigd",
    hello: (p) => `Hallo ${p},`,
    body: (c) => `Je hebt je toestemming als wettelijke voogd van <strong>${c}</strong> bevestigd. Vanaf nu kunnen de video's waarin het kind te zien is, worden geanalyseerd.`,
    withdrawIntro: "Je kunt haar op elk moment intrekken met deze link. Daarna worden de video's niet meer geanalyseerd.",
    button: "Toestemming intrekken",
    keep: "Bewaar deze e-mail: de link verloopt niet en dient alleen om deze toestemming in te trekken.",
    legal: "AVG art. 7 lid 3: intrekken moet even eenvoudig zijn als toestemming geven.",
  },
};

/** Marco común (fondo claro: regla del owner, nada de fondos oscuros). */
function frame(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;color:#0F172A;background:#F4F7FB;padding:40px 20px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;border:1px solid #E2E8F0;">
    <h1 style="font-size:22px;margin:0 0 16px;color:#0066CC;">${title}</h1>
    ${inner}
  </div>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="text-align:center;margin:32px 0;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 32px;background:#0066CC;color:#fff;text-decoration:none;border-radius:100px;font-weight:600;">${label}</a>
    </p>`;
}

export function requestEmail(input: { locale: unknown; parentName: string; childName: string; link: string }) {
  const c = REQUEST[normalizeLocale(input.locale)];
  const parent = escapeHtml(input.parentName);
  const child = escapeHtml(input.childName);
  return {
    subject: c.subject,
    html: frame(
      c.title,
      `<p>${c.hello(parent)}</p>
    <p>${c.intro(child)}</p>
    <p>${c.what}</p>
    ${button(input.link, c.button)}
    <p style="font-size:13px;color:#64748b;">${c.expiry} ${c.notYou}</p>
    <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;">
    <p style="font-size:12px;color:#94a3b8;">${c.legal}</p>`,
    ),
  };
}

export function confirmationEmail(input: { locale: unknown; parentName: string; childName: string; withdrawLink: string }) {
  const c = CONFIRMATION[normalizeLocale(input.locale)];
  const parent = escapeHtml(input.parentName);
  const child = escapeHtml(input.childName);
  return {
    subject: c.subject,
    html: frame(
      c.title,
      `<p>${c.hello(parent)}</p>
    <p>${c.body(child)}</p>
    <p>${c.withdrawIntro}</p>
    ${button(input.withdrawLink, c.button)}
    <p style="font-size:13px;color:#64748b;">${c.keep}</p>
    <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;">
    <p style="font-size:12px;color:#94a3b8;">${c.legal}</p>`,
    ),
  };
}

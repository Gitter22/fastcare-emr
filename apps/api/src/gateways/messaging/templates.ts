import { getEnv } from "../../env.js";

/**
 * Every outbound SMS/email body, in one place, so INV-SEC-06 can be checked by a test (test/inv_sec_06.test.mjs):
 * no diagnosis, medication, result or other clinical words, and no patient name beyond a first name. Parameters
 * are typed per template and are all non-clinical (practice name, time, link, code).
 */
interface Templates {
  "mfa-code": { code: string };
  "staff-invite": { practiceName: string; link: string };
  "password-reset": { link: string };
  "portal-invite": { practiceName: string; link: string; code: string };
  "portal-code": { code: string };
  "appointment-confirmation": { practiceName: string; when: string; link: string };
  "appointment-reminder": { practiceName: string; when: string; link: string };
  "appointment-cancelled": { practiceName: string; when: string; link: string };
  "appointment-rescheduled": { practiceName: string; when: string; link: string };
  "running-late": { practiceName: string; minutes: number };
  "waitlist-offer": { practiceName: string; when: string; link: string };
  "recall-outreach": { practiceName: string; link: string };
  "new-portal-message": { practiceName: string; link: string };
  "new-portal-item": { practiceName: string; link: string };
  "statement-ready": { practiceName: string; link: string };
  "payment-receipt": { practiceName: string; amount: string };
  "payment-plan-created": { practiceName: string; amount: string; months: number; link: string };
  "consent-request": { practiceName: string; link: string };
  "checkin-reminder": { practiceName: string; link: string };
  "telehealth-link": { practiceName: string; when: string; link: string };
}

export type TemplateKey = keyof Templates;
export type TemplateParams<K extends TemplateKey> = Templates[K];

const app = () => getEnv().APP_NAME;

const render: { [K in TemplateKey]: (p: Templates[K]) => { subject: string; body: string } } = {
  "mfa-code": (p) => ({
    subject: `${app()} sign-in code`,
    body: `Your ${app()} code is ${p.code}. It expires in 10 minutes. Do not share it.`,
  }),
  "staff-invite": (p) => ({
    subject: `You're invited to ${p.practiceName}`,
    body: `You have been invited to ${p.practiceName} on ${app()}. Set up your account: ${p.link}`,
  }),
  "password-reset": (p) => ({
    subject: `${app()} password reset`,
    body: `Use this link to reset your password. It works once and expires in 1 hour: ${p.link}`,
  }),
  "portal-invite": (p) => ({
    subject: `${p.practiceName} patient portal`,
    body: `${p.practiceName} invited you to the patient portal. Your activation code is ${p.code}. Start here: ${p.link}`,
  }),
  "portal-code": (p) => ({
    subject: "Your verification code",
    body: `Your verification code is ${p.code}. It expires in 10 minutes.`,
  }),
  "appointment-confirmation": (p) => ({
    subject: `${p.practiceName} appointment booked`,
    body: `${p.practiceName}: your appointment is booked for ${p.when}. Details or changes: ${p.link}`,
  }),
  "appointment-reminder": (p) => ({
    subject: `${p.practiceName} appointment reminder`,
    body: `${p.practiceName}: reminder of your appointment on ${p.when}. Reply C to confirm or use ${p.link} to change it.`,
  }),
  "appointment-cancelled": (p) => ({
    subject: `${p.practiceName} appointment cancelled`,
    body: `${p.practiceName}: your appointment on ${p.when} was cancelled. To book again: ${p.link}`,
  }),
  "appointment-rescheduled": (p) => ({
    subject: `${p.practiceName} appointment moved`,
    body: `${p.practiceName}: your appointment moved to ${p.when}. Details: ${p.link}`,
  }),
  "running-late": (p) => ({
    subject: `${p.practiceName} schedule update`,
    body: `${p.practiceName}: we are running about ${p.minutes} minutes behind. Thank you for your patience.`,
  }),
  "waitlist-offer": (p) => ({
    subject: `${p.practiceName} earlier appointment`,
    body: `${p.practiceName}: an earlier time opened on ${p.when}. Accept it here: ${p.link}`,
  }),
  "recall-outreach": (p) => ({
    subject: `${p.practiceName}: time to book`,
    body: `${p.practiceName}: you are due for a visit. Book here: ${p.link}`,
  }),
  "new-portal-message": (p) => ({
    subject: `New message from ${p.practiceName}`,
    body: `You have a new message from ${p.practiceName}. Sign in to read it: ${p.link}`,
  }),
  "new-portal-item": (p) => ({
    subject: `Update from ${p.practiceName}`,
    body: `There is something new in your ${p.practiceName} portal. Sign in to see it: ${p.link}`,
  }),
  "statement-ready": (p) => ({
    subject: `${p.practiceName} statement`,
    body: `Your ${p.practiceName} statement is ready. View and pay: ${p.link}`,
  }),
  "payment-receipt": (p) => ({
    subject: `${p.practiceName} payment received`,
    body: `${p.practiceName}: we received your payment of ${p.amount}. Thank you.`,
  }),
  "payment-plan-created": (p) => ({
    subject: `${p.practiceName} payment plan`,
    body: `${p.practiceName}: your payment plan is set up (${p.months} monthly payments of ${p.amount}). Details: ${p.link}`,
  }),
  "consent-request": (p) => ({
    subject: `${p.practiceName} forms to sign`,
    body: `${p.practiceName} has forms for you to review and sign: ${p.link}`,
  }),
  "checkin-reminder": (p) => ({
    subject: `${p.practiceName} check in online`,
    body: `${p.practiceName}: save time by checking in online before your visit: ${p.link}`,
  }),
  "telehealth-link": (p) => ({
    subject: `${p.practiceName} video visit`,
    body: `${p.practiceName}: your video visit is at ${p.when}. Join from the portal: ${p.link}`,
  }),
};

export function renderTemplate<K extends TemplateKey>(
  key: K,
  params: Templates[K],
): { subject: string; body: string } {
  return render[key](params);
}

export const templateKeys = Object.keys(render) as TemplateKey[];

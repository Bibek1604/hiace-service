import nodemailer, { type Transporter } from 'nodemailer';

let cached: Transporter | null = null;
export const emailConfigured = () => !!(process.env.SMTP_HOST && process.env.MAIL_FROM);

function transport() {
  if (!process.env.SMTP_HOST || !process.env.MAIL_FROM) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  cached ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    // STARTTLS is mandatory in production unless SMTP_REQUIRE_TLS=false (internal relays, test sinks).
    requireTLS: process.env.SMTP_REQUIRE_TLS
      ? process.env.SMTP_REQUIRE_TLS === 'true'
      : process.env.NODE_ENV === 'production' && port !== 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  return cached;
}

/** Sends one email. `messageId` makes a retry after a crash recognisable to the receiving server. */
export async function sendEmail(m: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
}) {
  const t = transport();
  if (!t) throw new Error('Email is not configured');
  await t.sendMail({
    from: process.env.MAIL_FROM,
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
    messageId: m.messageId ? '<' + m.messageId + '@sajilo-yatra>' : undefined,
  });
}

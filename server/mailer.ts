/**
 * Mailer — nodemailer with a dev-console fallback.
 *
 * If SMTP_* env vars are set, real emails are sent via SMTP.
 * Otherwise, emails are logged to the console so local dev doesn't
 * need a real mail provider.
 *
 * Required env for real sending:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * Optional:
 *   SMTP_SECURE=true  (use TLS; usually port 465)
 *   APP_BASE_URL=https://your-domain   (used in email links)
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

interface MailInput {
  to: string;
  subject: string;
  body: string;
  text?: string;
}

let cachedTransport: Transporter | null = null;
let configWarned = false;

function isConfigured(): boolean {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM
  );
}

function getTransport(): Transporter | null {
  if (cachedTransport) return cachedTransport;
  if (!isConfigured()) return null;

  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return cachedTransport;
}

export async function sendMail(input: MailInput): Promise<boolean> {
  const transport = getTransport();

  if (!transport) {
    if (!configWarned) {
      console.log('[mailer] SMTP not configured — logging emails to console instead.');
      configWarned = true;
    }
    console.log('─── EMAIL (dev console fallback) ───');
    console.log('To:      ' + input.to);
    console.log('Subject: ' + input.subject);
    console.log('Body:');
    console.log(input.text || input.body);
    console.log('────────────────────────────────────');
    return true;
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text || input.body,
      html: input.body,
    });
    return true;
  } catch (err: any) {
    console.error('[mailer] send failed:', err?.message ?? err);
    return false;
  }
}

export function appBaseUrl(): string {
  return process.env.APP_BASE_URL || 'http://localhost:' + (process.env.PORT ?? '3001');
}

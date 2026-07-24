import { promises as dns } from "node:dns";
import nodemailer from "nodemailer";

let transporter = null;

async function resolveIPv4(hostname) {
  const { address } = await dns.lookup(hostname, { family: 4 });
  return address;
}

async function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER and GMAIL_APP_PASSWORD environment variables must be set."
    );
  }

  if (!transporter) {
    // Render's network has no outbound IPv6 route, and neither nodemailer's
    // `family` option nor Node's default DNS result order reliably kept
    // the connection on IPv4 here. Resolving the address ourselves and
    // connecting to the literal IP removes any ambiguity; `tls.servername`
    // keeps TLS certificate validation working against the real hostname.
    const ipv4Address = await resolveIPv4("smtp.gmail.com");

    transporter = nodemailer.createTransport({
      host: ipv4Address,
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { servername: "smtp.gmail.com" },
      auth: { user, pass },
    });
  }

  return transporter;
}

export async function sendCommitteeActivationEmail({ to, name, activationUrl }) {
  const from = process.env.GMAIL_USER;
  const transport = await getTransporter();

  await transport.sendMail({
    from: `Amra Notun Network <${from}>`,
    to,
    subject: "Activate your Amra Notun Network Selection Committee account",
    html: `
      <p>Hi ${name},</p>
      <p>Your Selection Committee registration has been approved. Click the button below to set your password and activate your account.</p>
      <p>
        <a href="${activationUrl}"
           style="background:#e6007e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">
          Activate my account
        </a>
      </p>
      <p>Or copy this link into your browser:<br/>${activationUrl}</p>
      <p>This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
    `,
  });
}

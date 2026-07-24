import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER and GMAIL_APP_PASSWORD environment variables must be set."
    );
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      // Render's network has no outbound IPv6 route, and Gmail's SMTP
      // hostname resolves to an IPv6 address by default, which fails
      // with ENETUNREACH. Force IPv4 to avoid that.
      family: 4,
      auth: { user, pass },
    });
  }

  return transporter;
}

export async function sendCommitteeActivationEmail({ to, name, activationUrl }) {
  const from = process.env.GMAIL_USER;

  await getTransporter().sendMail({
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

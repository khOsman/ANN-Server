import { Resend } from "resend";

let resendClient = null;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY environment variable is not set.");
  }

  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }

  return resendClient;
}

export async function sendCommitteeActivationEmail({ to, name, activationUrl }) {
  const from = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

  const { error } = await getResendClient().emails.send({
    from,
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

  if (error) {
    throw new Error(error.message || "Failed to send activation email.");
  }
}

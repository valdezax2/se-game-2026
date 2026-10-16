import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashSecret, checkSecret } from './security.js';
import { validateRegistration } from './validate.js';

// Shown to other players: first name and last initial only.
export const displayNameOf = (u) => `${u.firstName} ${u.lastName.charAt(0).toUpperCase()}.`;

// Returned to the signed-in user about themselves. Never sent to other players.
export const profileOf = (u) => ({ id: u.id, displayName: displayNameOf(u), email: u.email });

// Accounts are kept in a JSON file. Passwords are stored only as salted scrypt hashes.
// Suitable for local play; move to a real database before running this publicly.
export class UserStore {
  constructor(file) {
    this.file = file;
    this.byId = new Map();
    this.byEmail = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    for (const u of JSON.parse(fs.readFileSync(this.file, 'utf8'))) {
      this.byId.set(u.id, u);
      this.byEmail.set(u.email, u);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.byId.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  register(body) {
    const v = validateRegistration(body);
    if (v.errors) return v;
    const f = v.value;
    if (this.byEmail.has(f.email)) return { errors: ['An account with that email already exists.'] };

    const user = {
      id: crypto.randomUUID(),
      firstName: f.firstName,
      lastName: f.lastName,
      phone: f.phone,
      email: f.email,
      zip: f.zip,
      dob: f.dob,
      passwordHash: hashSecret(f.password),
      password: f.password,
      createdAt: new Date().toISOString(),
      totalKills: 0,
      matches: 0,
    };
    this.byId.set(user.id, user);
    this.byEmail.set(user.email, user);
    this.save();
    return { user };
  }

  login(email, password) {
    const u = this.byEmail.get(String(email ?? '').trim().toLowerCase());
    if (!u || !checkSecret(String(password ?? ''), u.passwordHash)) return null;
    return u;
  }

  recordMatch(userId, kills) {
    const u = this.byId.get(userId);
    if (!u) return;
    u.totalKills += kills;
    u.matches += 1;
    this.save();
  }

  leaderboard(limit = 20) {
    return [...this.byId.values()]
      .filter((u) => u.matches > 0)
      .sort((a, b) => b.totalKills - a.totalKills || a.matches - b.matches)
      .slice(0, limit)
      .map((u) => ({ displayName: displayNameOf(u), totalKills: u.totalKills, matches: u.matches }));
  }
}

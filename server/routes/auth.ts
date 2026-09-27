import express from 'express';
import { db } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  createSession,
  resolveSession,
  destroySession,
} from '../auth/sessions.js';
import {
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
} from '../auth/cookies.js';

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body ?? {};

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res
      .status(400)
      .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (typeof displayName !== 'string' || displayName.trim().length < 1) {
    return res.status(400).json({ error: 'A display name is required.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.users.findByEmail(normalizedEmail);
  if (existing) {
    return res
      .status(409)
      .json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await hashPassword(password);
  const user = await db.users.create({
    email: normalizedEmail,
    passwordHash,
    displayName: displayName.trim(),
    role: 'student',
  });

  const token = await createSession(user.id);
  setSessionCookie(res, token);

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = await db.users.findByEmail(email.trim());
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = await createSession(user.id);
  setSessionCookie(res, token);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (token) {
    await destroySession(token);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const user = await resolveSession(token);
  if (!user) {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }
  res.json({ user });
});

export default router;

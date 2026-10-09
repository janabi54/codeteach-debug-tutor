import express from 'express';
import { db } from '../db.js';
import { requireAuth, requireInstructor } from '../middleware/requireAuth.js';
import { canInstructorMessageStudent } from '../auth/authorization.js';
import { sendMail, appBaseUrl } from '../mailer.js';
import { broadcastToUser, pushUnreadCount } from '../websocket.js';

const router = express.Router();

const MAX_BODY_LENGTH = 2000;
const MAX_SUBJECT_LENGTH = 120;

// ─────────────────────────────────────────────────────────────
// POST /api/admin/students/:studentId/nudges
// Instructor sends a message (opens the thread if it doesn't exist).
// Body: { body: string, subject?: string }
// ─────────────────────────────────────────────────────────────
router.post(
  '/admin/students/:studentId/nudges',
  requireInstructor,
  async (req, res) => {
    const instructorId = req.user!.id;
    const instructorEmail = req.user!.email ?? null;
    const { studentId } = req.params;
    const { body, subject } = req.body as { body?: string; subject?: string };

    if (!canInstructorMessageStudent(instructorId, studentId)) {
      return res.status(403).json({ error: 'You do not teach this student.' });
    }

    const trimmedBody = (body ?? '').trim();
    if (trimmedBody.length === 0) {
      return res.status(400).json({ error: 'Message body is required.' });
    }
    if (trimmedBody.length > MAX_BODY_LENGTH) {
      return res.status(400).json({ error: `Message body must be ${MAX_BODY_LENGTH} characters or fewer.` });
    }
    const trimmedSubject = (subject ?? '').trim().slice(0, MAX_SUBJECT_LENGTH) || null;

    const student = await db.users.findById(studentId);
    if (!student) {
      return res.status(404).json({ error: 'Student not found.' });
    }

    // Get or create the thread
    const thread = db.nudges.ensureThread(instructorId, studentId, trimmedSubject);

    // Add the message
    const message = db.nudges.addMessage({
      threadId: thread.id,
      authorId: instructorId,
      authorRole: 'instructor',
      body: trimmedBody,
    });

    // Fire-and-forget email + WebSocket push
    void (async () => {
      try {
        // Email to student
        const base = appBaseUrl();
        const subjectLine = 'New message from ' + (req.user!.displayName || 'your tutor');
        const htmlBody =
          '<p>Hi ' + escapeHtml(student.displayName) + ',</p>' +
          '<p>You have a new message from <strong>' + escapeHtml(req.user!.displayName) + '</strong>:</p>' +
          '<blockquote style="border-left:3px solid #6366f1;padding:8px 12px;color:#333;background:#f8fafc;">' +
          escapeHtml(trimmedBody).replace(/\n/g, '<br>') +
          '</blockquote>' +
          '<p><a href="' + base + '/#messages">Open CodeTeach to read and reply</a></p>';
        await sendMail({
          to: student.email,
          subject: subjectLine,
          body: htmlBody,
          text: 'Hi ' + student.displayName + ',\n\n' + trimmedBody + '\n\nReply at ' + base + '/#messages',
        });
      } catch (err) {
        console.error('[nudges] email failed:', err);
      }
    })();

    // Push to the student's socket(s)
    broadcastToUser(studentId, {
      type: 'nudge:new',
      threadId: thread.id,
      from: {
        id: instructorId,
        name: req.user!.displayName,
        email: instructorEmail,
      },
      body: trimmedBody,
      createdAt: message.createdAt,
    });
    void pushUnreadCount(studentId);

    res.status(201).json({ threadId: thread.id, message });
  }
);

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/:studentId/nudges
// Instructor views the thread + all messages with this student.
// Returns { thread: null } if no thread exists yet.
// ─────────────────────────────────────────────────────────────
router.get(
  '/admin/students/:studentId/nudges',
  requireInstructor,
  async (req, res) => {
    const instructorId = req.user!.id;
    const { studentId } = req.params;

    if (!canInstructorMessageStudent(instructorId, studentId)) {
      return res.status(403).json({ error: 'You do not teach this student.' });
    }

    const thread = db.nudges.findThreadBetween(instructorId, studentId);
    if (!thread) {
      return res.json({ thread: null, messages: [] });
    }
    const messages = db.nudges.listMessages(thread.id);
    res.json({ thread, messages });
  }
);

// ─────────────────────────────────────────────────────────────
// GET /api/me/nudges
// Current user (either role) lists all threads they're a part of.
// ─────────────────────────────────────────────────────────────
router.get('/me/nudges', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const threads = db.nudges.listThreadsForUser(userId);
  res.json({ threads });
});

// ─────────────────────────────────────────────────────────────
// GET /api/me/nudges/unread-count
// Just the badge number.
// ─────────────────────────────────────────────────────────────
router.get('/me/nudges/unread-count', requireAuth, async (req, res) => {
  const count = db.nudges.unreadCount(req.user!.id);
  res.json({ count });
});

// ─────────────────────────────────────────────────────────────
// GET /api/me/nudges/:threadId
// One thread + all its messages. Caller must be a participant.
// ─────────────────────────────────────────────────────────────
router.get('/me/nudges/:threadId', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { threadId } = req.params;

  const thread = db.nudges.getThreadById(threadId);
  if (!thread) {
    return res.status(404).json({ error: 'Thread not found.' });
  }
  if (thread.instructorId !== userId && thread.studentId !== userId) {
    return res.status(403).json({ error: 'You are not a participant in this thread.' });
  }
  const messages = db.nudges.listMessages(threadId);
  res.json({ thread, messages });
});

// ─────────────────────────────────────────────────────────────
// POST /api/me/nudges/:threadId/reply
// Post a reply. Body: { body: string }
// ─────────────────────────────────────────────────────────────
router.post('/me/nudges/:threadId/reply', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { threadId } = req.params;
  const { body } = req.body as { body?: string };

  const trimmed = (body ?? '').trim();
  if (trimmed.length === 0) {
    return res.status(400).json({ error: 'Message body is required.' });
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    return res.status(400).json({ error: `Message body must be ${MAX_BODY_LENGTH} characters or fewer.` });
  }

  const thread = db.nudges.getThreadById(threadId);
  if (!thread) {
    return res.status(404).json({ error: 'Thread not found.' });
  }

  const isInstructor = thread.instructorId === userId;
  const isStudent = thread.studentId === userId;
  if (!isInstructor && !isStudent) {
    return res.status(403).json({ error: 'You are not a participant in this thread.' });
  }

  const authorRole: 'instructor' | 'student' = isInstructor ? 'instructor' : 'student';
  const message = db.nudges.addMessage({
    threadId,
    authorId: userId,
    authorRole,
    body: trimmed,
  });

  // Determine recipient
  const recipientId = isInstructor ? thread.studentId : thread.instructorId;
  const recipient = await db.users.findById(recipientId);

  if (recipient) {
    void (async () => {
      try {
        const base = appBaseUrl();
        const senderName = req.user!.displayName || 'a user';
        const htmlBody =
          '<p><strong>' + escapeHtml(senderName) + '</strong> replied in CodeTeach:</p>' +
          '<blockquote style="border-left:3px solid #6366f1;padding:8px 12px;color:#333;background:#f8fafc;">' +
          escapeHtml(trimmed).replace(/\n/g, '<br>') +
          '</blockquote>' +
          '<p><a href="' + base + '/#messages">Open CodeTeach to read and reply</a></p>';
        await sendMail({
          to: recipient.email,
          subject: senderName + ' replied to your message',
          body: htmlBody,
          text: senderName + ' replied:\n\n' + trimmed + '\n\nOpen ' + base + '/#messages',
        });
      } catch (err) {
        console.error('[nudges] reply email failed:', err);
      }
    })();

    broadcastToUser(recipientId, {
      type: 'nudge:reply',
      threadId,
      from: {
        id: userId,
        name: req.user!.displayName,
        role: authorRole,
      },
      body: trimmed,
      createdAt: message.createdAt,
    });
    void pushUnreadCount(recipientId);
  }

  res.status(201).json({ message });
});

// ─────────────────────────────────────────────────────────────
// POST /api/me/nudges/:threadId/read
// Mark all messages NOT authored by the caller as read.
// ─────────────────────────────────────────────────────────────
router.post('/me/nudges/:threadId/read', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { threadId } = req.params;

  const thread = db.nudges.getThreadById(threadId);
  if (!thread) {
    return res.status(404).json({ error: 'Thread not found.' });
  }
  if (thread.instructorId !== userId && thread.studentId !== userId) {
    return res.status(403).json({ error: 'You are not a participant in this thread.' });
  }

  const changed = db.nudges.markThreadRead(threadId, userId);
  void pushUnreadCount(userId);
  res.json({ ok: true, changed });
});

// Small HTML escaper for email bodies
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default router;

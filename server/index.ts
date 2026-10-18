import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import debugTutorRoutes from './routes/debugTutor.js';
import adminRoutes from './routes/admin.js';
import exerciseRoutes from './routes/exercises.js';
import cohortRoutes from './routes/cohorts.js';
import cohortAdminRoutes from './routes/cohortAdmin.js';
import studentRoutes from './routes/students.js';
import notesRoutes from './routes/notes.js';
import authRoutes from './routes/auth.js';
import { startHealthMonitor } from './admin/alerts.js';
import { bootstrapInstructor } from './auth/bootstrap.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { seedExercisesFromConfig } from './db/seedExercises.js';
import { attachWebSocketServer } from './websocket.js';
import nudgeRoutes from './routes/nudges.js';
import meRoutes from './routes/me.js';
import runRoutes from './routes/run.js';
import meExercisesRoutes from './routes/meExercises.js';
import { pathToFileURL } from 'node:url';
import { startDispatcher } from './webhooks/outbound/dispatcher.js';
import inboundWebhookRouter from './webhooks/inbound/router.js';
import { startInboundPoller } from './webhooks/inbound/poller.js';

const app = express();

// Inbound webhooks MUST be mounted before the global JSON body parser.
// Signature verification needs raw bytes, not a parsed object.
app.use(
  '/webhooks/in',
  express.raw({ type: '*/*', limit: '1mb' }),
  inboundWebhookRouter
);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
const PUBLIC_DIR = process.env.PUBLIC_DIR || 'public';
app.use(express.static(PUBLIC_DIR));

app.use('/api/auth', authRoutes);
app.use('/api/debug-tutor', debugTutorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/exercises', exerciseRoutes);
app.use('/api/cohorts', cohortRoutes);
app.use('/api/admin/cohorts', cohortAdminRoutes);
app.use('/api/admin/students', studentRoutes);
app.use('/api/admin', notesRoutes);
app.use('/api', nudgeRoutes);
app.use('/api', meRoutes);
app.use('/api', runRoutes);
app.use('/api/me/exercises', meExercisesRoutes);

const PORT = Number(process.env.PORT ?? 3001);

export async function startServer(): Promise<{ port: number }> {
  await bootstrapInstructor();
  await seedExercisesFromConfig();
  await pruneExpiredSessions();

  return new Promise((resolve) => {
    const httpServer = app.listen(PORT, () => {
      console.log(`CodeTeach Debug Tutor listening on :${PORT}`);
      if (process.env.NODE_ENV === 'production') startHealthMonitor();
      resolve({ port: PORT });
    });
    attachWebSocketServer(httpServer);
    startDispatcher();

    startInboundPoller();
  });
}

// Run directly when executed as a script (npm run dev / npm start).
// On Windows, argv[1] is a raw path — must convert via pathToFileURL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

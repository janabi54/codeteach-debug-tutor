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

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static('public'));

app.use('/api/auth', authRoutes);
app.use('/api/debug-tutor', debugTutorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/exercises', exerciseRoutes);
app.use('/api/cohorts', cohortRoutes);
app.use('/api/admin/cohorts', cohortAdminRoutes);
app.use('/api/admin/students', studentRoutes);
app.use('/api/admin', notesRoutes);

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  await bootstrapInstructor();
  await seedExercisesFromConfig();
  await pruneExpiredSessions();

  app.listen(PORT, () => {
    console.log(`CodeTeach Debug Tutor listening on :${PORT}`);
    if (process.env.NODE_ENV === 'production') startHealthMonitor();
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

import { db } from '../db.js';
const REQUIRED_ATTEMPTS_PER_LEVEL = 2;

export class HintSessionManager {
  async getOrCreate(s: string, e: string, options?: { struggleMinutes?: number }) {
    return db.hintSessions.getOrCreate(s, e, options);
  }
  async recordAttempt(s: string, e: string, passed: boolean) {
    const session = await this.getOrCreate(s, e);
    if (passed) {
      await db.hintSessions.update(session.id, { resolved: true });
      return { resolved: true, newLevel: session.currentLevel, escalated: false };
    }
    const attemptsAtLevel = session.attemptsAtLevel + 1;
    let newLevel = session.currentLevel;
    if (attemptsAtLevel >= REQUIRED_ATTEMPTS_PER_LEVEL && session.currentLevel < 4)
      newLevel = session.currentLevel + 1;
    await db.hintSessions.update(session.id, {
      attemptsAtLevel: newLevel > session.currentLevel ? 0 : attemptsAtLevel,
      currentLevel: newLevel, totalAttempts: session.totalAttempts + 1,
    });
    return { resolved: false, newLevel, escalated: newLevel > session.currentLevel };
  }
  async reset(s: string, e: string) {
    await db.hintSessions.update2(s, e, {
      currentLevel: 1, attemptsAtLevel: 0, resolved: false,
    });
  }
}

/**
 * Centralized role + capability helpers.
 *
 * In this app:
 *   - `role` is one of 'student' | 'instructor'.
 *   - `isAdmin` is a capability flag on top of instructor.
 *
 * Admins can mint/revoke invite codes; regular instructors cannot.
 */

export interface RoleSubject {
  role: 'student' | 'instructor';
  isAdmin?: boolean;
}

export function isInstructor(user: RoleSubject | null | undefined): boolean {
  return !!user && user.role === 'instructor';
}

export function isAdmin(user: RoleSubject | null | undefined): boolean {
  return isInstructor(user) && user!.isAdmin === true;
}

/**
 * Whether new instructor signups should be auto-promoted to admin.
 * Set DISABLE_OPEN_ADMIN=true to require CLI/invite-based promotion.
 */
export function openAdminSignupEnabled(): boolean {
  return process.env.DISABLE_OPEN_ADMIN !== 'true';
}

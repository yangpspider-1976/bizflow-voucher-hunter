// The password rule for console accounts, in a module both sides can import.
//
// It cannot live in `@/server/admin-users` alongside the hashing: that module
// pulls in node:crypto and the database, so a client component importing the
// rule from there would drag both into the browser bundle.

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Measured trimmed, stored as typed.
 *
 * Counting the raw length let a wall of spaces clear the minimum, so an account
 * could be created with a password nobody could reliably type back. Trimming
 * the measurement alone keeps padding out of the length budget without quietly
 * changing the credential someone chose.
 */
export function isPasswordTooShort(password: string) {
  return password.trim().length < MIN_PASSWORD_LENGTH;
}

export const PASSWORD_RULE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters, not counting leading or trailing spaces`;

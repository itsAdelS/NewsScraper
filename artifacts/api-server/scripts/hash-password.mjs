#!/usr/bin/env node
/**
 * Generate a bcrypt hash for the ADMIN_PASSWORD_HASH secret.
 *
 * Usage:
 *   node scripts/hash-password.mjs 'your-new-password'
 *
 * Copy the printed hash into the ADMIN_PASSWORD_HASH secret/env var.
 * The plaintext password is never stored anywhere.
 */
import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-password.mjs '<password>'");
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 12));

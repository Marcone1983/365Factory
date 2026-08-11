import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../src/lib/db/client';
import { createUser, findUserByEmail } from '../src/lib/security/auth';
import { checkPasswordPolicy } from '../src/lib/security/passwords';

/**
 * Creates an administrator.
 *
 * Credentials come from the arguments, then the environment, then an
 * interactive prompt — so it works in CI and by hand without ever defaulting to
 * a well-known password.
 */
async function main(): Promise<void> {
  db();
  const [argEmail, argPassword] = process.argv.slice(2);
  let email = argEmail ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? '';
  let password = argPassword ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';

  if (!email || !password) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    if (!email) email = await rl.question('Admin email: ');
    if (!password) password = await rl.question('Admin password (min 12 chars, upper, lower, digit): ');
    rl.close();
  }

  const policy = checkPasswordPolicy(password);
  if (!policy.ok) {
    process.stderr.write(`Password rejected: ${policy.problems.join(', ')}\n`);
    process.exit(1);
  }
  if (findUserByEmail(email)) {
    process.stderr.write(`A user with the address ${email} already exists.\n`);
    process.exit(1);
  }

  const user = await createUser({ email, password, role: 'admin', displayName: email.split('@')[0] ?? 'admin' });
  process.stdout.write(`Created administrator ${user.email} (${user.id}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});

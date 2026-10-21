import { hashPassword } from '../auth.js';

/** Legge la password da stdin e stampa la riga AUTH_PASS_HASH=... */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const password = await readStdin();
if (!password) {
  console.error('Password vuota: passala da stdin, es. printf \'%s\' \'password\' | npm run hash-password --workspace server');
  process.exit(1);
}
console.log(`AUTH_PASS_HASH=${await hashPassword(password)}`);

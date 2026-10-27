import { createHash } from 'crypto';

/** Hash the exact environment passed to spawn; never publish its values. */
export function fingerprintLaunchEnvironment(environment: NodeJS.ProcessEnv): string {
  const pairs = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => [Buffer.from(name, 'utf8'), Buffer.from(value, 'utf8')] as const)
    .sort(([left], [right]) => Buffer.compare(left, right));
  const digest = createHash('sha256').update('django-orm-launch-environment-v1\0');
  for (const [name, value] of pairs) digest.update(name).update('\0').update(value).update('\0');
  return digest.digest('hex');
}

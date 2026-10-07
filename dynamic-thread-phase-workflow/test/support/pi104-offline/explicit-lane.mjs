// Explicit SDK lane resolution for offline qualification. Never silently
// substitutes or skips: when the fixture consent flag is armed, the requested
// SDK version MUST match the real package manifest at the explicit path, or
// the lane fails. Without consent this is inert metadata for skip paths.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SDK_PACKAGE_RELATIVE = 'node_modules/@earendil-works/pi-coding-agent';

const manifestVersion = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

export function explicitSdkLane(repoRoot) {
  const packageDir = join(repoRoot, SDK_PACKAGE_RELATIVE);
  const version = manifestVersion(packageDir);
  if (process.env.PI_DELEGATION_COMPAT_FIXTURES === '1') {
    const expected = process.env.PI_DELEGATION_EXPECT_SDK_VERSION;
    if (!expected) throw new Error('INVALID_REQUEST: explicit lane requires PI_DELEGATION_EXPECT_SDK_VERSION with the consent flag');
    if (version !== expected)
      throw new Error(`UNSUPPORTED_VERSION: explicit lane requires SDK ${expected}, found ${version} at ${packageDir}`);
  }
  let aiVersion;
  try { aiVersion = manifestVersion(join(packageDir, 'node_modules/@earendil-works/pi-ai')); }
  catch { aiVersion = manifestVersion(join(repoRoot, 'node_modules/@earendil-works/pi-ai')); }
  return Object.freeze({ version, packageDir, aiVersion });
}

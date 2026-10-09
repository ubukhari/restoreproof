/**
 * The package version, as a constant rather than read from package.json: the drill is copied into
 * customers' repos as one file (`.github/restoreproof/drill.mjs`) with no package.json beside it.
 * src/distribution.test.ts holds it equal to package.json's.
 */
export const VERSION = "0.1.0";

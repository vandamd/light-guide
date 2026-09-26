let releaseUnlock;

export function registerUnlockRelease(release) { releaseUnlock = release; }
export async function releaseUnlockConnection() { await releaseUnlock?.(); }

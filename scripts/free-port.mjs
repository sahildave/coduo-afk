/**
 * Ask the OS for a free TCP port. For tests that spawn a server.
 *
 * Every test file here used to derive its port from `process.pid`, with a
 * per-file base and modulus: `47000 + (process.pid % 900)`. Fourteen call sites
 * across eight files, and the ranges overlapped — `46900 + (pid % 90)` sits
 * inside `46000 + (pid % 1000)`, and three different formulas shared 47000.
 *
 * `afk.mjs selftest` runs those files concurrently, in processes whose pids are
 * near-sequential, so their bases land a few ports apart. Three of the files
 * then walk upward from their base (`++portSeed` per test) straight onto a port
 * a neighbouring file is holding. The result reads as a flaky suite: one failure
 * per run, a different test each time, and every one of them passing in
 * isolation. Port 0 lets the kernel pick something nobody else has.
 *
 * There is a race left — the port is released before the caller binds it — but
 * it is the narrow kind everyone lives with, not the systematic collision above.
 * Call this as late as possible before spawning.
 */
import { createServer } from 'node:net'

export const freePort = async () => {
  const probe = createServer()
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', resolve)
    })
    return probe.address().port
  } finally {
    await new Promise((resolve) => probe.close(resolve))
  }
}

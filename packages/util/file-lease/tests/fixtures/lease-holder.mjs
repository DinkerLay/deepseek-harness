/** Standalone published lease holder; release is explicit, a crash never runs it. */
import { acquireFileLease } from '../../lib/index.js'

const lease = await acquireFileLease(process.argv[2])
const alive = setInterval(() => {}, 1000)
process.stdout.write('holding\n')
process.stdin.once('data', async () => {
  await lease.release()
  clearInterval(alive)
  process.stdout.write('released\n')
  process.stdin.destroy()
})

/**
 * GenosRTC wrapper for Bun runtime.
 * Fixes a Bun bug where literal 0x00 bytes inside regex patterns
 * are not matched correctly (works fine in Node.js/V8).
 * Patches the minified source at import time, re-exports `join`.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join as pathJoin } from 'path'

const src = readFileSync(pathJoin(import.meta.dir, 'genosrtc.min.js'))
const patched = Buffer.alloc(src.length + 10)
let j = 0

for (let i = 0; i < src.length; i++) {
  // Replace /\0/g (2f 00 2f 67) → /\x00/g (2f 5c 78 30 30 2f 67)
  if (src[i] === 0x2f && src[i + 1] === 0x00 && src[i + 2] === 0x2f && src[i + 3] === 0x67) {
    patched[j++] = 0x2f  // /
    patched[j++] = 0x5c  // \
    patched[j++] = 0x78  // x
    patched[j++] = 0x30  // 0
    patched[j++] = 0x30  // 0
    i += 1 // skip the 0x00 byte
  } else {
    patched[j++] = src[i]
  }
}

const tmpPath = pathJoin(import.meta.dir, '.genosrtc-patched.js')
writeFileSync(tmpPath, patched.subarray(0, j))
const mod = await import(tmpPath)
unlinkSync(tmpPath)

export const { join } = mod

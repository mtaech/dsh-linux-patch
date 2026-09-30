/**
 * Protocol-speaking stand-in for the raster worker.
 *
 * `main(mode)` serves requests with the selected reply strategy, so host-side
 * tests can pin framing, error mapping, protocol failure, worker death, and
 * disposal without loading Sharp. Each sibling `raster-worker-<mode>.mjs`
 * entry selects one strategy.
 */

import { Buffer } from 'node:buffer'

const detected = {
  mediaType: 'image/png',
  width: 2,
  height: 3,
  animated: false,
  carriesMetadata: false,
  depth: 'uchar',
  space: 'srgb',
  hasAlpha: false,
}

/** Same framing as the production worker: [jsonLength][json][binaryLength][binary]. */
function encode(json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const frame = Buffer.allocUnsafe(8 + jsonBytes.length + binary.length)
  frame.writeUInt32BE(jsonBytes.length, 0)
  jsonBytes.copy(frame, 4)
  frame.writeUInt32BE(binary.length, 4 + jsonBytes.length)
  binary.copy(frame, 8 + jsonBytes.length)
  return frame
}

function reply(request, binary, mode) {
  if (mode === 'ok' || mode === 'ignore' || mode === 'diagnostic') {
    const result = request.op === 'probeImage' || request.op === 'detectImage'
      ? { op: request.op, detected }
      : { op: request.op, mediaType: 'image/png', width: 2, height: 3 }
    process.stdout.write(encode({ id: request.id, ok: true, result }, Buffer.from(binary).reverse()))
  } else if (mode === 'failure') {
    process.stdout.write(encode({ id: request.id, ok: false, code: 'INVALID_IMAGE', message: 'fixture rejected the image' }, Buffer.alloc(0)))
  } else if (mode === 'foreign-code') {
    process.stdout.write(encode({ id: request.id, ok: false, code: 'NOT_AN_ATTACHMENT_CODE', message: 'fixture failed with a foreign code' }, Buffer.alloc(0)))
  } else if (mode === 'plain-failure') {
    process.stdout.write(encode({ id: request.id, ok: false, message: 'fixture failed without a code' }, Buffer.alloc(0)))
  } else if (mode === 'crash') {
    process.exit(7)
  } else if (mode === 'garbage') {
    process.stdout.write(Buffer.from('this is not a frame'))
  } else if (mode === 'unreadable-reply') {
    process.stdout.write(encode({ id: 'not-a-number', ok: true }, Buffer.alloc(0)))
  } else if (mode === 'probe-reply') {
    process.stdout.write(encode({ id: request.id, ok: true, result: { op: 'probeImage', detected } }, Buffer.alloc(0)))
  } else if (mode === 'empty-failure') {
    process.stdout.write(encode({ id: request.id, ok: false }, Buffer.alloc(0)))
  } else if (mode === 'no-result') {
    process.stdout.write(encode({ id: request.id, ok: true }, Buffer.alloc(0)))
  } else if (mode === 'wrong-op') {
    process.stdout.write(encode({ id: request.id, ok: true, result: { op: 'normalizeImage', mediaType: 'image/png', width: 1, height: 1 } }, Buffer.alloc(0)))
  } else if (mode === 'misidentified') {
    process.stdout.write(encode({ id: request.id + 1_000, ok: true, result: { op: request.op, detected } }, Buffer.alloc(0)))
    process.stdout.write(encode({ id: request.id, ok: true, result: { op: request.op, detected } }, Buffer.alloc(0)))
  }
}

/**
 * Serve fixture replies until the input ends.
 * @param mode - reply strategy name, matching this file's sibling entries.
 * @returns completion once the input stream closes.
 */
export async function main(mode = 'ok') {
  let pending = Buffer.alloc(0)
  if (mode === 'diagnostic') process.stderr.write('fixture diagnostic line\n')
  process.stdin.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      if (pending.length < 8) return
      const jsonLength = pending.readUInt32BE(0)
      if (pending.length < 8 + jsonLength) return
      const json = pending.subarray(4, 4 + jsonLength)
      const binaryLength = pending.readUInt32BE(4 + jsonLength)
      if (pending.length < 8 + jsonLength + binaryLength) return
      const binary = pending.subarray(8 + jsonLength, 8 + jsonLength + binaryLength)
      pending = pending.subarray(8 + jsonLength + binaryLength)
      reply(JSON.parse(json.toString('utf8')), binary, mode)
    }
  })
  await new Promise((resolve) => { process.stdin.on('end', resolve) })
  // An ignored channel keeps the process alive so disposal must kill it.
  if (mode === 'ignore') setInterval(() => {}, 1_000)
}

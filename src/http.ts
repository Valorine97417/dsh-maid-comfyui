/**
 * Small HTTP helpers for the dsh-maid-comfyui routes, mirroring the shapes the
 * dshmarket bundle uses for its own same-origin API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Send a JSON response with no-store caching. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Thrown when a request body grows past the caller's byte cap. Routes catch
 * it to answer their usual size error without having buffered the body whole. */
export class PayloadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`)
    this.name = 'PayloadTooLargeError'
  }
}

/** Buffer a request body in memory, aborting as soon as it grows past
 * `maxBytes` (undefined = unbounded, for callers without a cap). Without the
 * mid-read cap, a route that checks MAX_*_BYTES after reading can be made to
 * buffer an unbounded body first — memory dies before the check ever runs. */
async function collectBody(request: IncomingMessage, maxBytes: number | undefined): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const piece = chunk as Buffer
    total += piece.length
    if (maxBytes !== undefined && total > maxBytes) {
      // Cut the connection too: the client is already misbehaving, and
      // draining the rest of the stream would keep the transfer alive for
      // nothing.
      request.destroy()
      throw new PayloadTooLargeError(maxBytes)
    }
    chunks.push(piece)
  }
  return Buffer.concat(chunks)
}

/** Read and parse a JSON request body; undefined when the body is empty. */
export async function readJsonBody(request: IncomingMessage, maxBytes?: number): Promise<unknown> {
  const text = (await collectBody(request, maxBytes)).toString('utf8')
  if (text === '') return undefined
  return JSON.parse(text) as unknown
}

/** Read a raw (possibly binary) request body, e.g. for multipart forwarding. */
export async function readRawBody(request: IncomingMessage, maxBytes?: number): Promise<Buffer> {
  return collectBody(request, maxBytes)
}

/** Whether a request originates from the page that served it (Origin vs Host). */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined) return true
  if (host === undefined) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

/** Human-readable error message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

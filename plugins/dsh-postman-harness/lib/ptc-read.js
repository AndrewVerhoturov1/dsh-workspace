// Internal Postman PTC reads still dispatch as ordinary read through ToolRuntime.
// After the ordinary body succeeds, this exact Host-correlated call streams
// provider text independently of the display window. No direct Node filesystem access or cache.
// Preserve readAllText's line-text contract and byte budget, including exact
// bounds on CRLF/trailing-newline files. Carry only the last code point.
async function* lineTextChunks(chunks) {
  let tail = ''
  for await (const chunk of chunks) {
    const text = (tail + chunk).replace(/\r\n/g, '\n')
    let end = Math.max(0, text.length - 1)
    if (end > 0 && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff &&
        text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
    tail = text.slice(end)
    if (end) yield text.slice(0, end)
  }
  if (tail && tail !== '\n' && tail !== '\r') yield tail
}

export async function readPtcTextPage(ctx, exec, request) {
  const signal = AbortSignal.any([exec.signal, request.signal])
  signal.throwIfAborted()
  const target = await ctx.fs.resolve(exec.arguments.file_path, { cwd: exec.agent.session.header.cwd, signal })
  const info = await ctx.fs.stat(target, signal)
  if (!info) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new Error('PTC full read: file not found')
  }
  if (info.type !== 'file') throw new Error('PTC full read: not a regular file')
  const chunks = await ctx.fs.streamText(target, signal)
  // Worst-case JSON escaping is six bytes per UTF-16 code unit. Reserve space
  // for the reply envelope; this is a transport window, not a larger limit.
  const maxChars = Math.max(1, Math.floor((request.maxMessageBytes - 2048) / 6))
  let position = 0, totalBytes = 0, text = '', newlines = 0, ended = false
  for await (const chunk of lineTextChunks(chunks)) {
    signal.throwIfAborted()
    totalBytes += Buffer.byteLength(chunk, 'utf8')
    if (totalBytes > request.maxBytes) throw new Error('ptc.readAllText max_bytes exceeded; text is incomplete')
    if (!ended && position + chunk.length > request.textOffset) {
      const start = Math.max(0, request.textOffset - position)
      let end = Math.min(chunk.length, start + maxChars - text.length)
      for (let i = start; i < end; i++) if (chunk[i] === '\n' && ++newlines >= exec.arguments.limit) { end = i + 1; break }
      text += chunk.slice(start, end)
      ended = text.length >= maxChars || newlines >= exec.arguments.limit
    }
    position += chunk.length
  }
  signal.throwIfAborted()
  if (request.textOffset > position || (!text.length && request.textOffset < position))
    throw new Error('PTC full read made no progress; text is incomplete')
  const after = await ctx.fs.stat(target, signal)
  if (!after || after.version !== info.version) throw new Error('PTC full read changed during streaming; text is incomplete')
  const page = { version: info.version, text, nextOffset: request.textOffset + text.length, eof: request.textOffset + text.length === position,
    totalChars: position, totalBytes, nextLine: exec.arguments.offset + newlines }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return page
}

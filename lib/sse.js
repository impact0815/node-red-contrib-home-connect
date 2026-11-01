'use strict';

function parseSSEBlock(block) {
  const message = { event: 'message', data: '', id: undefined, retry: undefined, comment: undefined };
  const comments = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(':')) { comments.push(line.slice(1).trim()); continue; }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') message.event = value;
    if (field === 'data') message.data += `${value}\n`;
    if (field === 'id') message.id = value;
    if (field === 'retry' && /^\d+$/.test(value)) message.retry = Number(value);
  }
  if (message.data.endsWith('\n')) message.data = message.data.slice(0, -1);
  if (comments.length) message.comment = comments.join('\n');
  if (comments.length && message.event === 'message' && !message.data) message.event = 'KEEP-ALIVE';
  return message;
}

async function* streamChunks(body) {
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const chunk of body) yield chunk;
}

async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of streamChunks(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, boundary);
      const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      buffer = buffer.slice(boundary + match[0].length);
      if (block.trim()) yield parseSSEBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield parseSSEBlock(buffer);
}

module.exports = { parseSSE, parseSSEBlock };

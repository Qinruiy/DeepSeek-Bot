// Gmail tools on the Gmail REST API. The hosted Gmail MCP server is limited to the
// Workspace Developer Preview Program, so a personal @gmail.com account cannot use it.
// These tools cover the same actions as that server: search and read, labels, and
// drafts. They do not send mail. The access token comes from the Gmail connector.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const BODY_MAX = 3_000
const THREAD_MESSAGES = 8
const PAGE_MAX = 10
const SYSTEM_LABELS = new Set([
  'INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
])

const clip = (value, max = BODY_MAX) => {
  const text = String(value ?? '').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(truncated)`
}

const limit = (value, fallback) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return fallback
  return Math.min(number, PAGE_MAX)
}

const asList = value => {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}

function header(payload, name) {
  const found = payload?.headers?.find(item => item.name?.toLowerCase() === name.toLowerCase())
  return found?.value ?? ''
}

function decode(body) {
  if (typeof body?.data !== 'string' || body.data === '') return ''
  return Buffer.from(body.data, 'base64url').toString('utf8')
}

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function plainText(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body)
  const parts = Array.isArray(payload.parts) ? payload.parts : []
  const plain = parts.find(part => part.mimeType === 'text/plain')
  if (plain) return plainText(plain)
  const html = parts.find(part => part.mimeType === 'text/html')
  if (html) return stripHtml(plainText(html))
  if (parts.length > 0) return parts.map(plainText).filter(Boolean).join('\n')
  if (payload.mimeType === 'text/html') return stripHtml(decode(payload.body))
  return decode(payload.body)
}

function encodeHeader(value) {
  const text = String(value ?? '')
  if (/^[\t\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function draftRaw({ to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = []
  if (to) lines.push(`To: ${encodeHeader(to)}`)
  if (cc) lines.push(`Cc: ${encodeHeader(cc)}`)
  if (bcc) lines.push(`Bcc: ${encodeHeader(bcc)}`)
  lines.push(`Subject: ${encodeHeader(subject ?? '')}`)
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('Content-Transfer-Encoding: 8bit')
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  if (references) lines.push(`References: ${references}`)
  lines.push('', String(body ?? ''))
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

function messageLine(message, withBody) {
  const payload = message.payload ?? {}
  const lines = [
    `message ${message.id} in thread ${message.threadId}`,
    `From: ${header(payload, 'From')}`,
    `To: ${header(payload, 'To')}`,
    `Date: ${header(payload, 'Date')}`,
    `Subject: ${header(payload, 'Subject')}`,
    message.labelIds?.length ? `Labels: ${message.labelIds.join(', ')}` : '',
  ].filter(Boolean)
  if (withBody) lines.push('', clip(plainText(payload) || message.snippet || '(no body)'))
  else if (message.snippet) lines.push(clip(message.snippet, 240))
  return lines.join('\n')
}

export function install(rt) {
  if (rt.config?.gmail === false) return
  const { ctx } = rt
  const call = (method, path, options) => rt.gmailRequest(method, path, options)
  const run = async (fn) => {
    try { return await fn() } catch (error) { return error?.message || 'Gmail request failed' }
  }

  async function labelIds(values) {
    const names = asList(values)
    if (names.length === 0) throw new Error('Name at least one label.')
    if (names.every(name => SYSTEM_LABELS.has(name) || name.startsWith('Label_'))) return names
    const listed = await call('GET', '/labels')
    const labels = Array.isArray(listed.labels) ? listed.labels : []
    const byId = new Map(labels.map(label => [label.id, label.id]))
    const byName = new Map(labels.map(label => [String(label.name).toLowerCase(), label.id]))
    return names.map(name => {
      const id = byId.get(name) ?? byName.get(name.toLowerCase())
      if (id === undefined) throw new Error(`No label named ${name}. Call gmail_list_labels.`)
      return id
    })
  }

  ctx.tools.register(defineTool({
    name: 'gmail_search_threads',
    description: 'Search the connected Gmail account. query uses Gmail search syntax, for example from:ada@example.com newer_than:7d. Returns thread ids, subjects, and snippets. Does not send mail.',
    parameters: {
      query: { type: 'string', required: true, description: 'Gmail search query' },
      max_results: { type: 'number', description: 'How many threads to return, from 1 to 10. Default 8.' },
      page_token: { type: 'string', description: 'Page token from an earlier result' },
    },
    output,
    execute: ({ query, max_results, page_token }) => run(async () => {
      const q = String(query ?? '').trim()
      if (q === '') return 'Give a Gmail search query.'
      const page = await call('GET', '/threads', { query: { q, maxResults: limit(max_results, 8), pageToken: page_token } })
      const threads = Array.isArray(page.threads) ? page.threads : []
      if (threads.length === 0) return 'No threads matched.'
      const lines = []
      for (const thread of threads) {
        const full = await call('GET', `/threads/${encodeURIComponent(thread.id)}`, {
          query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] },
        })
        const latest = full.messages?.at(-1)
        lines.push([
          `thread ${thread.id}`,
          latest ? `From: ${header(latest.payload, 'From')}` : '',
          latest ? `Date: ${header(latest.payload, 'Date')}` : '',
          latest ? `Subject: ${header(latest.payload, 'Subject')}` : '',
          thread.snippet ? clip(thread.snippet, 240) : '',
        ].filter(Boolean).join('\n'))
      }
      if (page.nextPageToken) lines.push(`next page: ${page.nextPageToken}`)
      return lines.join('\n\n')
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'gmail_get_thread',
    description: 'Read one Gmail thread by id from gmail_search_threads. Bodies are shortened. Does not send mail.',
    parameters: { thread_id: { type: 'string', required: true, description: 'Thread id' } },
    output,
    execute: ({ thread_id }) => run(async () => {
      const id = String(thread_id ?? '').trim()
      if (id === '') return 'Give a thread id.'
      const thread = await call('GET', `/threads/${encodeURIComponent(id)}`, { query: { format: 'full' } })
      const messages = Array.isArray(thread.messages) ? thread.messages : []
      if (messages.length === 0) return `Thread ${id} is empty.`
      const shown = messages.slice(-THREAD_MESSAGES)
      const note = messages.length > shown.length ? `${messages.length - shown.length} earlier messages omitted.\n\n` : ''
      return note + shown.map(message => messageLine(message, true)).join('\n\n')
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'gmail_get_message',
    description: 'Read one Gmail message by id. The body is shortened. Does not send mail.',
    parameters: { message_id: { type: 'string', required: true, description: 'Message id' } },
    output,
    execute: ({ message_id }) => run(async () => {
      const id = String(message_id ?? '').trim()
      if (id === '') return 'Give a message id.'
      const message = await call('GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } })
      return messageLine(message, true)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'gmail_list_labels',
    description: 'List labels on the connected Gmail account. Label and unlabel tools take the id. System labels such as INBOX, STARRED, UNREAD, IMPORTANT, TRASH, and SPAM can be used by those ids.',
    parameters: {},
    output,
    execute: () => run(async () => {
      const listed = await call('GET', '/labels')
      const labels = Array.isArray(listed.labels) ? listed.labels : []
      if (labels.length === 0) return 'No labels.'
      return labels.map(label => `- ${label.id} — ${label.name}${label.type ? ` (${label.type})` : ''}`).join('\n')
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'gmail_list_drafts',
    description: 'List drafts in the connected Gmail account. Does not send them.',
    parameters: {
      query: { type: 'string', description: 'Optional Gmail search query' },
      max_results: { type: 'number', description: 'How many drafts to return, from 1 to 10. Default 8.' },
      page_token: { type: 'string', description: 'Page token from an earlier result' },
    },
    output,
    execute: ({ query, max_results, page_token }) => run(async () => {
      const page = await call('GET', '/drafts', { query: { q: query, maxResults: limit(max_results, 8), pageToken: page_token } })
      const drafts = Array.isArray(page.drafts) ? page.drafts : []
      if (drafts.length === 0) return 'No drafts.'
      const lines = []
      for (const draft of drafts) {
        const full = await call('GET', `/drafts/${encodeURIComponent(draft.id)}`, { query: { format: 'metadata' } })
        const message = full.message ?? {}
        lines.push([
          `draft ${draft.id}`,
          `message ${message.id ?? ''} in thread ${message.threadId ?? ''}`,
          `To: ${header(message.payload, 'To')}`,
          `Subject: ${header(message.payload, 'Subject')}`,
        ].join('\n'))
      }
      if (page.nextPageToken) lines.push(`next page: ${page.nextPageToken}`)
      return lines.join('\n\n')
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'gmail_create_draft',
    description: 'Create a draft in the connected Gmail account. The draft is not sent. To reply in an existing thread, pass thread_id.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient address' },
      subject: { type: 'string', required: true, description: 'Subject line' },
      body: { type: 'string', required: true, description: 'Plain-text body' },
      cc: { type: 'string', description: 'Cc addresses' },
      bcc: { type: 'string', description: 'Bcc addresses' },
      thread_id: { type: 'string', description: 'Thread id when this draft is a reply' },
      in_reply_to: { type: 'string', description: 'Message-ID header of the message being answered' },
    },
    output,
    execute: (args) => run(async () => {
      const to = String(args.to ?? '').trim()
      const subject = String(args.subject ?? '').trim()
      const body = String(args.body ?? '')
      if (to === '' || subject === '' || body.trim() === '') return 'A draft needs a recipient, a subject, and a body.'
      const threadId = String(args.thread_id ?? '').trim()
      const raw = draftRaw({
        to, cc: args.cc, bcc: args.bcc, subject, body,
        inReplyTo: args.in_reply_to,
        references: args.in_reply_to,
      })
      const draft = await call('POST', '/drafts', { body: { message: { raw, ...(threadId ? { threadId } : {}) } } })
      return `Draft ${draft.id} saved${threadId ? ` on thread ${threadId}` : ''}. It is not sent. Send it from Gmail.`
    }),
  }))

  const labelTool = (name, description, field) => defineTool({
    name,
    description,
    parameters: {
      [field]: { type: 'string', required: true, description: field === 'message_id' ? 'Message id' : 'Thread id' },
      labels: { type: 'array', items: { type: 'string' }, required: true, description: 'Label ids from gmail_list_labels, or system ids such as INBOX and STARRED. Names work too.' },
    },
    output,
    execute: (args) => run(async () => {
      const id = String(args[field] ?? '').trim()
      if (id === '') return field === 'message_id' ? 'Give a message id.' : 'Give a thread id.'
      const ids = await labelIds(args.labels)
      const path = field === 'message_id' ? `/messages/${encodeURIComponent(id)}/modify` : `/threads/${encodeURIComponent(id)}/modify`
      const add = name.startsWith('gmail_label')
      const updated = await call('POST', path, { body: add ? { addLabelIds: ids } : { removeLabelIds: ids } })
      const applied = updated.labelIds ?? updated.messages?.at(-1)?.labelIds
      return `${add ? 'Added' : 'Removed'} ${ids.join(', ')} on ${id}.${applied ? ` Labels now: ${applied.join(', ')}.` : ''}`
    }),
  })

  ctx.tools.register(labelTool('gmail_label_message', 'Add labels to one Gmail message. Does not send mail.', 'message_id'))
  ctx.tools.register(labelTool('gmail_unlabel_message', 'Remove labels from one Gmail message. Does not send mail.', 'message_id'))
  ctx.tools.register(labelTool('gmail_label_thread', 'Add labels to one Gmail thread. Does not send mail.', 'thread_id'))
  ctx.tools.register(labelTool('gmail_unlabel_thread', 'Remove labels from one Gmail thread. Does not send mail.', 'thread_id'))
}

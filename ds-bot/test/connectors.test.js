import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { GMAIL_OAUTH_PORT, signIn, signInGmail } from '../src/host/connectors.js'
import { fakeContext } from './fake-ctx.js'

const fresh = () => `ghp_${randomBytes(16).toString('hex')}`
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

test('signIn asks GitHub who owns the token', async () => {
  const token = fresh()
  let seen
  const user = await signIn(token, { api: 'https://gh.test/', fetch: async (url, init) => { seen = { url, init }; return answer(200, { login: 'octo' }) } })
  assert.deepEqual(user, { login: 'octo' })
  assert.equal(seen.url, 'https://gh.test/user')
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`)
  await assert.rejects(signIn(token, { fetch: async () => answer(401, {}) }), /did not accept/)
  await assert.rejects(signIn(token, { fetch: async () => answer(500, {}) }), /GitHub answered 500/)
  await assert.rejects(signIn(token, { fetch: async () => { throw new Error(`boom ${token}`) } }), /^Error: Could not reach GitHub$/)
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const teamHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-connectors-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  return home
}

// A loader that hands out a fake MCP client and records each mount.
const githubOff = { id: 'github', name: 'GitHub', state: 'off', account: null }
const GMAIL_REDIRECT = `http://127.0.0.1:${GMAIL_OAUTH_PORT}/oauth/callback`
const gmailOff = { id: 'gmail', name: 'Gmail', state: 'off', account: null, redirectUri: GMAIL_REDIRECT }

function setup({ fail = false, github = { api: 'https://gh.test' }, gmail } = {}) {
  const home = teamHome()
  const mounts = []
  const plugin = { name: 'mcp-client', apply() {} }
  const loader = {
    import: async name => { assert.equal(name, '@deepseek-ai/dsh-mcp-client'); return { default: plugin } },
    unwrapExports: exports => exports.default,
  }
  const ctx = fakeContext({ services: { loader } })
  ctx.plugin = (given, config) => {
    assert.equal(given, plugin)
    const mount = { config, disposed: false }
    mounts.push(mount)
    return {
      await: async () => { if (fail) throw new Error(`refused ${config.headers.Authorization}`) },
      dispose: () => { mount.disposed = true },
    }
  }
  capture(ctx)
  apply(ctx, { home, github, ...(gmail !== undefined ? { gmail } : {}) })
  return { ctx, home, mounts }
}

function capture(ctx) {
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
}

// Calls the /api/bot route the way the client does.
async function call(ctx, endpoint, payload) {
  const response = await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}

test('connecting saves the token, kept out of every Bot shell, and mounts GitHub MCP; disconnecting undoes both', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const token = fresh()

  const before = await call(ctx, 'state', {})
  assert.deepEqual(before.value.connectors, [githubOff, gmailOff])

  const connected = await call(ctx, 'connector-connect', { id: 'github', token: ` ${token} ` })
  assert.equal(connected.ok, true, JSON.stringify(connected))
  assert.deepEqual(connected.value, [{ id: 'github', name: 'GitHub', state: 'ready', account: 'octo' }, gmailOff])
  assert.equal(mounts.length, 1)
  assert.deepEqual(mounts[0].config, {
    transport: 'streamable-http',
    serverName: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': 'context,repos,issues,pull_requests' },
    failOnStartupError: true,
  })
  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.secrets.map(secret => [secret.name, secret.scope]), [['GITHUB_TOKEN', []]])
  assert.ok(!JSON.stringify(state).includes(token))
  assert.ok(!readFileSync(join(home, 'state.json'), 'utf8').includes(token))

  const off = await call(ctx, 'connector-disconnect', { id: 'github' })
  assert.deepEqual(off.value, [githubOff, gmailOff])
  assert.equal(mounts[0].disposed, true)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a token GitHub refuses is not saved', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(401, {})
  const { ctx, home, mounts } = setup()
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const result = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /did not accept/)
  assert.equal(mounts.length, 0)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a failed MCP connection shows the error without the token, and Try again mounts again', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup({ fail: true })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const token = fresh()
  const result = await call(ctx, 'connector-connect', { id: 'github', token })
  const [github] = result.value
  assert.equal(github.state, 'error')
  assert.ok(!github.error.includes(token), github.error)
  assert.match(github.error, /\[secret:GITHUB_TOKEN\]/)
  await call(ctx, 'connector-retry', { id: 'github' })
  assert.equal(mounts.length, 2)
})

test('deleting GITHUB_TOKEN on the Secrets page unmounts GitHub', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = async () => answer(200, { login: 'octo' })
  const { ctx, home, mounts } = setup()
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  await call(ctx, 'secret-delete', { name: 'GITHUB_TOKEN' })
  const state = await call(ctx, 'state', {})
  assert.equal(mounts[0].disposed, true)
  assert.equal(state.value.connectors.find(connector => connector.id === 'github').state, 'off')
})

test('github: false hides GitHub and leaves Gmail', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  capture(ctx)
  apply(ctx, { home, github: false })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  assert.deepEqual((await call(ctx, 'state', {})).value.connectors, [gmailOff])
  const refused = await call(ctx, 'connector-oauth-start', { id: 'github', clientId: 'client', clientSecret: 'secret' })
  assert.equal(refused.ok, false)
})

test('gmail: false hides Gmail and leaves GitHub', async (t) => {
  const home = teamHome()
  const ctx = fakeContext()
  capture(ctx)
  apply(ctx, { home, gmail: false })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  assert.deepEqual((await call(ctx, 'state', {})).value.connectors, [githubOff])
  const refused = await call(ctx, 'connector-oauth-start', { id: 'gmail', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(refused.ok, false)
  assert.equal(ctx.registeredTools.has('gmail_search_threads'), false)
})

test('a GitHub address without https refuses to send the token', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let asked = false
  globalThis.fetch = async () => { asked = true; return answer(200, { login: 'octo' }) }
  const { ctx, home, mounts } = setup({ github: { url: 'http://mcp.test/', api: 'https://gh.test' } })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const refused = await call(ctx, 'connector-connect', { id: 'github', token: fresh() })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /https/)
  assert.equal(asked, false)
  assert.equal(mounts.length, 0)
})

const CLIENT_ID = '1234567890.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-client-secret-value'
const REFRESH = '1//gmail-refresh-token-value'
const ACCESS = 'ya29.access-token-value'

test('signInGmail exchanges the refresh token and reads the account email', async () => {
  const seen = []
  const request = async (url, init) => {
    seen.push({ url: String(url), init })
    if (String(url).endsWith('/token')) return answer(200, { access_token: ACCESS, expires_in: 3600 })
    return answer(200, { email: 'ada@example.com' })
  }
  const user = await signInGmail({ refreshToken: REFRESH, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenUrl: 'https://oauth.test/token/', userinfo: 'https://oauth.test/userinfo', fetch: request })
  assert.deepEqual(user, { login: 'ada@example.com', accessToken: ACCESS, expiresIn: 3600 })
  assert.equal(seen[0].url, 'https://oauth.test/token')
  assert.equal(seen[0].init.body.get('grant_type'), 'refresh_token')
  assert.equal(seen[0].init.body.get('refresh_token'), REFRESH)
  assert.equal(seen[0].init.body.get('client_id'), CLIENT_ID)
  assert.equal(seen[0].init.body.get('client_secret'), CLIENT_SECRET)
  assert.equal(seen[1].url, 'https://oauth.test/userinfo')
  assert.equal(seen[1].init.headers.Authorization, `Bearer ${ACCESS}`)
  await assert.rejects(signInGmail({ refreshToken: REFRESH, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: async () => answer(400, {}) }), /did not accept/)
  await assert.rejects(signInGmail({ refreshToken: REFRESH, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: async () => answer(500, {}) }), /Google answered 500/)
  await assert.rejects(signInGmail({ refreshToken: REFRESH, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: async () => answer(200, { access_token: '' }) }), /access token/)
  await assert.rejects(signInGmail({ refreshToken: REFRESH, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: async (url) => (String(url).includes('userinfo') ? answer(200, {}) : answer(200, { access_token: ACCESS, expires_in: 3600 })) }), /which account/)
  await assert.rejects(signInGmail({ refreshToken: REFRESH, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: async () => { throw new Error(`boom ${REFRESH}`) } }), /^Error: Could not reach Google$/)
})

// One code exchange, then one refresh while mounting. The access token changes each time.
function gmailFetch() {
  const seen = []
  let tokens = 0
  const request = async (url, init) => {
    const href = String(url)
    seen.push({ url: href, init })
    if (href.includes('/token')) {
      tokens += 1
      const payload = { access_token: `${ACCESS}-${tokens}`, expires_in: 3600 }
      if (init?.body?.get?.('grant_type') === 'authorization_code') payload.refresh_token = REFRESH
      return answer(200, payload)
    }
    return answer(200, { email: 'ada@example.com' })
  }
  return { seen, request }
}

const CODE = 'gmail-auth-code-value'

function useGmail(t, options = {}) {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  if (options.fetch !== undefined) globalThis.fetch = options.fetch
  const { ctx, home, mounts } = setup({ fail: options.fail, gmail: { oauthPort: 0, ...options.gmail } })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  return { ctx, home, mounts, realFetch }
}

async function startGmail(ctx, fields = {}) {
  return call(ctx, 'connector-oauth-start', {
    id: 'gmail',
    clientId: fields.clientId ?? ` ${CLIENT_ID} `,
    clientSecret: fields.clientSecret ?? CLIENT_SECRET,
  })
}

async function callback(realFetch, started, { code = CODE, state, error } = {}) {
  const auth = new URL(started.value.authorizationUrl)
  const target = new URL(started.value.redirectUri)
  if (error) target.searchParams.set('error', error)
  else {
    target.searchParams.set('code', code)
    target.searchParams.set('state', state ?? auth.searchParams.get('state'))
  }
  const response = await realFetch(target)
  return { response, html: await response.text(), auth }
}

test('signing in to Gmail in the browser saves the refresh token and client secret out of every Bot shell, and mounts with an access token', async (t) => {
  const { seen, request } = gmailFetch()
  const { ctx, home, mounts, realFetch } = useGmail(t, { fetch: request })

  const started = await startGmail(ctx)
  assert.equal(started.ok, true, JSON.stringify(started))
  const auth = new URL(started.value.authorizationUrl)
  assert.equal(`${auth.origin}${auth.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(auth.searchParams.get('response_type'), 'code')
  assert.equal(auth.searchParams.get('access_type'), 'offline')
  assert.equal(auth.searchParams.get('prompt'), 'consent')
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(auth.searchParams.get('redirect_uri'), started.value.redirectUri)
  assert.equal(auth.searchParams.get('client_id'), CLIENT_ID)
  const scope = auth.searchParams.get('scope')
  for (const name of ['gmail.readonly', 'gmail.compose', 'gmail.modify', 'userinfo.email']) assert.ok(scope.includes(name), scope)
  assert.equal(scope.includes('gmail.send'), false)

  const page = await callback(realFetch, started)
  assert.equal(page.response.status, 200)
  assert.match(page.html, /close this tab/)
  for (const secret of [CODE, CLIENT_SECRET, REFRESH]) assert.ok(!page.html.includes(secret), secret)

  const codeCall = seen.find(entry => entry.init?.body?.get?.('grant_type') === 'authorization_code')
  const verifier = codeCall.init.body.get('code_verifier')
  assert.equal(codeCall.init.body.get('code'), CODE)
  assert.equal(codeCall.init.body.get('redirect_uri'), started.value.redirectUri)
  assert.equal(codeCall.init.body.get('client_id'), CLIENT_ID)
  assert.equal(codeCall.init.body.get('client_secret'), CLIENT_SECRET)
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), auth.searchParams.get('code_challenge'))
  assert.equal(seen.find(entry => entry.url.includes('userinfo')).init.headers.Authorization, `Bearer ${ACCESS}-1`)

  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.connectors.find(connector => connector.id === 'gmail'), {
    id: 'gmail', name: 'Gmail', state: 'ready', account: 'ada@example.com', clientId: CLIENT_ID, clientSecretSaved: true, signInSaved: true, redirectUri: started.value.redirectUri,
  })
  assert.equal(mounts.length, 0)
  assert.equal(seen.filter(entry => entry.url.includes('/token')).length, 2)
  assert.equal(seen.filter(entry => entry.url.includes('userinfo')).length, 1)
  assert.deepEqual(state.value.secrets.map(secret => [secret.name, secret.scope]), [['GMAIL_CLIENT_SECRET', []], ['GMAIL_REFRESH_TOKEN', []]])
  const saved = readFileSync(join(home, 'state.json'), 'utf8')
  assert.ok(saved.includes('ada@example.com'))
  assert.ok(saved.includes(CLIENT_ID))
  for (const secret of [REFRESH, CLIENT_SECRET, CODE, `${ACCESS}-1`, `${ACCESS}-2`]) assert.ok(!saved.includes(secret), secret)
  assert.ok(!JSON.stringify(state).includes(REFRESH))
  assert.ok(!JSON.stringify(state).includes(CLIENT_SECRET))
  assert.ok(!JSON.stringify(state).includes(CODE))

  const again = await callback(realFetch, started)
  assert.equal(again.response.status, 400)
  assert.equal(mounts.length, 0)

  const off = await call(ctx, 'connector-disconnect', { id: 'gmail' })
  assert.equal(off.value.find(connector => connector.id === 'gmail').state, 'off')
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('a sign-in Google refuses is not saved', async (t) => {
  const { ctx, mounts, realFetch } = useGmail(t, { fetch: async () => answer(400, { error: 'invalid_grant' }) })
  const started = await startGmail(ctx)
  const page = await callback(realFetch, started)
  assert.equal(page.response.status, 400)
  assert.match(page.html, /did not accept/)
  assert.ok(!page.html.includes(CODE))
  assert.ok(!page.html.includes(CLIENT_SECRET))
  assert.equal(mounts.length, 0)
  const state = await call(ctx, 'state', {})
  assert.deepEqual(state.value.secrets, [])
  assert.match(state.value.connectors.find(connector => connector.id === 'gmail').oauthNote, /did not accept/)
})

test('a Gmail callback with the wrong state does not use up the sign-in', async (t) => {
  const { seen, request } = gmailFetch()
  const { ctx, mounts, realFetch } = useGmail(t, { fetch: request })
  const started = await startGmail(ctx)
  const wrong = await callback(realFetch, started, { state: 'not-the-state' })
  assert.equal(wrong.response.status, 400)
  assert.match(wrong.html, /does not match/)
  assert.equal(mounts.length, 0)
  assert.equal(seen.length, 0)
  const page = await callback(realFetch, started)
  assert.equal(page.response.status, 200)
  assert.equal((await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'gmail').account, 'ada@example.com')
})

test('cancelling the Gmail sign-in rejects the callback', async (t) => {
  const { ctx, mounts, realFetch } = useGmail(t, { fetch: async () => answer(200, {}) })
  const started = await startGmail(ctx)
  const cancelled = await call(ctx, 'connector-oauth-cancel', { id: 'gmail' })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  const page = await callback(realFetch, started)
  assert.equal(page.response.status, 400)
  assert.match(page.html, /expired/)
  assert.equal(mounts.length, 0)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('starting Gmail sign-in again invalidates the first callback', async (t) => {
  const { request } = gmailFetch()
  const { ctx, mounts, realFetch } = useGmail(t, { fetch: request })
  const first = await startGmail(ctx)
  const second = await startGmail(ctx)
  const stale = await callback(realFetch, first)
  assert.equal(stale.response.status, 400)
  assert.match(stale.html, /does not match/)
  const page = await callback(realFetch, second)
  assert.equal(page.response.status, 200)
  assert.equal(mounts.length, 0)
  assert.equal((await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'gmail').state, 'ready')
})

test('Gmail does not take a pasted refresh token', async (t) => {
  const { ctx, mounts } = useGmail(t, { fetch: async () => { throw new Error('should not fetch') } })
  const result = await call(ctx, 'connector-connect', { id: 'gmail', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, token: REFRESH })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /browser/)
  assert.equal(mounts.length, 0)
})

test('Gmail tools call the Gmail API and do not send mail', async (t) => {
  const plain = Buffer.from('Hello from Ada', 'utf8').toString('base64url')
  const message = {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Ada <ada@example.com>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Date', value: 'Mon, 1 Jan 2026' },
        { name: 'Subject', value: 'Plan' },
      ],
      body: { data: plain },
    },
  }
  const { request } = gmailFetch()
  const calls = []
  const fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('gmail.googleapis.com')) {
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ href, method: init?.method ?? 'GET', authorization: init.headers.Authorization, body })
      if (href.endsWith('/labels')) return answer(200, { labels: [{ id: 'Label_1', name: 'Work', type: 'user' }] })
      if (href.includes('/threads/t1/modify')) return answer(200, { id: 't1', messages: [{ ...message, labelIds: body.removeLabelIds ? [] : body.addLabelIds }] })
      if (href.includes('/threads/t1')) return answer(200, { id: 't1', messages: [message] })
      if (href.includes('/threads?') || href.endsWith('/threads')) return answer(200, { threads: [{ id: 't1', snippet: 'the plan' }], nextPageToken: 'next' })
      if (href.endsWith('/drafts') && init?.method === 'POST') return answer(200, { id: 'd1', message: { id: 'md1', threadId: body.message.threadId } })
      if (href.includes('/messages/m1/modify')) return answer(200, { id: 'm1', labelIds: body.addLabelIds })
      if (href.includes('/messages/m1')) return answer(200, message)
      return answer(404, {})
    }
    return request(url, init)
  }
  const { ctx, realFetch } = useGmail(t, { fetch })
  const tool = (name, args) => ctx.registeredTools.get(name).execute(args, { agent: { id: 'm1' } })
  assert.match(await tool('gmail_list_labels', {}), /Connect Gmail/)

  const started = await startGmail(ctx)
  assert.equal((await callback(realFetch, started)).response.status, 200)

  const labels = await tool('gmail_list_labels', {})
  assert.match(labels, /Label_1 — Work/)
  assert.equal(calls[0].authorization, `Bearer ${ACCESS}-2`)
  assert.equal(calls[0].href.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/labels'), true)

  const found = await tool('gmail_search_threads', { query: 'from:ada@example.com' })
  assert.match(found, /thread t1/)
  assert.match(found, /Subject: Plan/)
  assert.match(found, /next page: next/)
  const thread = await tool('gmail_get_thread', { thread_id: 't1' })
  assert.match(thread, /Hello from Ada/)
  const one = await tool('gmail_get_message', { message_id: 'm1' })
  assert.match(one, /message m1/)

  const draft = await tool('gmail_create_draft', { to: 'ada@example.com', subject: 'Hello', body: 'Not sent', thread_id: 't1' })
  assert.match(draft, /Draft d1 saved/)
  assert.match(draft, /not sent/)
  const posted = calls.find(entry => entry.method === 'POST' && entry.href.endsWith('/drafts'))
  const mime = Buffer.from(posted.body.message.raw, 'base64url').toString('utf8')
  assert.match(mime, /To: ada@example.com/)
  assert.match(mime, /Subject: Hello/)
  assert.match(mime, /Not sent/)
  assert.equal(posted.body.message.threadId, 't1')
  assert.equal(calls.some(entry => entry.href.includes('/send')), false)

  const labeled = await tool('gmail_label_message', { message_id: 'm1', labels: ['Work'] })
  assert.match(labeled, /Label_1/)
  const added = calls.find(entry => entry.href.includes('/messages/m1/modify'))
  assert.deepEqual(added.body.addLabelIds, ['Label_1'])
  const unlabeled = await tool('gmail_unlabel_thread', { thread_id: 't1', labels: ['INBOX'] })
  assert.match(unlabeled, /Removed INBOX/)

  await call(ctx, 'connector-disconnect', { id: 'gmail' })
  assert.match(await tool('gmail_list_labels', {}), /Connect Gmail/)
})

test('a Gmail refresh Google refuses is an error without the secrets', async (t) => {
  const fetch = async (url, init) => {
    if (String(url).includes('/token')) {
      if (init?.body?.get?.('grant_type') === 'authorization_code') return answer(200, { access_token: `${ACCESS}-1`, refresh_token: REFRESH, expires_in: 3600 })
      return answer(400, { error: 'invalid_grant' })
    }
    return answer(200, { email: 'ada@example.com' })
  }
  const { ctx, mounts, realFetch } = useGmail(t, { fetch })
  const started = await startGmail(ctx)
  assert.equal((await callback(realFetch, started)).response.status, 200)
  const gmail = (await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'gmail')
  assert.equal(gmail.state, 'error')
  assert.equal(gmail.account, 'ada@example.com')
  assert.equal(gmail.clientId, CLIENT_ID)
  assert.equal(gmail.clientSecretSaved, true)
  assert.equal(gmail.signInSaved, true)
  assert.match(gmail.error, /did not accept/)
  for (const secret of [ACCESS, REFRESH, CODE, CLIENT_SECRET]) assert.equal(JSON.stringify(gmail).includes(secret), false, secret)
  await call(ctx, 'connector-retry', { id: 'gmail' })
  assert.equal(mounts.length, 0)
  assert.equal((await call(ctx, 'state', {})).value.connectors.find(connector => connector.id === 'gmail').state, 'error')
})

test('deleting GMAIL_REFRESH_TOKEN unmounts Gmail and leaves the client secret', async (t) => {
  const { ctx, mounts, realFetch } = useGmail(t, { fetch: gmailFetch().request })
  const started = await startGmail(ctx)
  assert.equal((await callback(realFetch, started)).response.status, 200)
  await call(ctx, 'secret-delete', { name: 'GMAIL_REFRESH_TOKEN' })
  const state = await call(ctx, 'state', {})
  assert.equal(mounts.length, 0)
  const gmail = state.value.connectors.find(connector => connector.id === 'gmail')
  assert.equal(gmail.state, 'off')
  assert.equal(gmail.account, 'ada@example.com')
  assert.equal(gmail.clientId, CLIENT_ID)
  assert.equal(gmail.clientSecretSaved, true)
  assert.equal(gmail.signInSaved, undefined)
  assert.deepEqual(state.value.secrets.map(secret => secret.name), ['GMAIL_CLIENT_SECRET'])
  assert.equal(JSON.stringify(state).includes(CLIENT_SECRET), false)
})

test('a Gmail address without https refuses before the sign-in starts', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  let asked = false
  globalThis.fetch = async () => { asked = true; return answer(200, {}) }
  const { ctx, home, mounts } = setup({ gmail: { api: 'http://gmail.test' } })
  t.after(() => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const refused = await call(ctx, 'connector-oauth-start', { id: 'gmail', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /https/)
  assert.equal(asked, false)
  assert.equal(mounts.length, 0)
  assert.deepEqual((await call(ctx, 'state', {})).value.secrets, [])
})

test('closing DS Bot stops the Gmail sign-in page', async (t) => {
  const { ctx, realFetch } = useGmail(t, { fetch: async () => answer(200, {}) })
  const started = await startGmail(ctx)
  assert.equal(started.ok, true, JSON.stringify(started))
  ctx.dispose()
  let closed = false
  for (let i = 0; i < 20 && !closed; i++) {
    try { await realFetch(started.value.redirectUri) } catch { closed = true }
    if (!closed) await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(closed, true)
})

test('Gmail mounts again before the access token expires', async (t) => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  t.after(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  })
  const marker = Symbol('gmail-refresh')
  let scheduled
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 3_540_000) {
      scheduled = { fn, args }
      return { [marker]: true, unref() {}, ref() {} }
    }
    return realSetTimeout(fn, ms, ...args)
  }
  globalThis.clearTimeout = (handle) => {
    if (handle?.[marker]) { scheduled = undefined; return }
    return realClearTimeout(handle)
  }
  const { seen, request } = gmailFetch()
  const { ctx, mounts, realFetch } = useGmail(t, { fetch: request })
  const started = await startGmail(ctx)
  const page = await callback(realFetch, started)
  assert.equal(page.response.status, 200)
  assert.equal(mounts.length, 0)
  assert.equal(seen.filter(entry => entry.url.includes('/token')).length, 2)
  assert.equal(typeof scheduled?.fn, 'function')
  scheduled.fn(...scheduled.args)
  for (let i = 0; i < 30 && seen.filter(entry => entry.url.includes('/token')).length < 3; i++) await new Promise(resolve => realSetTimeout(resolve, 0))
  assert.equal(seen.filter(entry => entry.url.includes('/token')).length, 3)
  const labels = await ctx.registeredTools.get('gmail_list_labels').execute({}, { agent: { id: 'm1' } })
  assert.match(labels, /No labels/)
  const api = seen.filter(entry => entry.url.includes('gmail.googleapis.com'))
  assert.equal(api.at(-1).init.headers.Authorization, `Bearer ${ACCESS}-3`)
})

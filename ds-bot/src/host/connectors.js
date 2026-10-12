// Connectors: outside services every Bot can use. GitHub tools come from GitHub's MCP
// server through DSH's own MCP client, mounted on the plugin context, so every Bot and
// Session gets them as mcp__github__<tool>. Gmail calls the Gmail REST API directly.
// The hosted Gmail MCP server is in the Workspace Developer Preview Program, which does
// not cover a personal @gmail.com account.
//
// GitHub keeps a personal access token as GITHUB_TOKEN. Gmail keeps a refresh token and
// an OAuth client secret (GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_SECRET); the client id sits
// in the team state, which is not a secret. The user signs in in the browser. Google
// redirects to a page on 127.0.0.1, and the refresh token is saved there — it is never
// pasted. The short-lived access token is exchanged here, held in memory, and renewed
// before it expires. Nothing here is written to the DSH profile. A new secret is shared
// with no Bot's shell: the tools do not need it there. The Secrets page can still share it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

export const GITHUB = 'github'
export const GITHUB_SECRET = 'GITHUB_TOKEN'
export const GMAIL = 'gmail'
export const GMAIL_REFRESH = 'GMAIL_REFRESH_TOKEN'
export const GMAIL_CLIENT_SECRET = 'GMAIL_CLIENT_SECRET'
// The redirect has to be a fixed loopback address: Google checks it against the
// OAuth client the user registered. Port 0 is only for tests.
export const GMAIL_OAUTH_PORT = 47321
const OAUTH_PATH = '/oauth/callback'
const OAUTH_TTL_MS = 10 * 60 * 1000
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const GITHUB_DEFAULTS = {
  url: 'https://api.githubcopilot.com/mcp/',
  api: 'https://api.github.com',
  toolsets: 'context,repos,issues,pull_requests',
}
const GMAIL_DEFAULTS = {
  api: 'https://gmail.googleapis.com',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  oauthPort: GMAIL_OAUTH_PORT,
}
// Label tools need gmail.modify. Nothing here sends mail.
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')
const CHECK_TIMEOUT_MS = 15_000
const REFRESH_SKEW_S = 60
const REFRESH_MIN_S = 5
const HTTPS = /^https:\/\//i
const GITHUB_INSECURE = 'GitHub addresses must start with https://'
const GMAIL_INSECURE = 'Gmail addresses must start with https://'
const ACCESS_LABEL = '[secret:GMAIL_ACCESS_TOKEN]'
const SIGN_IN_CANCELLED = 'Google sign-in was cancelled'
const GMAIL_OFF = 'Connect Gmail in Settings → Connectors first.'

const trimSlash = value => String(value).replace(/\/$/, '')
const text = value => (typeof value === 'string' ? value.trim() : '')
const httpsError = (addresses, message) => (addresses.some(address => !HTTPS.test(String(address))) ? message : null)

function listenPort(value) {
  const port = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined
  return port
}

function sameText(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

// The callback is a browser tab, outside the plugin's locale service.
function reply(res, status, lines) {
  if (res.writableEnded || res.destroyed) return
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail</title></head><body>${lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</body></html>`
  try {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html),
      'x-content-type-options': 'nosniff',
    })
    res.end(html)
  } catch { /* the browser went away */ }
}

// prompt=consent and access_type=offline are what make Google send a refresh token
// on a later sign-in, not only the first. PKCE because the redirect is a public client.
function authorizationUrl({ authUrl, clientId, redirect, state, challenge }) {
  const target = new URL(authUrl)
  target.searchParams.set('client_id', clientId)
  target.searchParams.set('redirect_uri', redirect)
  target.searchParams.set('response_type', 'code')
  target.searchParams.set('scope', GMAIL_SCOPES)
  target.searchParams.set('access_type', 'offline')
  target.searchParams.set('prompt', 'consent')
  target.searchParams.set('state', state)
  target.searchParams.set('code_challenge', challenge)
  target.searchParams.set('code_challenge_method', 'S256')
  return target.toString()
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

// node:test sets NODE_TEST_CONTEXT. Opening a browser from a test would leave the machine.
function openBrowser(url) {
  if (process.env.NODE_TEST_CONTEXT !== undefined || !HTTPS.test(url)) return
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/[&^]/g, '^$&')]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch { /* the Connectors page still has the link */ }
}

// Access tokens are not saved secrets, so redactSecrets cannot see them.
function rememberAccess(spec, token) {
  if (typeof token !== 'string' || token === '') return
  const list = spec.accessTokens ??= []
  const existing = list.indexOf(token)
  if (existing !== -1) list.splice(existing, 1)
  list.push(token)
  while (list.length > 4) list.shift()
}

// Asks GitHub who the token belongs to. Any token GitHub accepts passes.
export async function signIn(token, { api = GITHUB_DEFAULTS.api, fetch: request = fetch } = {}) {
  let response
  try {
    response = await request(`${trimSlash(api)}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ds-bot', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach GitHub')
  }
  if (response.status === 401) throw new Error('GitHub did not accept this token')
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const user = await response.json().catch(() => ({}))
  if (typeof user?.login !== 'string') throw new Error('GitHub did not say who this token belongs to')
  return { login: user.login }
}

// A refresh token is what the user keeps. Google's access token lasts about an
// hour and is sent only as the MCP Authorization header, never saved.
async function googleToken(body, tokenUrl, request, rejected) {
  let response
  try {
    response = await request(trimSlash(tokenUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Google')
  }
  const payload = await response.json().catch(() => ({}))
  if (response.status === 400 || response.status === 401) throw new Error(rejected)
  if (!response.ok) throw new Error(`Google answered ${response.status}`)
  if (typeof payload.access_token !== 'string' || payload.access_token === '') throw new Error('Google did not return an access token')
  const expiresIn = Number(payload.expires_in)
  return { payload, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600 }
}

async function googleAccess(refreshToken, clientId, clientSecret, tokenUrl, request) {
  const { payload, expiresIn } = await googleToken({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
  }, tokenUrl, request, 'Google did not accept this refresh token')
  return { accessToken: payload.access_token, expiresIn }
}

async function googleCode({ code, verifier, clientId, clientSecret, redirect, tokenUrl, request }) {
  const { payload, expiresIn } = await googleToken({
    grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, code_verifier: verifier,
  }, tokenUrl, request, 'Google did not accept this sign-in')
  if (typeof payload.refresh_token !== 'string' || payload.refresh_token === '') throw new Error('Google did not return a refresh token')
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresIn }
}

async function googleAccount(accessToken, userinfo, request, rejected) {
  let response
  try {
    response = await request(trimSlash(userinfo), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Could not reach Google')
  }
  if (response.status === 401) throw new Error(rejected)
  if (!response.ok) throw new Error(`Google answered ${response.status}`)
  const user = await response.json().catch(() => ({}))
  if (typeof user?.email !== 'string' || user.email === '') throw new Error('Google did not say which account this is')
  return user.email
}

export async function signInGmail({ refreshToken, clientId, clientSecret, tokenUrl = GMAIL_DEFAULTS.tokenUrl, userinfo = GMAIL_DEFAULTS.userinfo, fetch: request = fetch } = {}) {
  const exchanged = await googleAccess(refreshToken, clientId, clientSecret, tokenUrl, request)
  const login = await googleAccount(exchanged.accessToken, userinfo, request, 'Google did not accept this refresh token')
  return { login, accessToken: exchanged.accessToken, expiresIn: exchanged.expiresIn }
}

// `kept` leaves an existing scope alone, so the Secrets page can still share the key.
async function saveSecret(rt, name, value, purpose) {
  const kept = rt.secretValue(name) !== undefined
  await rt.secretEndpoint('secret-set', { name, value, purpose, ...(kept ? {} : { scope: [] }) })
}

function githubSpec(options) {
  return {
    id: GITHUB,
    name: 'GitHub',
    options,
    insecure: httpsError([options.url, options.api], GITHUB_INSECURE),
    secretNames: [GITHUB_SECRET],
    credential(rt) {
      const token = rt.secretValue(GITHUB_SECRET)
      return token === undefined ? null : { key: token, token }
    },
    account(rt, state) {
      return this.credential(rt) === null ? null : state.connectors?.[GITHUB]?.login ?? null
    },
    async connect(rt, state, body) {
      const token = text(body.token)
      if (token === '') throw new Error('Paste a token first')
      if (this.insecure) throw new Error(this.insecure)
      await rt.loadSecrets()
      const { login } = await signIn(token, { api: this.options.api })
      await saveSecret(rt, GITHUB_SECRET, token, 'GitHub connector')
      state.connectors = { ...state.connectors, [GITHUB]: { login, connectedAt: Date.now() } }
      await rt.save()
    },
    session(credential) {
      return { headers: { Authorization: `Bearer ${credential.token}`, 'X-MCP-Toolsets': this.options.toolsets } }
    },
  }
}

function gmailSpec(options) {
  return {
    id: GMAIL,
    name: 'Gmail',
    options,
    insecure: httpsError([options.api, options.tokenUrl, options.userinfo, options.authUrl], GMAIL_INSECURE),
    secretNames: [GMAIL_CLIENT_SECRET, GMAIL_REFRESH],
    credential(rt, state) {
      const refresh = rt.secretValue(GMAIL_REFRESH)
      const clientSecret = rt.secretValue(GMAIL_CLIENT_SECRET)
      const clientId = state.connectors?.[GMAIL]?.clientId
      if (refresh === undefined || clientSecret === undefined || typeof clientId !== 'string' || clientId === '') return null
      return { key: `${clientId}\0${clientSecret}\0${refresh}`, refresh, clientSecret, clientId }
    },
    account(_rt, state) {
      const login = state.connectors?.[GMAIL]?.login
      return typeof login === 'string' && login !== '' ? login : null
    },
    async session(credential, request) {
      const exchanged = await googleAccess(credential.refresh, credential.clientId, credential.clientSecret, this.options.tokenUrl, request)
      rememberAccess(this, exchanged.accessToken)
      return { headers: { Authorization: `Bearer ${exchanged.accessToken}` }, expiresIn: exchanged.expiresIn }
    },
  }
}

export function install(rt) {
  const { ctx, state } = rt
  const config = rt.config ?? {}
  const specs = []
  if (config.github !== false) specs.push(githubSpec({ ...GITHUB_DEFAULTS, ...config.github }))
  if (config.gmail !== false) specs.push(gmailSpec({ ...GMAIL_DEFAULTS, ...config.gmail }))
  const byId = new Map(specs.map(spec => [spec.id, spec]))
  let queue = Promise.resolve()
  let stopped = false
  let server = null
  let boundPort = null
  let pending = null
  // A newer sign-in, a cancel, or shutdown bumps this so a late callback cannot save.
  let attempt = 0
  const concealed = []

  const conceal = (value) => {
    if (typeof value !== 'string' || value.length < 4 || concealed.includes(value)) return
    concealed.push(value)
    while (concealed.length > 8) concealed.shift()
  }

  const clearTimer = (spec) => {
    if (spec.timer === undefined) return
    clearTimeout(spec.timer)
    spec.timer = undefined
  }

  const unmount = async (spec) => {
    clearTimer(spec)
    spec.access = undefined
    const fiber = spec.mount?.fiber
    spec.mount = null
    if (fiber !== undefined) await Promise.resolve().then(() => fiber.dispose()).catch(() => {})
  }

  const closeServer = () => {
    const current = server
    server = null
    boundPort = null
    pending = null
    if (current === null) return
    current.closeAllConnections?.()
    current.close()
  }

  // The MCP client wraps the server's answer (a 401, say) as the cause.
  const reason = (error) => {
    let message = [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ')
    const tokens = [...concealed, ...specs.flatMap(spec => spec.accessTokens ?? [])].filter(token => token.length >= 4).sort((a, b) => b.length - a.length)
    for (const token of tokens) message = message.split(token).join(ACCESS_LABEL)
    return rt.redactSecrets(message || 'error').slice(0, 300)
  }

  // One change at a time. `force` connects again even when the saved secrets are the same,
  // which is how a Gmail access token is renewed: the refresh token did not change.
  const sync = (id, force = false) => {
    const targets = id === undefined ? specs : specs.filter(spec => spec.id === id)
    queue = queue.then(async () => {
      for (const spec of targets) await reconcile(spec, force)
    }).catch(error => { rt.warn('ds-bot: connectors: %s', reason(error)) })
    return queue
  }

  const arm = (spec, expiresIn) => {
    clearTimer(spec)
    if (!Number.isFinite(expiresIn)) return
    const handle = setTimeout(() => {
      spec.timer = undefined
      void sync(spec.id, true)
    }, Math.max(REFRESH_MIN_S, expiresIn - REFRESH_SKEW_S) * 1000)
    handle.unref?.()
    spec.timer = handle
  }

  async function reconcile(spec, force) {
    if (stopped) return
    const credential = spec.credential(rt, state)
    if (!force && spec.mount !== null && spec.mount.key === credential?.key) return
    await unmount(spec)
    if (stopped) return
    if (credential === null) {
      spec.accessTokens = []
      spec.status = { state: 'off' }
      return
    }
    if (spec.insecure) {
      spec.mount = { key: credential.key }
      spec.status = { state: 'error', error: spec.insecure }
      return
    }
    spec.status = { state: 'connecting' }
    if (spec.id === GMAIL) {
      try {
        const session = await spec.session(credential, fetch)
        if (stopped) return
        spec.mount = { key: credential.key }
        spec.access = session
        spec.status = { state: 'ready' }
        arm(spec, session.expiresIn)
      } catch (error) {
        await unmount(spec)
        spec.mount = { key: credential.key }
        spec.status = { state: 'error', error: reason(error) }
        rt.warn('ds-bot: %s connector failed: %s', spec.name, spec.status.error)
      }
      return
    }
    const loader = ctx.get?.('loader')
    if (typeof loader?.import !== 'function' || typeof ctx.plugin !== 'function') {
      spec.mount = { key: credential.key }
      spec.status = { state: 'error', error: 'This DSH cannot load connectors' }
      return
    }
    try {
      const session = await spec.session(credential, fetch)
      if (stopped) return
      const exports = await loader.import(MCP_CLIENT)
      if (stopped) return
      const plugin = loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      const fiber = ctx.plugin(plugin, {
        transport: 'streamable-http',
        serverName: spec.id,
        url: spec.options.url,
        headers: session.headers,
        failOnStartupError: true,
      })
      if (stopped) {
        await Promise.resolve().then(() => fiber.dispose()).catch(() => {})
        return
      }
      spec.mount = { key: credential.key, fiber }
      await fiber.await()
      if (spec.mount?.fiber !== fiber) return
      spec.status = { state: 'ready' }
      arm(spec, session.expiresIn)
    } catch (error) {
      await unmount(spec)
      spec.mount = { key: credential.key }
      spec.status = { state: 'error', error: reason(error) }
      rt.warn('ds-bot: %s connector failed: %s', spec.name, spec.status.error)
    }
  }

  const gmailRedirect = () => {
    const spec = byId.get(GMAIL)
    if (spec === undefined) return undefined
    const configured = listenPort(spec.options.oauthPort)
    const port = boundPort ?? configured
    if (port === undefined || port <= 0) return undefined
    return `http://127.0.0.1:${port}${OAUTH_PATH}`
  }

  async function commitGmail(spec, mine, { clientId, clientSecret, refreshToken, accessToken }) {
    if (mine !== attempt || stopped) throw new Error(SIGN_IN_CANCELLED)
    await rt.loadSecrets()
    const login = await googleAccount(accessToken, spec.options.userinfo, fetch, 'Google did not accept this sign-in')
    if (mine !== attempt || stopped) throw new Error(SIGN_IN_CANCELLED)
    await saveSecret(rt, GMAIL_CLIENT_SECRET, clientSecret, 'Gmail connector')
    await saveSecret(rt, GMAIL_REFRESH, refreshToken, 'Gmail connector')
    if (mine !== attempt || stopped) {
      for (const name of spec.secretNames) {
        if (rt.secretValue(name) !== undefined) await rt.secretEndpoint('secret-delete', { name })
      }
      throw new Error(SIGN_IN_CANCELLED)
    }
    state.connectors = { ...state.connectors, [GMAIL]: { login, clientId, connectedAt: Date.now() } }
    await rt.save()
    spec.oauthNote = undefined
    await sync(spec.id)
  }

  // Only the loopback interface. The refresh token must not be reachable from another machine.
  async function onRequest(req, res) {
    const spec = byId.get(GMAIL)
    let mine
    try {
      const remote = req.socket?.remoteAddress
      if ((req.url ?? '').length > 4096 || (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1')) {
        reply(res, 404, ['Not found.'])
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== OAUTH_PATH || spec === undefined) {
        reply(res, 404, ['Not found.'])
        return
      }
      const held = pending
      if (held === null || Date.now() > held.expiresAt) {
        // A finished sign-in leaves nothing pending. Only a sign-in that actually
        // aged out should change what the Connectors page says.
        if (held !== null && pending === held) {
          pending = null
          spec.oauthNote = 'This sign-in has expired. Start again.'
        }
        reply(res, 400, ['This sign-in has expired. Start again.', '这次登录已过期，请重新开始。'])
        return
      }
      if (url.searchParams.get('error')) {
        pending = null
        if (held.mine === attempt) spec.oauthNote = SIGN_IN_CANCELLED
        reply(res, 400, ['Google sign-in was cancelled. You can close this tab.', 'Google 登录已取消，可以关闭这个标签页。'])
        return
      }
      const code = url.searchParams.get('code') ?? ''
      if (!sameText(url.searchParams.get('state') ?? '', held.state) || code === '' || code.length > 2048) {
        reply(res, 400, ['This sign-in does not match. Start again.', '这次登录对不上，请重新开始。'])
        return
      }
      pending = null
      mine = held.mine
      conceal(code)
      conceal(held.verifier)
      conceal(held.clientSecret)
      if (mine !== attempt || stopped) {
        reply(res, 400, ['Google sign-in was cancelled. You can close this tab.', 'Google 登录已取消，可以关闭这个标签页。'])
        return
      }
      const exchanged = await googleCode({
        code, verifier: held.verifier, clientId: held.clientId, clientSecret: held.clientSecret,
        redirect: held.redirect, tokenUrl: spec.options.tokenUrl, request: fetch,
      })
      conceal(exchanged.accessToken)
      conceal(exchanged.refreshToken)
      rememberAccess(spec, exchanged.accessToken)
      await commitGmail(spec, mine, {
        clientId: held.clientId, clientSecret: held.clientSecret, refreshToken: exchanged.refreshToken, accessToken: exchanged.accessToken,
      })
      reply(res, 200, ['Gmail is connected. You can close this tab.', 'Gmail 已连接，可以关闭这个标签页。'])
    } catch (error) {
      const message = reason(error)
      if (spec && mine === attempt) spec.oauthNote = message
      if (message === SIGN_IN_CANCELLED) {
        reply(res, 400, ['Google sign-in was cancelled. You can close this tab.', 'Google 登录已取消，可以关闭这个标签页。'])
        return
      }
      reply(res, 400, [message])
    }
  }

  async function ensureServer(port) {
    if (server !== null && boundPort !== null && (port === 0 || boundPort === port)) return boundPort
    closeServer()
    const next = createServer((req, res) => { void onRequest(req, res) })
    next.requestTimeout = CHECK_TIMEOUT_MS
    next.headersTimeout = 5_000
    // A waiting sign-in must not keep DSH alive on its own.
    next.unref()
    try {
      await new Promise((resolve, reject) => {
        next.once('error', reject)
        next.listen({ host: '127.0.0.1', port }, () => {
          next.removeListener('error', reject)
          resolve()
        })
      })
    } catch (error) {
      next.close()
      if (error?.code === 'EADDRINUSE' && port !== 0) throw new Error(`The Gmail sign-in port ${port} is already in use`)
      throw new Error('The Gmail sign-in page could not start')
    }
    next.on('error', () => {})
    server = next
    boundPort = next.address().port
    return boundPort
  }

  const connectorsView = () => specs.map(spec => {
    const redirect = spec.id === GMAIL ? gmailRedirect() : undefined
    const record = spec.id === GMAIL ? state.connectors?.[GMAIL] : undefined
    const clientId = typeof record?.clientId === 'string' && record.clientId !== '' ? record.clientId : undefined
    const clientSecretSaved = spec.id === GMAIL && rt.secretValue(GMAIL_CLIENT_SECRET) !== undefined
    const signInSaved = spec.id === GMAIL && rt.secretValue(GMAIL_REFRESH) !== undefined
    return {
      id: spec.id,
      name: spec.name,
      state: spec.status.state,
      ...(spec.status.error !== undefined ? { error: spec.status.error } : {}),
      ...(spec.oauthNote ? { oauthNote: spec.oauthNote } : {}),
      account: spec.account(rt, state),
      ...(clientId ? { clientId } : {}),
      ...(clientSecretSaved ? { clientSecretSaved: true } : {}),
      ...(signInSaved ? { signInSaved: true } : {}),
      ...(redirect ? { redirectUri: redirect } : {}),
    }
  })

  const dropAttempt = () => {
    attempt += 1
    pending = null
  }

  const endpoints = {
    async 'connector-connect'(body) {
      const spec = byId.get(body.id)
      if (spec === undefined) throw new Error('No such connector')
      if (typeof spec.connect !== 'function') throw new Error('This connector signs in through the browser')
      await spec.connect(rt, state, body ?? {})
      await sync(spec.id)
      return connectorsView()
    },
    async 'connector-oauth-start'(body) {
      const spec = byId.get(body.id)
      if (spec?.id !== GMAIL) throw new Error('No such connector')
      const clientId = text(body.clientId)
      const clientSecret = text(body.clientSecret)
      if (clientId === '') throw new Error('Paste a Google client ID first')
      if (clientSecret === '') throw new Error('Paste a Google client secret first')
      if (spec.insecure) throw new Error(spec.insecure)
      const port = listenPort(spec.options.oauthPort)
      if (port === undefined) throw new Error('The Gmail sign-in port must be from 0 to 65535')
      spec.oauthNote = undefined
      const bound = await ensureServer(port)
      dropAttempt()
      const mine = attempt
      const { verifier, challenge } = pkce()
      const oauthState = randomBytes(32).toString('base64url')
      const redirectUri = `http://127.0.0.1:${bound}${OAUTH_PATH}`
      pending = { mine, state: oauthState, verifier, clientId, clientSecret, redirect: redirectUri, expiresAt: Date.now() + OAUTH_TTL_MS }
      conceal(verifier)
      conceal(clientSecret)
      const url = authorizationUrl({ authUrl: spec.options.authUrl, clientId, redirect: redirectUri, state: oauthState, challenge })
      openBrowser(url)
      return { authorizationUrl: url, redirectUri }
    },
    async 'connector-oauth-cancel'(body) {
      const spec = byId.get(body.id)
      if (spec?.id !== GMAIL) throw new Error('No such connector')
      dropAttempt()
      spec.oauthNote = undefined
      return connectorsView()
    },
    async 'connector-disconnect'(body) {
      const spec = byId.get(body.id)
      if (spec === undefined) throw new Error('No such connector')
      if (spec.id === GMAIL) dropAttempt()
      spec.oauthNote = undefined
      await rt.loadSecrets()
      for (const name of spec.secretNames) {
        if (rt.secretValue(name) !== undefined) await rt.secretEndpoint('secret-delete', { name })
      }
      if (state.connectors?.[spec.id] !== undefined) {
        delete state.connectors[spec.id]
        await rt.save()
      }
      await sync(spec.id)
      return connectorsView()
    },
    async 'connector-retry'(body) {
      const spec = byId.get(body.id)
      if (spec === undefined) throw new Error('No such connector')
      await rt.loadSecrets()
      await sync(spec.id, true)
      return connectorsView()
    },
  }

  for (const spec of specs) {
    spec.status = { state: 'off' }
    spec.mount = null
    spec.accessTokens = []
  }

  ctx.effect(() => {
    stopped = false
    void rt.loadSecrets().then(() => sync())
    return () => {
      stopped = true
      attempt += 1
      closeServer()
      for (const spec of specs) void unmount(spec)
    }
  }, 'ds-bot: connectors')

  // One 401 refreshes the access token and tries once more. The token stays in memory.
  async function gmailRequest(method, path, { query, body } = {}) {
    const spec = byId.get(GMAIL)
    const once = async () => {
      const authorization = spec?.access?.headers?.Authorization
      if (spec === undefined || spec.status.state !== 'ready' || typeof authorization !== 'string') throw new Error(GMAIL_OFF)
      const url = new URL(`${trimSlash(spec.options.api)}/gmail/v1/users/me${path}`)
      for (const [key, value] of Object.entries(query ?? {})) {
        const values = Array.isArray(value) ? value : [value]
        for (const item of values) {
          if (item !== undefined && item !== '') url.searchParams.append(key, String(item))
        }
      }
      let response
      try {
        response = await fetch(url, {
          method,
          headers: { Authorization: authorization, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        })
      } catch {
        throw new Error('Could not reach Gmail')
      }
      const payload = await response.json().catch(() => ({}))
      return { response, payload }
    }
    let result = await once()
    if (result.response.status === 401 && spec !== undefined) {
      await sync(GMAIL, true)
      result = await once()
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const message = result.payload?.error?.message
      throw new Error(message ? `Gmail refused: ${String(message).slice(0, 180)}` : 'Gmail refused this request')
    }
    if (!result.response.ok) throw new Error(`Gmail answered ${result.response.status}`)
    return result.payload
  }

  Object.assign(rt, {
    connectorsView,
    connectorEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}),
    secretsChanged: () => { void sync() },
    gmailRequest,
  })
}

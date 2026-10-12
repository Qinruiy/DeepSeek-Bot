import { createElement as h, useEffect, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { hostText, t } from './i18n.js'

export const GitHubMark = () => h('svg', { width: 20, height: 20, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' }))

// An envelope, drawn for this screen. Not the Gmail mark.
const EnvelopeMark = () => h('svg', {
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round', 'aria-hidden': true,
},
  h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
  h('path', { d: 'M4 7.5 12 13l8-5.5' }))

const MARKS = { github: GitHubMark, gmail: EnvelopeMark }
const ABOUT = {
  github: () => t('Repositories, issues, and pull requests'),
  gmail: () => t('Read mail and create drafts'),
}
const FORMS = {
  github: {
    href: 'https://github.com/settings/personal-access-tokens/new',
    link: () => t('Create a token on GitHub'),
    fields: [{ key: 'token', label: () => t('GitHub token'), placeholder: () => t('Paste a GitHub token'), masked: true }],
  },
  gmail: {
    href: 'https://console.cloud.google.com/',
    link: () => t('OAuth sign-in at console.cloud.google.com'),
    oauth: true,
    fields: [
      { key: 'clientId', label: () => t('Google client ID'), placeholder: () => t('Paste a Google client ID'), masked: false },
      { key: 'clientSecret', label: () => t('Google client secret'), placeholder: () => t('Paste a Google client secret'), masked: true },
    ],
  },
}

function statusText(connector) {
  if (connector.state === 'connecting') return t('Connecting…')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready') return connector.account ? t('Connected as {account}', { account: connector.account }) : t('Connected')
  if (connector.account) return t('Saved account {account}', { account: connector.account })
  return ABOUT[connector.id]?.() ?? ''
}

// The client secret and refresh token stay on the host. This only shows that they are still stored.
function savedIdentity(connector) {
  const showAccount = connector.account && connector.state !== 'ready' && connector.state !== 'off'
  if (!showAccount && !connector.clientId && !connector.clientSecretSaved && !connector.signInSaved) return null
  return h('div', { className: 'bt-connector-saved' },
    showAccount ? h('span', { className: 'bt-connector-wait' }, t('Saved account {account}', { account: connector.account })) : null,
    connector.clientId ? h('div', { className: 'bt-connector-redirect' },
      h('span', null, t('Google client ID')),
      h('code', null, connector.clientId)) : null,
    connector.clientSecretSaved ? h('span', { className: 'bt-connector-wait' }, t('Google client secret saved')) : null,
    connector.signInSaved ? h('span', { className: 'bt-connector-wait' }, t('Google sign-in saved')) : null)
}

function ConnectorRow({ connector, actions }) {
  const formSpec = FORMS[connector.id]
  const [form, setForm] = useState(false)
  const [values, setValues] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [waiting, setWaiting] = useState(null)
  const filled = formSpec?.fields.every(field => (values[field.key] ?? '').trim() !== '') ?? false
  const on = connector.state !== 'off'
  useEffect(() => {
    if (!on) return
    setForm(false)
    setWaiting(null)
    setValues({})
    setError(null)
  }, [on])
  useEffect(() => {
    if (connector.oauthNote) setWaiting(null)
  }, [connector.oauthNote])
  const run = (task, after) => {
    setBusy(true)
    setError(null)
    return task.then(() => { after?.() }, failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const connect = () => {
    if (busy || !filled || formSpec === undefined) return
    const payload = {}
    for (const field of formSpec.fields) payload[field.key] = values[field.key] ?? ''
    if (formSpec.oauth) {
      void run(actions.connectorOAuthStart(connector.id, payload).then(result => {
        setWaiting({ authorizationUrl: result.authorizationUrl, redirectUri: result.redirectUri })
      }))
      return
    }
    void run(actions.connectorConnect(connector.id, payload), () => { setValues({}); setForm(false) })
  }
  const close = () => {
    const pending = waiting
    setForm(false)
    setValues({})
    setError(null)
    setWaiting(null)
    if (pending) void actions.connectorOAuthCancel(connector.id).catch(() => {})
  }
  const Mark = MARKS[connector.id]
  const redirect = waiting?.redirectUri || connector.redirectUri
  const shown = error ?? (connector.oauthNote ? hostText(connector.oauthNote) : null)
  const row = useRef(null)
  useMorph(row, `${form}:${shown !== null}:${connector.state}:${waiting !== null}`)
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, Mark ? h(Mark) : null),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, connector.name),
        h('span', { className: 'bt-connector-status' }, statusText(connector))),
      h('span', { className: 'bt-connector-actions' },
        connector.state === 'error' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorRetry(connector.id)) }, t('Try again')) : null,
        on
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorDisconnect(connector.id)) }, t('Disconnect'))
          : form || formSpec === undefined ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => {
            setForm(true)
            if (connector.clientId) setValues(current => ({ ...current, clientId: current.clientId || connector.clientId }))
          } }, t('Connect')))),
    savedIdentity(connector),
    !on && form && formSpec ? h('div', { className: 'bt-connector-form' },
      redirect ? h('div', { className: 'bt-connector-redirect' },
        h('span', null, t('Register this redirect URI on the OAuth client')),
        h('code', null, redirect)) : null,
      formSpec.fields.map((field, index) => h('label', { key: field.key, className: 'bt-q-field bt-secret-field' }, h(MaskedInput, {
        value: values[field.key] ?? '', masked: field.masked, placeholder: field.placeholder?.(), onChange: value => setValues(current => ({ ...current, [field.key]: value })), onEnter: connect, label: field.label(), autoFocus: index === 0,
      }))),
      waiting && !connector.oauthNote ? h('span', { className: 'bt-connector-wait' }, t('Waiting for the Google sign-in')) : null,
      waiting?.authorizationUrl ? h('a', { className: 'bt-connector-open', href: waiting.authorizationUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open the Google sign-in page')) : null,
      h('div', { className: 'bt-connector-form-row' },
        h('a', { className: 'bt-connector-link', href: formSpec.href, target: '_blank', rel: 'noopener noreferrer' }, formSpec.link()),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: close }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !filled, onClick: connect }, busy ? t('Connecting…') : t('Connect')))) : null,
    shown ? h('div', { className: 'bt-connector-error', role: 'alert' }, shown) : null)
}

// Settings → Connectors: one row per connector.
export function ConnectorsPage({ roster, actions }) {
  const list = roster?.connectors ?? []
  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-set-card bt-connectors-card' }, list.length === 0
      ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connectors')))
      : list.map(connector => h(ConnectorRow, { key: connector.id, connector, actions }))))
}

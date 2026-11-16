import type { OrcaWorkerApi } from 'orca/worker'
import type { State, Unit } from './contracts.ts'
import { cli, stopAll } from './orca.ts'
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tg, chunks, accept, outgoing, type Bot, type Message, type Update } from './telegram.ts'
import { chatSend, chatSettle } from './chat.ts'

type Stored = Omit<Unit, 'id' | 'connected' | 'error'>
// A turn already sent to the chat: `base` is the history position it was sent after.
type Sent = Message & { base?: number }

const TURN_MS = 2 * 60 * 60 * 1000
const AGENTS = ['claude', 'codex']
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const loops = new Map<string, AbortController>() // unit id → its Telegram poll
// Where a unit's automation leaves posts for its bot: the token never leaves the plugin's secrets.
const OUTBOX = join(homedir(), '.telegram-connect', 'outbox')
let outbox: ReturnType<typeof setInterval> | undefined
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function deactivate() {
  for (const loop of loops.values()) loop.abort()
  clearInterval(outbox)
  stopAll()
}

export default async function activate(orca: OrcaWorkerApi) {
  const units = ((await orca.storage.get('units')) || {}) as Record<string, Stored>
  const errors: Record<string, string | null> = {} // unit id → problem shown in the panel
  const save = () => orca.storage.set('units', units)

  function changed(id?: string, error: string | null = null) {
    if (id) errors[id] = error
    const text = `Telegram: ${loops.size}/${Object.keys(units).length}`
    void orca.host.call('statusBar.update', { id: 'units', text }).catch(() => {})
    orca.panels.post('changed', {})
  }

  const repos = async () => (await cli<{ repos: { id: string; path: string; displayName: string }[] }>(['repo', 'list'])).repos

  // A unit is an Orca chat: the role is its first message, and Orca keeps the conversation.
  async function launch(unit: Stored) {
    const intro = `You are unit "${unit.name}". People write to you from Telegram and see only the text of your replies once the turn ends. Do not ask questions through tools: decide yourself or ask in plain text. Reply in the language you are written to in.`
    const prompt = [intro, unit.role].filter(Boolean).join('\n\n')
    const model = unit.model ? ['--model', unit.model] : []
    // A folder project can hold several workspaces on one path, so `path:` is ambiguous there: name the project's own one.
    const repo = (await repos()).find(r => r.path === unit.dir)
    const where = repo ? `id:${repo.id}::${repo.path}` : 'path:' + unit.dir
    const args = ['agent', 'launch', '--agent', unit.agent!, '--worktree', where, '--surface', 'chat', ...model, '--prompt', prompt]
    const result = await cli<{ outcome?: { kind: string; sessionId: string }; receipt?: { detail?: string } }>(args)
    if (result.outcome?.kind !== 'structured') {
      throw new Error('Orca opened a terminal instead of a chat: ' + (result.receipt?.detail || 'no reason given'))
    }
    unit.sessionId = result.outcome.sessionId
  }

  // Quiet mode: the whole turn's text arrives as one reply when the agent finishes.
  // A `message` with `base` is a turn a previous run of the plugin already sent: only its reply is still owed.
  async function turn(id: string, token: string, message: Sent) {
    const { chat, thread, text: said, id: replyTo } = message
    // Answer where the person wrote: the same forum topic, as a reply to their message.
    const place = { chat_id: chat, message_thread_id: thread }
    const reply = { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    const say = async (words: string) => {
      for (const part of chunks(words)) await tg(token, 'sendMessage', { ...place, ...reply, text: part })
    }
    const typing = () => tg(token, 'sendChatAction', { ...place, action: 'typing' }).catch(() => {})
    void typing()
    const timer = setInterval(typing, 5000)
    // Seen: the turn can take minutes, and the reply only comes at its end.
    void tg(token, 'setMessageReaction', { chat_id: chat, message_id: replyTo, reaction: [{ type: 'emoji', emoji: '👀' }] }).catch(() => {})
    let base = message.base
    try {
      const sessionId = units[id].sessionId!
      base ??= await chatSend(sessionId, said)
      // Remember the sent turn, so a plugin restart still delivers its reply and never sends it twice.
      await orca.storage.set('turn:' + id, { ...message, base })
      const held = () =>
        say(
          'The agent chat is on hold (usage limit, pause or an open question in Orca). Your message is queued; the reply will come when the chat resumes.'
        )
      const result = await chatSettle(sessionId, said, base, TURN_MS, held)
      const spoken = result.entries.filter(e => e.kind === 'error' || e.role === 'assistant').map(e => e.text)
      const waiting = result.entries.filter(e => e.pending).map(e => e.text)
      const notes = [
        result.truncated && '(The start of the reply did not fit; the full text is in the Orca chat.)',
        result.settled === 'blocked' && 'The agent is waiting for your answer in Orca:\n' + waiting.join('\n'),
        result.settled === 'timeout' && 'The agent is still working; see the result in the Orca chat.'
      ]
      await say([...spoken, ...notes].filter(Boolean).join('\n\n') || 'The turn ended without text.')
    } catch (error) {
      // Once sent, the agent has the message: say so, or the owner would send it twice.
      const lost = base === undefined ? 'Not delivered: ' : 'Delivered, but the reply was lost (see the Orca chat): '
      await say(lost + reason(error)).catch(e => changed(id, reason(e)))
    } finally {
      clearInterval(timer)
      await orca.storage.delete('turn:' + id)
    }
  }

  // One message at a time: Telegram keeps the rest of the queue, so no message waits in this process's memory.
  // `resume` finishes a turn the previous run of the plugin sent: only its reply is still owed.
  async function poll(id: string, signal: AbortSignal, resume: boolean) {
    const token = await orca.secrets.get('token:' + id)
    if (!token) throw new Error('The bot token is missing: enter it in Settings')
    let offset = ((await orca.storage.get('offset:' + id)) || 0) as number
    let delay = 1000
    let bot: Bot | undefined
    while (!signal.aborted) {
      try {
        const left = resume && ((await orca.storage.get('turn:' + id)) as Sent | null)
        resume = false
        if (left) await turn(id, token, left)
        bot ||= await tg<Bot>(token, 'getMe', {}, signal)
        const [update] = await tg<Update[]>(token, 'getUpdates', { offset, limit: 1, timeout: 30, allowed_updates: ['message'] }, signal)
        delay = 1000
        if (errors[id]) changed(id)
        if (!update) continue
        // At most once: confirm the message before acting, so a crash can never make a full-permission agent repeat it.
        offset = update.update_id + 1
        await orca.storage.set('offset:' + id, offset)
        const message = accept(update, bot)
        if (message) await turn(id, token, message)
      } catch (error) {
        if (signal.aborted) return
        // Another program polls this token (409), or the token is wrong (401): retrying would only fight it.
        const fatal = [401, 409].includes((error as { code?: number }).code!)
        if (fatal) loops.delete(id)
        changed(id, reason(error))
        if (fatal) return
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  function start(id: string, resume = false) {
    if (loops.has(id)) return
    const loop = new AbortController()
    loops.set(id, loop)
    poll(id, loop.signal, resume).catch(error => {
      loops.delete(id)
      changed(id, reason(error))
    })
  }
  function stop(id: string) {
    loops.get(id)?.abort()
    loops.delete(id)
  }
  function unitOf(id: string) {
    if (!Object.hasOwn(units, id)) throw new Error('Unit not found')
    return units[id]
  }

  function state(): State {
    return { units: Object.entries(units).map(([id, unit]) => ({ id, ...unit, connected: loops.has(id), error: errors[id] || null })) }
  }

  orca.panels.handle('state', state)
  orca.panels.handle('projects', async () => (await repos()).map(r => ({ value: r.path, label: `${r.displayName} · ${r.path}` })))

  orca.panels.handle('unit.save', async input => {
    const name = String(input.name || '').trim()
    const role = String(input.role || '').trim()
    const token = String(input.token || '').trim()
    if (!name) throw new Error('Enter a name')
    if (!input.id && !token) throw new Error('Enter the bot token')
    if (input.id) unitOf(input.id)
    // Telegram is the judge of a token: getMe fails on a wrong one and names the bot of a right one.
    const bot = token && 'bot-' + (await tg<Bot>(token, 'getMe')).id
    if (input.id && bot && bot !== input.id) throw new Error('This token belongs to another bot: add it as a new unit')
    if (!input.id && Object.hasOwn(units, bot)) throw new Error('This bot is already added')
    const id = input.id || bot
    if (token) await orca.secrets.set('token:' + id, token)
    units[id] = { ...units[id], name, role }
    await save()
    changed()
    return state()
  })

  orca.panels.handle('unit.connect', async ({ id, dir, agent, model, fresh }) => {
    const old = unitOf(id)
    const next = { dir: String(dir || ''), agent, model: String(model || '').trim() }
    if (!next.dir || !AGENTS.includes(agent)) throw new Error('Choose a project and a provider')
    const unit = { ...old, ...next, enabled: true }
    // The chat keeps its context for as long as the unit stays in the same place; moving it starts a new one.
    if ((['dir', 'agent', 'model'] as const).some(key => old[key] !== next[key])) delete unit.sessionId
    if (fresh || !unit.sessionId) await launch(unit)
    units[id] = unit
    await save()
    start(id)
    changed(id)
    return state()
  })

  orca.panels.handle('unit.disconnect', async ({ id }) => {
    unitOf(id).enabled = false
    stop(id)
    await save()
    changed(id)
    return state()
  })

  orca.panels.handle('unit.remove', async ({ id }) => {
    unitOf(id)
    stop(id)
    delete units[id]
    await orca.secrets.delete('token:' + id)
    await orca.storage.delete('offset:' + id)
    await orca.storage.delete('turn:' + id)
    await save()
    changed(id)
    return state()
  })

  // Posts each outbox file as its unit's bot. A file leaves the folder before it is sent, so a crash can
  // never post it twice; one that cannot be sent stays beside it as `.failed` with the reason in `.error`.
  // ponytail: any program of this user can post as a unit by writing here, the same trust as Orca's own socket.
  let draining = false
  async function drain() {
    if (draining) return
    draining = true
    try {
      for (const name of (await readdir(OUTBOX)).filter(n => n.endsWith('.json')).sort()) {
        const file = join(OUTBOX, name)
        const taken = file + '.sending'
        await rename(file, taken)
        try {
          const post = outgoing(await readFile(taken, 'utf8'))
          const wanted = post.unit.toLowerCase()
          const id = Object.keys(units).find(key => key === post.unit || units[key].name.toLowerCase() === wanted)
          const token = id && (await orca.secrets.get('token:' + id))
          if (!token) throw new Error(`No unit "${post.unit}" with a bot token`)
          for (const part of chunks(post.text)) await tg(token, 'sendMessage', { ...post.place, text: part })
          await unlink(taken)
        } catch (error) {
          await rename(taken, file + '.failed').catch(() => {})
          await orca.storage.set('outbox:error', `${name}: ${reason(error)}`).catch(() => {})
        }
      }
    } catch {
      // No folder yet, or it is busy: the next pass tries again.
    } finally {
      draining = false
    }
  }
  await mkdir(OUTBOX, { recursive: true }).catch(() => {})
  outbox = setInterval(() => void drain(), 2000)

  for (const [id, unit] of Object.entries(units)) if (unit.enabled && unit.sessionId) start(id, true)
  changed()
}

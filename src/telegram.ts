// Telegram Bot API over fetch: https://core.telegram.org/bots/api

export type Bot = { id: number; username: string }
export type Update = {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number; type: string }
    from?: { id: number; first_name?: string }
    text?: string
    reply_to_message?: { from?: { id: number } }
    is_topic_message?: boolean
    message_thread_id?: number
  }
}
// A message for the agent: where it was written (`thread` is the forum topic) and what was said.
export type Message = { chat: number; id: number; thread?: number; text: string }

export async function tg<T>(token: string, method: string, body = {}, signal?: AbortSignal, retried = false): Promise<T> {
  // Long polls hold the request for 30 s; anything slower than this is a dead connection.
  const limit = AbortSignal.timeout(method === 'getUpdates' ? 45000 : 20000)
  let response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, limit]) : limit
    })
  } catch {
    // Never rethrow the fetch error: its text can carry the URL, and the URL holds the token.
    throw new Error('Telegram is unreachable')
  }
  const data = await response.json().catch(() => ({}))
  if (data.ok) return data.result
  // Flood control names its own wait (ResponseParameters.retry_after): honour it once, then fail.
  const wait = data.parameters?.retry_after
  if (wait && !retried) {
    await new Promise(resolve => setTimeout(resolve, wait * 1000))
    return tg(token, method, body, signal, true)
  }
  throw Object.assign(new Error(`Telegram: ${data.description || response.status}`), {
    code: data.error_code || response.status
  })
}

// Splits a reply into Telegram-sized messages, preferring paragraph, line, then word boundaries.
export function chunks(text: string, max = 4096) {
  const parts = []
  while (text.length > max) {
    const head = text.slice(0, max)
    const cut = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')].find(i => i > max / 2) ?? max
    parts.push(text.slice(0, cut).trimEnd())
    text = text.slice(cut).trimStart()
  }
  if (text) parts.push(text)
  return parts
}

// Who may command an agent that runs with full permissions: anyone in a group who mentions the bot or replies
// to it. Private chats are closed to everyone: anyone on Telegram can find a bot and write to it. Which groups
// the bot is in is the owner's to control in BotFather (/setjoingroups). Returns null for a message that is not
// for the agent.
export function accept(update: Update, bot: Bot): Message | null {
  const message = update.message
  const text = message?.text
  if (!message || typeof text !== 'string' || message.chat.type === 'private') return null
  const mention = new RegExp('@' + bot.username + '(?!\\w)', 'gi')
  if (!mention.test(text) && message.reply_to_message?.from?.id !== bot.id) return null
  // Orca's storage refuses undefined, so a message outside a forum topic carries no `thread` at all.
  const thread = message.is_topic_message ? { thread: message.message_thread_id } : {}
  // The agent has to know who is talking to it.
  const said = `${message.from?.first_name || 'Someone'}: ${text.replace(mention, '').trim()}`
  return { chat: message.chat.id, id: message.message_id, ...thread, text: said }
}

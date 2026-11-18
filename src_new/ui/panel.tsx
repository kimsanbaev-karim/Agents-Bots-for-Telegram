import { atom, read, set, plugin, Stack, Row, Heading, Button, Text } from 'orca'

declare module 'orca' {
  interface PluginRequests {
    start: { input: Record<string, never>; output: string }
    stop: { input: Record<string, never>; output: string }
  }
}

const status = atom('')

async function call(name: 'start' | 'stop', pending: string) {
  set(status, pending)
  try {
    set(status, await plugin.request(name, {}))
  } catch (e) {
    set(status, e instanceof Error ? e.message : String(e))
  }
}

export default function Panel() {
  return (
    <Stack gap="md">
      <Heading>Telegram Connect</Heading>
      <Row gap="sm">
        <Button onPress={() => call('start', 'Тони ждёт сообщения…')}>Старт</Button>
        <Button onPress={() => call('stop', 'Останавливаю…')}>Стоп</Button>
      </Row>
      {read(status) && <Text>{read(status)}</Text>}
    </Stack>
  )
}

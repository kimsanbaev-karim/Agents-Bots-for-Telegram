import type { OrcaWorkerApi } from 'orca/worker'
import {
  Bot,
  Message,
  TelegramMessage,
} from "./entities/bot.ts";

// Composition root — аналог Program.cs. Единственное место, которое знает конкретные классы и создаёт их через new.
// Все остальные классы получают зависимости через конструктор и знают только интерфейсы.
//
// Жизненный цикл (docs/reference/plugin-authoring.md в stablyai/orca):
// - Orca вызывает activate один раз при старте воркера; это отдельный процесс Node.
// - Воркер перезапускается при обновлении плагина и теряет всё из памяти: что должно пережить
//   перезапуск, храните в orca.storage.
// - Подписки (panels.handle, events.on) отписывать не нужно: они умирают вместе с процессом.
// - deactivate вызывается перед остановкой и нужен только для фоновой работы, которую надо погасить.

// То, что надо остановить в deactivate, храним на уровне модуля:
// let service: UnitService | undefined

export default async function activate(orca: OrcaWorkerApi) {
  
  const tony = new Bot('Тони', '8860176343:AAEQkrLPO3_U0vI8UCddUDaF5NBQ3BcSRQY');
  tony.on('error', error => orca.log(`Тони: ${error}`));

  orca.panels.handle('start', async () => {
    tony.start();
    const welcome = new TelegramMessage(0, -1004333622168, "Жду сообщения...");
    tony.send(welcome);
    const message = await tony.waitNextMessage();
    tony.reply(message, "Привет, я Тони");
    return `Ответил: ${message.author}`;
  });

  orca.panels.handle('stop', async () => {
    await tony.stop();
    return 'Тони остановлен';
  });

  // 1. Инфраструктура: адаптеры к внешнему миру (реализации интерфейсов).
  //    Хранилище и секреты даёт Orca: orca.storage, orca.secrets.
  // const telegram = new TelegramClient()
  // const chats = new OrcaChatGateway()
  // const units = new UnitRepository(orca.storage, orca.secrets)

  // 2. Приложение: логика, которая знает только интерфейсы из пункта 1.
  // service = new UnitService(units, telegram, chats)

  // 3. Точки входа: что вызывает Orca (запросы панели, события), — тонкие обёртки над сервисами.
  // orca.panels.handle('state', () => service.state())

  // 4. Запуск фоновой работы: опрос ботов.
  // await service.start()

  orca.log('Telegram Connect: started')
}

export async function deactivate() {
  // Остановить опрос ботов и дочерние процессы CLI Orca.
  // await service?.stop()
}

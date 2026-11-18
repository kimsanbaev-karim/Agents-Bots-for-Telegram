import {
    Bot as GrammyBot,
    type Context,
    type Filter
} from 'grammy'
import {
    EventEmitter,
    once
} from 'node:events'
import {
    threadId
} from "node:worker_threads";

type TextMessage = Filter<Context, 'message:text'>

export class AsyncEvent<T> {
    private readonly _handlers = new Set<(value: T) => Promise<void>>()

    public on(handler: (value: T) => Promise<void>) {
        this._handlers.add(handler)
        return () => this._handlers.delete(handler)
    }

    public async invoke(value: T) {
        for (const handler of this._handlers) await handler(value)
    }
}

type TextHandler = (message: IMessage) => Promise<void>

export class Bot extends EventEmitter<{
    message: [IMessage],
    error: [unknown]
}> {

    name: string;
    private _grammyBot: GrammyBot;

    constructor(name: string, token: string) {
        super();
        this.name = name;
        this._grammyBot = new GrammyBot(token)
    }

    public start() {
        this._grammyBot.chatType(['group', 'supergroup'])
            .on('message:text')
            .filter(this.isForMe, ctx => this.onReceivedText(ctx))
        this._grammyBot.start().catch(error => this.emit('error', error))
    }

    public stop() {
        return this._grammyBot.stop()
    }

    private isForMe(ctx: Context) {
        const me = `@${ctx.me.username}`.toLowerCase()
        const mentioned = ctx.entities('mention').some(entity => entity.text.toLowerCase() === me)
        const repliedToMe = ctx.message?.reply_to_message?.from?.id === ctx.me.id
        return mentioned || repliedToMe
    }

    private async onReceivedText(ctx: TextMessage) {
        const content = new TextContent(ctx.message.text);
        const message = new TelegramMessage(ctx.message.message_id, ctx.chatId, ctx.from.first_name, content)
        message.thread_id = ctx.message.message_thread_id;
        this.emit('message', message);
    }

    async waitNextMessage() {
        const [message] = await once(this, 'message');
        return message;
    }

    public reply(message: IMessage, text: string) {
        if (message instanceof TelegramMessage) {
            const answer = new TelegramMessage(0, message.chat_id, this.name, new TextContent(text));
            answer.thread_id = message.thread_id;
            this.send(answer, message);
        }
    }

    send(message: IMessageContent, provider: IMessageProvider) {
        if(provider instanceof TelegramChat || provider instanceof TelegramThread)
        {
            if (message instanceof TextContent) {
                this._grammyBot.api
                    .sendMessage(provider.id, message.content.text, {
                        message_thread_id: thread_id,
                        reply_parameters
                    })
                    .catch(error => this.emit('error', error));
            }
        }
    }

    send(message: IMessage, provider: IMessageProvider, replied?: IMessage) {
        const chat = provider instanceof TelegramThread ? provider.chat : provider instanceof TelegramChat ? provider : undefined;
        const thread_id = provider instanceof TelegramThread ? provider.thread_id : undefined;
        if (!chat) return;

        const reply_parameters = replied instanceof TelegramMessage ? {message_id: replied.id} : undefined;

        if (message.content instanceof TextContent) {
            this._grammyBot.api
                .sendMessage(chat.id, message.content.text, {
                    message_thread_id: thread_id,
                    reply_parameters
                })
                .catch(error => this.emit('error', error));
        }
    }
}

interface IMessage {
    author: string;
    content: IMessageContent;
}

class Message implements IMessage {
    author: string;
    content: IMessageContent;
    provider: IMessageProvider

    constructor(provider: IMessageProvider) {
        this.provider = provider;
    }
}

interface IMessageProvider {
}

interface ITelegramMessageProvider extends IMessageProvider {
}

class TelegramThread implements ITelegramMessageProvider {
    chat: TelegramChat;
    thread_id: number;

    constructor(chat_id: TelegramChat, thread_id: number) {
        this.chat = chat_id;
        this.thread_id = thread_id;
    }
}

class TelegramChat implements ITelegramMessageProvider {
    id: number;

    constructor(id: number) {
        this.id = id;
    }
}

export class TelegramMessage implements IMessage {
    author: string;
    content: IMessageContent;
    context: TelegramChat | TelegramThread;
    id: number;

    constructor(id: number, author: string, content: IMessageContent, context: TelegramChat | TelegramThread) {
        this.author = author
        this.content = content
        this.id = id;
        this.context = context;
    }
}

interface IMessageContent {

}

class TextContent implements IMessageContent {
    text: string;

    constructor(text: string) {
        this.text = text;
    }
}
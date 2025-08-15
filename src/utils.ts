// 重新导出token估算器
export { OptimizedTokenEstimator, getGlobalTokenEstimator, estimateTokens, safeJsonParse } from './token-estimator'
import { OptimizedTokenEstimator } from './token-estimator'

export function generateId(): string {
    return Math.random().toString(36).substring(2)
}

export function sendMessageStart(controller: ReadableStreamDefaultController): void {
    const event = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: generateId(),
            type: 'message',
            role: 'assistant',
            content: []
        }
    })}\n\n`
    controller.enqueue(new TextEncoder().encode(event))
}

export function sendMessageStop(
    controller: ReadableStreamDefaultController,
    usage?: { input_tokens: number; output_tokens: number }
): void {
    const eventData: any = { type: 'message_stop' }
    if (usage) {
        eventData.usage = usage
    }
    const event = `event: message_stop\ndata: ${JSON.stringify(eventData)}\n\n`
    controller.enqueue(new TextEncoder().encode(event))
}

export function processTextPart(text: string, index: number): string[] {
    const events: string[] = []

    events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: {
                type: 'text',
                text: ''
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: {
                type: 'text_delta',
                text
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index
        })}\n\n`
    )

    return events
}

export function processToolUsePart(functionCall: { name: string; args: any }, index: number): string[] {
    const events: string[] = []
    const toolUseId = generateId()

    events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: {
                type: 'tool_use',
                id: toolUseId,
                name: functionCall.name,
                input: {}
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(functionCall.args)
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index
        })}\n\n`
    )

    return events
}

export function buildUrl(baseUrl: string, endpoint: string): string {
    let finalUrl = baseUrl
    if (!finalUrl.endsWith('/')) {
        finalUrl += '/'
    }
    return finalUrl + endpoint
}

export async function processProviderStream(
    providerResponse: Response,
    processLine: (
        jsonStr: string,
        textIndex: number,
        toolIndex: number
    ) => { events: string[]; textBlockIndex: number; toolUseBlockIndex: number; outputTokens?: number } | null,
    originalClaudeRequest?: any, // Claude请求用于计算input tokens
    tokenEstimator?: OptimizedTokenEstimator // token估算器
): Promise<Response> {
    const stream = new ReadableStream({
        async start(controller) {
            const reader = providerResponse.body?.getReader()
            if (!reader) {
                controller.close()
                return
            }

            const decoder = new TextDecoder()
            let buffer = ''
            let textBlockIndex = 0
            let toolUseBlockIndex = 0
            let totalOutputTokens = 0

            sendMessageStart(controller)

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    const chunk = buffer + decoder.decode(value, { stream: true })
                    const lines = chunk.split('\n')

                    buffer = lines.pop() || ''

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue

                        const jsonStr = line.slice(6)
                        if (jsonStr === '[DONE]') continue

                        const result = processLine(jsonStr, textBlockIndex, toolUseBlockIndex)
                        if (result) {
                            textBlockIndex = result.textBlockIndex
                            toolUseBlockIndex = result.toolUseBlockIndex

                            // 累积输出tokens
                            if (result.outputTokens) {
                                totalOutputTokens = result.outputTokens
                            }

                            for (const event of result.events) {
                                controller.enqueue(new TextEncoder().encode(event))
                            }
                        }
                    }
                }
            } finally {
                if (buffer.trim()) {
                    const result = processLine(buffer.slice(6), textBlockIndex, toolUseBlockIndex)
                    if (result) {
                        if (result.outputTokens) {
                            totalOutputTokens = result.outputTokens
                        }

                        for (const event of result.events) {
                            controller.enqueue(new TextEncoder().encode(event))
                        }
                    }
                }
                reader.releaseLock()

                // 计算和发送usage信息
                let usage: { input_tokens: number; output_tokens: number } | undefined
                if (originalClaudeRequest && tokenEstimator) {
                    const inputTokens = tokenEstimator.estimateMessages(originalClaudeRequest.messages)
                    usage = {
                        input_tokens: inputTokens,
                        output_tokens: totalOutputTokens
                    }
                }

                sendMessageStop(controller, usage)
                controller.close()
            }
        }
    })

    return new Response(stream, {
        status: providerResponse.status,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    })
}

export function cleanJsonSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
        return schema
    }

    const cleaned = { ...schema }

    for (const key in cleaned) {
        if (key === '$schema' || key === 'additionalProperties' || key === 'title' || key === 'examples') {
            delete cleaned[key]
        } else if (key === 'enum' && Array.isArray(cleaned[key])) {
            cleaned[key] = cleaned[key]
        } else if (key === 'format' && cleaned.type === 'string') {
            delete cleaned[key]
        } else if (key === 'properties' && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (key === 'items' && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (typeof cleaned[key] === 'object' && !Array.isArray(cleaned[key])) {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        }
    }

    return cleaned
}

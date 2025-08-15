import * as types from './types'
import * as provider from './provider'
import * as utils from './utils'

export class impl implements provider.Provider {
    private tokenEstimator = new utils.OptimizedTokenEstimator()

    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const openaiRequest = this.convertToOpenAIRequestBody(claudeRequest)

        const finalUrl = utils.buildUrl(baseUrl, 'chat/completions')

        const headers = new Headers(request.headers)
        headers.set('Authorization', `Bearer ${apiKey}`)
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest)
        })
    }

    async convertToClaudeResponse(
        openaiResponse: Response,
        originalClaudeRequest?: types.ClaudeRequest
    ): Promise<Response> {
        if (!openaiResponse.ok) {
            return openaiResponse
        }

        const contentType = openaiResponse.headers.get('content-type') || ''
        const isStream = contentType.includes('text/event-stream')

        if (isStream) {
            return this.convertStreamResponse(openaiResponse, originalClaudeRequest)
        } else {
            return this.convertNormalResponse(openaiResponse, originalClaudeRequest)
        }
    }

    private convertToOpenAIRequestBody(claudeRequest: types.ClaudeRequest): types.OpenAIRequest {
        const openaiRequest: types.OpenAIRequest = {
            model: claudeRequest.model,
            messages: this.convertMessages(claudeRequest.messages),
            stream: claudeRequest.stream
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            openaiRequest.tools = claudeRequest.tools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: utils.cleanJsonSchema(tool.input_schema)
                }
            }))
        }

        if (claudeRequest.temperature !== undefined) {
            openaiRequest.temperature = claudeRequest.temperature
        }

        if (claudeRequest.max_tokens !== undefined) {
            openaiRequest.max_tokens = claudeRequest.max_tokens
        }

        return openaiRequest
    }

    private convertMessages(claudeMessages: types.ClaudeMessage[]): types.OpenAIMessage[] {
        const openaiMessages: types.OpenAIMessage[] = []
        const toolCallMap = new Map<string, string>()

        for (const message of claudeMessages) {
            if (typeof message.content === 'string') {
                openaiMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: message.content
                })
                continue
            }

            const textContents: string[] = []
            const toolCalls: types.OpenAIToolCall[] = []
            const toolResults: Array<{ tool_call_id: string; content: string }> = []

            for (const content of message.content) {
                switch (content.type) {
                    case 'text':
                        textContents.push(content.text)
                        break
                    case 'tool_use':
                        toolCallMap.set(content.id, content.id)
                        toolCalls.push({
                            id: content.id,
                            type: 'function',
                            function: {
                                name: content.name,
                                arguments: JSON.stringify(content.input)
                            }
                        })
                        break
                    case 'tool_result':
                        toolResults.push({
                            tool_call_id: content.tool_use_id,
                            content:
                                typeof content.content === 'string' ? content.content : JSON.stringify(content.content)
                        })
                        break
                }
            }

            if (textContents.length > 0 || toolCalls.length > 0) {
                const openaiMessage: types.OpenAIMessage = {
                    role: message.role === 'assistant' ? 'assistant' : 'user'
                }

                if (textContents.length > 0) {
                    openaiMessage.content = textContents.join('\n')
                }

                if (toolCalls.length > 0) {
                    openaiMessage.tool_calls = toolCalls
                }

                openaiMessages.push(openaiMessage)
            }

            for (const toolResult of toolResults) {
                openaiMessages.push({
                    role: 'tool',
                    tool_call_id: toolResult.tool_call_id,
                    content: toolResult.content
                })
            }
        }

        return openaiMessages
    }

    private async convertNormalResponse(
        openaiResponse: Response,
        originalClaudeRequest?: types.ClaudeRequest
    ): Promise<Response> {
        const openaiData = (await openaiResponse.json()) as types.OpenAIResponse

        const claudeResponse: types.ClaudeResponse = {
            id: utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: []
        }

        if (openaiData.choices && openaiData.choices.length > 0) {
            const choice = openaiData.choices[0]
            const message = choice.message

            if (message.content) {
                claudeResponse.content.push({
                    type: 'text',
                    text: message.content
                })
            }

            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    claudeResponse.content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: utils.safeJsonParse(toolCall.function.arguments)
                    })
                }
                claudeResponse.stop_reason = 'tool_use'
            } else if (choice.finish_reason === 'length') {
                claudeResponse.stop_reason = 'max_tokens'
            } else {
                claudeResponse.stop_reason = 'end_turn'
            }
        }

        // 使用API返回的真实usage，或fallback到估算值
        let inputTokens = openaiData.usage?.prompt_tokens || 0
        let outputTokens = openaiData.usage?.completion_tokens || 0

        // 如果API未返回usage且我们有原始请求，使用估算
        if (!openaiData.usage && originalClaudeRequest) {
            inputTokens = this.tokenEstimator.estimateMessages(originalClaudeRequest.messages)
            outputTokens = this.tokenEstimator.estimateClaudeContent(claudeResponse.content)
        } else if (!openaiData.usage?.completion_tokens && claudeResponse.content.length > 0) {
            // 如果只缺输出tokens，估算输出部分
            outputTokens = this.tokenEstimator.estimateClaudeContent(claudeResponse.content)
        }

        claudeResponse.usage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens
        }

        return new Response(JSON.stringify(claudeResponse), {
            status: openaiResponse.status,
            headers: {
                'Content-Type': 'application/json'
            }
        })
    }

    private async convertStreamResponse(
        openaiResponse: Response,
        originalClaudeRequest?: types.ClaudeRequest
    ): Promise<Response> {
        let accumulatedOutputTokens = 0

        return utils.processProviderStream(
            openaiResponse,
            (jsonStr, textBlockIndex, toolUseBlockIndex) => {
                const openaiData = JSON.parse(jsonStr) as types.OpenAIStreamResponse
                if (!openaiData.choices || openaiData.choices.length === 0) {
                    return null
                }

                const choice = openaiData.choices[0]
                const delta = choice.delta
                const events: string[] = []
                let currentTextIndex = textBlockIndex
                let currentToolIndex = toolUseBlockIndex

                if (delta.content) {
                    events.push(...utils.processTextPart(delta.content, currentTextIndex))
                    currentTextIndex++

                    // 累积输出tokens
                    accumulatedOutputTokens += this.tokenEstimator.estimate(delta.content)
                }

                if (delta.tool_calls) {
                    for (const toolCall of delta.tool_calls) {
                        if (toolCall.function?.name && toolCall.function?.arguments) {
                            const toolArgs = utils.safeJsonParse(toolCall.function.arguments)

                            events.push(
                                ...utils.processToolUsePart(
                                    {
                                        name: toolCall.function.name,
                                        args: toolArgs
                                    },
                                    currentToolIndex
                                )
                            )
                            currentToolIndex++

                            // 累积工具调用的tokens
                            accumulatedOutputTokens += this.tokenEstimator.estimate(toolCall.function.name)
                            accumulatedOutputTokens += this.tokenEstimator.estimate(JSON.stringify(toolArgs))
                        }
                    }
                }

                return {
                    events,
                    textBlockIndex: currentTextIndex,
                    toolUseBlockIndex: currentToolIndex,
                    outputTokens: accumulatedOutputTokens // 返回累积的输出tokens
                }
            },
            originalClaudeRequest, // 传递原始请求用于计算input tokens
            this.tokenEstimator // 传递token估算器
        )
    }
}

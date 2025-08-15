import * as types from './types'

export interface Provider {
    convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request>
    convertToClaudeResponse(providerResponse: Response, originalClaudeRequest?: types.ClaudeRequest): Promise<Response>
}

/**
 * `POST /api/rpc/:method` (Phase 3 chunk E) — one generic route for the
 * entire `IDataService` surface `rpc-contract.ts` declares. Adding a
 * server-exposed method is "add an entry to `rpcContract`," never "write
 * a new route handler" — this file never grows.
 */
import type { FastifyInstance } from 'fastify'
import { isRpcMethodName, invokeRpcMethod } from '../../src/shared/rpc-contract'
import type { IDataService } from '../../src/main/services/data-service'

export function registerRpcRoutes(app: FastifyInstance, dataService: IDataService): void {
  app.post('/api/rpc/:method', async (request, reply) => {
    const { method } = request.params as { method: string }
    if (!isRpcMethodName(method)) {
      reply.code(404)
      return { error: `Unknown RPC method: "${method}"` }
    }

    try {
      return await invokeRpcMethod(dataService, method, request.body ?? {})
    } catch (error) {
      // A zod validation failure (bad request shape) vs. a genuine
      // IDataService error (e.g. "Unknown client code") both land here —
      // neither should ever crash the process (plan §7-adjacent
      // expectation: the server stays up for every other client). 400 is
      // the honest status for "the request or the operation was invalid"
      // when nothing more specific applies.
      reply.code(400)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
}

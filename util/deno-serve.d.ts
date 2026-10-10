// util/deno-serve.d.ts — temporary ambient declaration.
//
// main.ts still calls the global serve API until Phase 2 swaps it for
// @hono/node-server, so `tsc --noEmit` (which only loads @types/node)
// needs to know about that one global. Removed in Phase 2.

declare namespace Deno {
  function serve(
    options: { port: number; hostname: string },
    handler: (req: Request) => Response | Promise<Response>,
  ): unknown;
}

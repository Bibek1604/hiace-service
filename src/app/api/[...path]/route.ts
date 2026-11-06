import { handle } from '@/lib/http';
import { classifyError } from '@/lib/api-error';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function route(req: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    return await handle(req, (await context.params).path);
  } catch (error) {
    // handle() reports its own failures; this only guards against faults outside it.
    const c = classifyError(error);
    return Response.json({ error: c.message }, { status: c.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
export { route as GET, route as POST, route as PATCH, route as DELETE };

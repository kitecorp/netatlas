import { healthBody } from '@/server/health';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const body = healthBody(getStore());
  return Response.json(body, { status: body.status === 'ok' ? 200 : 503 });
}

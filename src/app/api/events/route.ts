import { eventsResponse } from '@/server/events';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return eventsResponse(getStore(), request.url, request.signal);
}

import { applyResponse, type ApplyDeps } from '@/server/apply';
import { kubeConfigWithToken } from '@/server/logins/kubeconfig';
import { replacePolicy } from '@/server/replace-policy';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';

const deps: ApplyDeps = {
  cluster: (name) => getStore()?.clusters.get(name),
  replace: (c, token, body) => replacePolicy(kubeConfigWithToken(c, token), body),
  // The one line Apply logs names the policy and the status; the body, with its token, never reaches a log.
  log: (line) => console.log(line),
};

/**
 * Apply: replaces one NetworkPolicy with the person's own token. Next.js answers 405 to every other
 * method but OPTIONS, which it answers itself with 204, an `Allow` header and no CORS headers
 * (next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js). So a cross-site PUT
 * never passes its preflight, which is what keeps other sites from reaching Apply.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ cluster: string; namespace: string; name: string }> }): Promise<Response> {
  return applyResponse(request, await ctx.params, deps);
}

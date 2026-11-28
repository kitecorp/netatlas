'use client';

import { useRouter } from 'next/navigation';

/**
 * Writes one parameter of the page's URL (or removes it, given undefined) and keeps the others, with
 * `router.replace`: the server renders the page again from the URL, a link keeps the choice, and the
 * history gains no entry per toggle.
 */
export function useReplaceParam(): (key: string, value: string | undefined) => void {
  const router = useRouter();
  return (key, value) => {
    const params = new URLSearchParams(window.location.search);
    if (value === undefined) params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.replace(query ? `?${query}` : window.location.pathname, { scroll: false });
  };
}

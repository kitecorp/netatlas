'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { LinkPicker, type PickerChoice } from './LinkPicker';
import { LiveStatus, type LiveProps } from './LiveStatus';

/** Typing waits this long for the next key before the page asks the server again. */
const SEARCH_WAIT_MS = 250;

export interface HeaderProps {
  readonly title: string;
  readonly cluster: string;
  readonly choices: readonly PickerChoice[];
  /** Absent on the editor, which has no search. */
  readonly search?: { readonly value: string; readonly placeholder: string };
  readonly live: LiveProps;
  /** Controls after the cluster picker, such as the editor's policy picker. */
  readonly children?: ReactNode;
}

/**
 * The page's title, the cluster picker, the search and the live status. The search is the `q`
 * parameter of the URL, so the server filters what it renders and a link keeps it; the other
 * parameters stay as they are.
 */
export function Header({ title, cluster, choices, search, live, children }: HeaderProps) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onSearch = (value: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (value.trim()) params.set('q', value.trim());
      else params.delete('q');
      const query = params.toString();
      router.replace(query ? `?${query}` : window.location.pathname, { scroll: false });
    }, SEARCH_WAIT_MS);
  };
  return (
    <header className="header">
      <h1 className="header-title">{title}</h1>
      <LinkPicker
        summary={
          <>
            Cluster: <b className={cluster === 'All clusters' ? undefined : 'mono'}>{cluster}</b>
          </>
        }
        menu="Clusters"
        choices={choices}
      />
      {children}
      {search ? (
        <label className="search">
          Search <input type="search" defaultValue={search.value} placeholder={search.placeholder} onChange={(e) => onSearch(e.target.value)} />
        </label>
      ) : (
        <div className="header-gap" />
      )}
      <LiveStatus {...live} />
    </header>
  );
}

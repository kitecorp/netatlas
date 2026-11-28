import { getStore } from '@/server/store';
import { frameOf } from '@/server/views';
import { Frame, type FrameProps } from './Frame';
import type { View } from './Nav';

export interface ChooseClusterProps {
  readonly view: View;
  readonly title: string;
  /** What the page asks for, such as `Choose a cluster to see its map.` */
  readonly ask: string;
  readonly search?: FrameProps['search'];
  readonly renderedAt: string;
}

/** The page of a view that shows one cluster at a time, with All clusters chosen: it asks for one, linking each. */
export function ChooseCluster({ view, title, ask, search, renderedAt }: ChooseClusterProps) {
  const { names } = frameOf(getStore());
  return (
    <Frame view={view} title={title} {...(search ? { search } : {})} renderedAt={renderedAt}>
      <main className="page">
        <p>{ask}</p>
        <ul className="plain-list">
          {names.map((name) => (
            <li key={name}>
              <a className="mono" href={`/${view}/${encodeURIComponent(name)}`}>
                {name}
              </a>
            </li>
          ))}
        </ul>
      </main>
    </Frame>
  );
}

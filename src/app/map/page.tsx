import { Frame } from '@/components/frame/Frame';
import { getStore } from '@/server/store';
import { frameOf } from '@/server/views';

export const dynamic = 'force-dynamic';

/** The map shows one cluster at a time, so with All clusters chosen it asks for one. */
export default async function MapIndex() {
  const { names } = frameOf(getStore());
  return (
    <Frame view="map" title="Policy map" search={{ value: '', placeholder: 'workload or policy' }} renderedAt={new Date().toISOString()}>
      <main className="page">
        <p>Choose a cluster to see its map.</p>
        <ul className="plain-list">
          {names.map((name) => (
            <li key={name}>
              <a className="mono" href={`/map/${encodeURIComponent(name)}`}>
                {name}
              </a>
            </li>
          ))}
        </ul>
      </main>
    </Frame>
  );
}

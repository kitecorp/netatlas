import type { OutboundKind } from '@/model/outbound';

/** The kinds whose destination is a name, a host or an address range; the others are sentences. */
const NAMED: ReadonlySet<OutboundKind> = new Set(['named', 'seen', 'address-range']);

/** A destination as the Outbound table and the Internet panel both set it: a name in the monospace face, a sentence in the body face. */
export function Destination({ kind, text }: { kind: OutboundKind; text: string }) {
  return <span className={NAMED.has(kind) ? 'mono destination' : 'destination'}>{text}</span>;
}

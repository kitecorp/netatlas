import { describe, expect, it } from 'vitest';
import { podClasses } from './classes';
import { SHOP } from './fixtures/shop';
import { ALL, EACH_DESTINATION, formatPorts, intersect, NONE, portsOfRule, union, type PortSet } from './ports';
import type { PolicyPort } from './types';

// A function, so that a failure to build the class shows on each test rather than on loading the file.
const cart = () => podClasses(SHOP.pods.filter((p) => p.workload.name === 'cart'))[0];

describe('portsOfRule', () => {
  it.each<[string, readonly PolicyPort[] | undefined, string]>([
    ['no ports at all', undefined, 'every port'],
    ['an empty list', [], 'every port'],
    ['a port number', [{ port: 8080 }], 'TCP 8080'],
    ['a named port, resolved on the destination', [{ port: 'http' }], 'TCP 8080'],
    ['a named port on a protocol the destination does not serve it on', [{ protocol: 'UDP', port: 'http' }], ''],
    ['a name the destination does not have', [{ port: 'grpc' }], ''],
    ['a range up to endPort', [{ port: 8000, endPort: 8080 }], 'TCP 8000-8080'],
    ['a protocol alone', [{ protocol: 'UDP' }], 'every UDP port'],
    ['UDP and TCP on one port', [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }], 'UDP 53, TCP 53'],
  ])('portsOfRule %#: %s', (_name, ports, expected) => {
    expect(formatPorts(portsOfRule(ports, cart()))).toBe(expected);
  });

  it.each<[string, typeof EACH_DESTINATION | undefined, readonly PolicyPort[], string]>([
    ['an address outside the cluster has no port names, so a name resolves to nothing', undefined, [{ port: 'http' }], ''],
    ['a rule with no peers keeps the name, which each destination resolves', EACH_DESTINATION, [{ protocol: 'UDP', port: 'dns' }], 'UDP port named dns'],
    ['a name with no protocol is TCP', EACH_DESTINATION, [{ port: 'http' }], 'TCP port named http'],
    [
      'names follow the numbered ports of their protocol',
      EACH_DESTINATION,
      [{ protocol: 'TCP', port: 53 }, { protocol: 'UDP', port: 'dns' }, { protocol: 'UDP', port: 53 }],
      'TCP 53, UDP 53, UDP port named dns',
    ],
  ])('portsOfRule without a destination pod %#: %s', (_name, dst, ports, expected) => {
    expect(formatPorts(portsOfRule(ports, dst))).toBe(expected);
  });
});

describe('port sets', () => {
  it.each<[string, PortSet, PortSet, PortSet]>([
    ['a range with one port in it', [{ protocol: 'TCP', from: 8000, to: 8080 }], [{ protocol: 'TCP', from: 8080, to: 8080 }], [{ protocol: 'TCP', from: 8080, to: 8080 }]],
    ['the same port on two protocols', [{ protocol: 'TCP', from: 53, to: 53 }], [{ protocol: 'UDP', from: 53, to: 53 }], []],
    ['every port with a set', ALL, [{ protocol: 'UDP', from: 53, to: 53 }], [{ protocol: 'UDP', from: 53, to: 53 }]],
    ['a set with nothing', [{ protocol: 'TCP', from: 1, to: 65535 }], NONE, []],
    ['the same named port', [{ protocol: 'UDP', name: 'dns' }], [{ protocol: 'UDP', name: 'dns' }, { protocol: 'TCP', from: 53, to: 53 }], [{ protocol: 'UDP', name: 'dns' }]],
    ['a named port with numbered ones, which only a destination pod could compare', [{ protocol: 'UDP', name: 'dns' }], [{ protocol: 'UDP', from: 53, to: 53 }], []],
  ])('intersect %#: %s', (_name, a, b, expected) => {
    expect(intersect(a, b)).toEqual(expected);
  });

  it.each<[string, PortSet, PortSet, PortSet]>([
    ['adjacent ranges join', [{ protocol: 'TCP', from: 8000, to: 8080 }], [{ protocol: 'TCP', from: 8081, to: 9000 }], [{ protocol: 'TCP', from: 8000, to: 9000 }]],
    ['a port inside a range adds nothing', [{ protocol: 'TCP', from: 8000, to: 8080 }], [{ protocol: 'TCP', from: 8040, to: 8040 }], [{ protocol: 'TCP', from: 8000, to: 8080 }]],
    ['protocols stay apart, in the order they came', [{ protocol: 'UDP', from: 53, to: 53 }], [{ protocol: 'TCP', from: 53, to: 53 }], [{ protocol: 'UDP', from: 53, to: 53 }, { protocol: 'TCP', from: 53, to: 53 }]],
    ['every port absorbs a set', [{ protocol: 'TCP', from: 53, to: 53 }], ALL, 'all'],
    ['a named port comes once', [{ protocol: 'UDP', name: 'dns' }], [{ protocol: 'UDP', name: 'dns' }], [{ protocol: 'UDP', name: 'dns' }]],
    ['every port of a protocol absorbs its named ports', [{ protocol: 'UDP', name: 'dns' }], [{ protocol: 'UDP', from: 1, to: 65535 }], [{ protocol: 'UDP', from: 1, to: 65535 }]],
    ['every port of every protocol is every port', [{ protocol: 'TCP', from: 1, to: 65535 }, { protocol: 'UDP', from: 1, to: 65535 }], [{ protocol: 'SCTP', from: 1, to: 65535 }], 'all'],
  ])('union %#: %s', (_name, a, b, expected) => {
    expect(union(a, b)).toEqual(expected);
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- Node address classification and pinned DNS resolution.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

const LOCAL_ADDRESSES = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// Block IPv4-carrying IPv6 ranges that translators may route without checking.
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

// Clash and Mihomo fake-IP DNS answers from here, inside the blocked 198.18.0.0/15.
const FAKE_IP = new NodeNet.BlockList();
FAKE_IP.addSubnet("198.18.0.0", 15, "ipv4");
const MAX_FAKE_IP_HOSTS = 3;

const NAT64 = new NodeNet.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");
const SIX_TO_FOUR = new NodeNet.BlockList();
SIX_TO_FOUR.addSubnet("2002::", 16, "ipv6");

const ipv6Groups = (address: string) => {
  const bare = address.split("%", 1)[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = dotted
    ? `${bare.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : bare;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

// Check the translated IPv4 too, while allowing public NAT64 targets on IPv6-only networks.
const embeddedIPv4 = (address: string) => {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

const ownAddresses = () => {
  const own = new NodeNet.BlockList();
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (entry) own.addAddress(entry.address, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
};

const isLocal = (address: string, family: number): boolean => {
  const type = family === 6 ? "ipv6" : "ipv4";
  if (LOCAL_ADDRESSES.check(address, type) || ownAddresses().check(address, type)) return true;
  const embedded = family === 6 ? embeddedIPv4(address) : undefined;
  return embedded !== undefined && isLocal(embedded, 4);
};

// Connect only to checked addresses to prevent DNS rebinding.
export const publicAddresses = async (host: string, fakeIpHosts?: Map<string, string>) => {
  const addresses = NodeNet.isIP(host)
    ? [{ address: host, family: NodeNet.isIP(host) }]
    : await NodeDnsPromises.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) return undefined;
  const local = addresses.some(({ address, family }) => isLocal(address, family));
  if (!local) return addresses;
  const fake =
    !NodeNet.isIP(host) &&
    addresses.every(({ address, family }) => family === 4 && FAKE_IP.check(address, "ipv4"));
  if (fake && fakeIpHosts && fakeIpHosts.size < MAX_FAKE_IP_HOSTS && !fakeIpHosts.has(host)) {
    fakeIpHosts.set(host, addresses[0]!.address);
  }
  return undefined;
};

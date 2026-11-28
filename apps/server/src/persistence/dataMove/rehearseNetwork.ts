import { PreflightRefusal } from "./preflight.ts";

export function rehearsalNetworkFilter(architecture: string) {
  // seccomp_data: nr@0, arch@4, args[0]@16. Reject compat/x32 syscall ABIs too.
  const abi =
    architecture === "x64"
      ? [0xc000003e, 41, 53]
      : architecture === "arm64"
        ? [0xc00000b7, 198, 199]
        : undefined;
  if (!abi) throw new PreflightRefusal({ category: "unsupported-seccomp-architecture" });
  const [arch, socket, socketpair] = abi;
  const deny = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
  const allow = 0x7fff0000;
  const rules = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, arch!],
    [0x06, 0, 0, deny],
    [0x20, 0, 0, 0],
    [0x35, 0, 1, 0x40000000],
    [0x06, 0, 0, deny],
    // io_uring can create sockets without passing through socket(2).
    [0x15, 0, 1, 425],
    [0x06, 0, 0, deny],
    [0x15, 2, 0, socket!],
    [0x15, 1, 0, socketpair!],
    [0x06, 0, 0, allow],
    [0x20, 0, 0, 16],
    // Route netlink is namespace-local too, and Node uses it for networkInterfaces.
    [0x15, 7, 0, 1],
    [0x15, 6, 0, 2],
    [0x15, 5, 0, 10],
    [0x15, 1, 0, 16],
    [0x06, 0, 0, deny],
    [0x20, 0, 0, 32],
    [0x15, 1, 0, 0],
    [0x06, 0, 0, deny],
    [0x06, 0, 0, allow],
  ];
  const buffer = Buffer.alloc(rules.length * 8);
  rules.forEach(([code, yes, no, value], index) => {
    buffer.writeUInt16LE(code!, index * 8);
    buffer[index * 8 + 2] = yes!;
    buffer[index * 8 + 3] = no!;
    buffer.writeUInt32LE(value!, index * 8 + 4);
  });
  return buffer;
}

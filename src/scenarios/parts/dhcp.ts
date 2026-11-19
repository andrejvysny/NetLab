/** DHCP: one server (R1) with pools for both LANs, an exclusion in LAN1 and a relay on R2. Owned by the scenario agent. */
import type { TraceStep } from '../../engine/types.ts';
import { inSubnet, intToIp, ipToInt, networkOf } from '../../engine/ip.ts';
import { isPc } from '../../engine/world.ts';
import { dhcpAcquire, dhcpRelease } from '../../engine/sim/index.ts';
import type { CheckDef, ReqDef } from '../checks.ts';
import { bad, missing, ok, reqPasses } from '../checks.ts';
import { probeWorld, type Env } from '../env.ts';
import type { Spec } from '../spec.ts';
import { host, maskOf, model, renewCommand } from '../spec.ts';
import type { Built } from './common.ts';
import { block, cfgAction, emptyBuilt, ownerOf } from './common.ts';

interface Lease { ok: boolean; address?: string; mask?: string; gateway?: string; server?: string; reasonText?: string; steps: TraceStep[] }

/** What a fresh DHCP request of this PC would get right now (tried on a copy of the world). */
function freshLease(env: Env, pcId: string): Lease {
  return env.memo(`lease:${pcId}`, () => {
    const w = probeWorld(env.world);
    const pc = w.devices[pcId];
    if (!isPc(pc)) return { ok: false, reasonText: `${pcId} is not on the bench.`, steps: [] };
    if (pc.nic.mode !== 'dhcp') return { ok: false, reasonText: `${pcId} is set to a static address, so it does not ask a DHCP server.`, steps: [] };
    dhcpRelease(w, pcId);
    return dhcpAcquire(w, pcId);
  });
}

export function dhcpConfig(s: Spec): Record<string, string[]> {
  const m = model(s);
  const a = s.addr;
  const n = s.dhcp?.excludeFirst ?? 1;
  return {
    R1: [
      `ip dhcp excluded-address ${host(a.lan1, 1)}${n > 1 ? ` ${host(a.lan1, n)}` : ''}`,
      ...block('ip dhcp pool LAN1', [`network ${a.lan1.net} ${maskOf(a.lan1)}`, `default-router ${m.r1Lan}`]),
      ...block('ip dhcp pool LAN2', [`network ${a.lan2.net} ${maskOf(a.lan2)}`, `default-router ${m.r2Lan}`]),
    ],
    R2: block(`interface ${s.ports.r2Lan}`, [`ip helper-address ${m.r1Wan}`]),
  };
}

const RENEW = 'Renew the DHCP lease in the PC network settings. On R1 look at show ip dhcp binding and show running-config | section dhcp.';

export function dhcpPart(s: Spec): Built {
  const b = emptyBuilt('dhcp');
  const n = s.dhcp?.excludeFirst ?? 1;
  b.config = dhcpConfig(s);

  const leaseCheck = (pcId: 'PC2' | 'PC3', lanName: string, gwOf: (e: Env) => { address: string; mask: string } | undefined, tipExtra: string): CheckDef => ({
    id: pcId.toLowerCase(), label: `${pcId} gets its address from DHCP`,
    run(env) {
      const expected = `${pcId} is set to DHCP. It holds an address in ${lanName}, with the router of ${lanName} as default gateway.`;
      const pc = env.pc(pcId);
      if (!pc) return missing(expected, `${pcId} is not on the bench.`, '');
      if (pc.nic.mode !== 'dhcp') return bad(expected, `${pcId} is set to a static address.`, `Set ${pcId} to DHCP ("obtain an address automatically").`);
      const fresh = freshLease(env, pcId);
      const tip = `${RENEW} ${tipExtra}`;
      if (!pc.nic.address) {
        return fresh.ok
          ? bad(expected, `${pcId} has no address yet. A DHCP server would answer now.`, `On ${pcId} run ${renewCommand(pcId)}.`, fresh.steps)
          : bad(expected, `${pcId} has no address. ${fresh.reasonText ?? ''}`.trim(), tip, fresh.steps);
      }
      const gw = gwOf(env);
      const seen = `${pcId} has ${pc.nic.address}, mask ${pc.nic.mask ?? '?'}, gateway ${pc.nic.gateway ?? 'none'}.`;
      if (!gw) return missing(expected, `${seen} The router's LAN interface has no address yet.`, tip);
      if (!pc.nic.mask || !inSubnet(pc.nic.address, gw.address, gw.mask) || pc.nic.mask !== gw.mask) {
        return bad(expected, `${seen} That does not fit ${lanName} (${networkOf(gw.address, gw.mask)}, mask ${gw.mask}).`, 'Check the network line of the DHCP pool. Then renew the lease on the PC.', fresh.steps);
      }
      if (pc.nic.gateway !== gw.address) {
        return bad(expected, `${seen} The gateway should be ${gw.address}.`, 'Check the default-router line of the DHCP pool. Then renew the lease on the PC.', fresh.steps);
      }
      if (!fresh.ok) return bad(expected, `${seen} A new request would fail now: ${fresh.reasonText ?? 'no answer.'}`, tip, fresh.steps);
      if (fresh.gateway !== gw.address || fresh.mask !== gw.mask || !fresh.address || !inSubnet(fresh.address, gw.address, gw.mask)) {
        return bad(expected, `${seen} But a new lease would be ${fresh.address ?? '?'}, mask ${fresh.mask ?? '?'}, gateway ${fresh.gateway ?? 'none'}.`,
          'Check the network and default-router lines of the DHCP pool. Then renew the lease on the PC.', fresh.steps);
      }
      return ok(expected, seen, fresh.steps);
    },
  });
  const pc2 = leaseCheck('PC2', 'LAN1', (e) => e.a.r1Lan, '');
  const pc3 = leaseCheck('PC3', 'LAN2', (e) => e.a.r2Lan, 'With the example’s DHCP server on R1, PC3’s broadcast needs ip helper-address on R2’s LAN interface.');
  const exclusion: CheckDef = {
    id: 'exclusion', label: `LAN1: the first ${n} usable addresses are never leased`, needs: ['pc2'],
    run(env) {
      const expected = `A DHCP client in LAN1 gets an address after the first ${n} usable addresses (host number ${n + 1} or higher).`;
      const gw = env.a.r1Lan;
      const pc = env.pc('PC2');
      const fresh = freshLease(env, 'PC2');
      if (!gw || !pc?.nic.address || !fresh.address) return missing(expected, 'PC2 has no lease to look at yet.', RENEW);
      const net = ipToInt(networkOf(gw.address, gw.mask));
      const now = ipToInt(pc.nic.address) - net;
      const next = ipToInt(fresh.address) - net;
      const tip = `Exclude the whole range on the server: ip dhcp excluded-address <first address> <address number ${n}>. Then renew the lease on PC2.`;
      if (next <= n) return bad(expected, `A new client would get ${fresh.address} (host number ${next}).`, tip, fresh.steps);
      // A lease at .101 alone does not prove that every address below it was protected (e.g. a conflict or binding can hide a hole).
      const serverId = ownerOf(env, fresh.server);
      const server = serverId ? env.world.devices[serverId] : undefined;
      if (!server || server.kind === 'pc') return bad(expected, 'The DHCP server could not be identified.', tip, fresh.steps);
      const exclusions = server.config.dhcp.excluded.map((x) => [ipToInt(x.low), ipToInt(x.high)]);
      const hole = Array.from({ length: n }, (_, i) => net + 1 + i)
        // An address owned by the DHCP server is never offered, even without an explicit exclusion.
        .find((ip) => !exclusions.some(([low, high]) => ip >= low && ip <= high)
          && ownerOf(env, intToIp(ip)) !== serverId);
      if (hole !== undefined) return bad(expected, `${intToIp(hole)} is not excluded by the DHCP server.`, tip, fresh.steps);
      if (now <= n) return bad(expected, `PC2 still holds ${pc.nic.address} (host number ${now}).`, 'Run ipconfig /renew on PC2 so it gets an address from the allowed range.', fresh.steps);
      return ok(expected, `PC2 holds ${pc.nic.address}. A new client would get ${fresh.address}.`, fresh.steps);
    },
  };
  // The 2026 sheet asks for one server and leaves the choice to the student. The focused lab names R1.
  const requireR1 = s.style === 'lab';
  const oneServer: CheckDef = {
    id: 'one-server', label: requireR1 ? 'Only R1 is a DHCP server' : 'Both PCs lease from the same sole DHCP router', needs: ['pc2'],
    run(env) {
      const expected = requireR1 ? 'R1 is the only DHCP server. PC2 and PC3 both get their lease from R1.'
        : 'One router is the DHCP server for both LANs. The other only relays.';
      const pools = (dev: typeof env.r1): number => dev?.config.dhcp.pools.length ?? 0;
      const from = (pcId: string): string | undefined => ownerOf(env, env.pc(pcId)?.nic.dhcpServer);
      const seen = `R1 has ${pools(env.r1)} DHCP pools, R2 has ${pools(env.r2)}. PC2's lease comes from ${from('PC2') ?? 'nobody'}, PC3's from ${from('PC3') ?? 'nobody'}.`;
      const tip = requireR1 ? 'Use R1 for both pools and point the helper on the R2 LAN interface to R1.'
        : 'Use one DHCP router for both pools and put the helper where the other LAN’s broadcasts arrive. The guide uses R1, keeping the relay on the public side of NAT.';
      const servers = [env.r1, env.r2].filter((dev) => pools(dev) > 0);
      const serverId = servers[0]?.id;
      if (servers.length !== 1 || (requireR1 && serverId !== 'R1')) return bad(expected, seen, tip);
      if (['PC2', 'PC3'].some((id) => from(id) !== serverId || ownerOf(env, freshLease(env, id).server) !== serverId)) return bad(expected, seen, tip);
      return ok(expected, seen);
    },
  };
  const pc1: CheckDef = {
    id: 'pc1-static', label: 'PC1 keeps a static address', needs: ['pc2'],
    run(env) {
      const expected = 'PC1 is set to a static address.';
      const pc = env.pc('PC1');
      if (!pc) return missing(expected, 'PC1 is not on the bench.', '');
      return pc.nic.mode === 'static' && pc.nic.address
        ? ok(expected, `PC1 has the static address ${pc.nic.address}.`)
        : bad(expected, 'PC1 is set to DHCP.', 'Open PC1 and enter its address, mask and gateway by hand.');
    },
  };
  const req: ReqDef = {
    id: 'dhcp', title: `DHCP: PC2 and PC3 get leases from one server, the first ${n} LAN1 addresses stay free`, feature: 'dhcp', points: 4,
    checks: [pc2, exclusion, pc3, oneServer, pc1],
  };
  b.requirements = [req];
  b.steps = [{
    id: 'dhcp', title: 'DHCP server on R1, relay on R2', feature: 'dhcp', devices: ['R1', 'R2', 'PC2', 'PC3'],
    goal: `Make R1 the DHCP server for both LANs, without the first ${n} usable LAN1 addresses, and let R2 pass the requests of LAN2 on to R1. Then renew the leases on PC2 and PC3.`,
    why: 'Only one router may be the server. A DHCP request is a broadcast, and a broadcast does not cross a router without help.',
    hint: 'The exclusion is a global command on the server. The relay is one line on the R2 interface that hears the request of PC3. It points to the WAN address of R1.',
    allows: ['dhcp', 'pc', 'interface', 'console'],
    script: [
      cfgAction('R1', b.config.R1),
      cfgAction('R2', b.config.R2),
      { kind: 'pc', pcId: 'PC2', setup: { mode: 'dhcp' } },
      { kind: 'renew', pcId: 'PC2' },
      { kind: 'pc', pcId: 'PC3', setup: { mode: 'dhcp' } },
      { kind: 'renew', pcId: 'PC3' },
      { kind: 'note', text: 'Check: ipconfig on PC2, ifconfig en0 on PC3. On R1: show ip dhcp binding.' },
    ],
    done: (env) => reqPasses(env, req),
  }];
  return b;
}

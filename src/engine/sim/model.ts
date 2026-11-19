/**
 * Simulation engine — module-private types shared by the sim files, plus the public result types
 * that are missing from src/engine/types.ts (RouteEntry, SimFlowResult, VtyDecision, QosPlan …).
 */
import type {
  Ace, Cable, Delivery, FlowResult, Packet, PortRef, TraceStep, VtyRange, World,
} from '../types.ts';

// ───────────────────────────── Public result types ─────────────────────────────

/** One line of `show ip route`. */
export interface RouteEntry {
  /** C connected, L local (the router's own address), S static, R RIP, O OSPF. */
  code: 'C' | 'L' | 'S' | 'R' | 'O';
  /** Extra code letters as IOS prints them after the code, e.g. 'E2' for an OSPF external default route. */
  codeExtra?: string;
  /** Network address, e.g. '60.50.30.0'. */
  prefix: string;
  mask: string;
  prefixLen: number;
  /** Administrative distance and metric: the `[1/0]` of show ip route. */
  distance: number;
  metric: number;
  /** Next-hop address as configured (static) or learned (RIP/OSPF). Undefined for C, L and exit-interface-only statics. */
  nextHop?: string;
  /** Interface as show ip route prints it: connected/local interface, configured exit interface, or the interface a dynamic route was learned on. */
  iface?: string;
  /** true for 0.0.0.0/0: candidate default route, printed with '*'. */
  isDefault: boolean;
  /** What forwarding really uses after recursive resolution: the exit interface and the neighbour to hand the packet to
   *  (undefined neighbour = the destination itself is on that link, or the link is point-to-point). */
  resolved: { iface: string; nextHop?: string };
  /** RIP/OSPF: device id of the router that advertised the route. */
  learnedFrom?: string;
  /** true when the entry comes from `ip default-gateway` on a device that does not route (switch, `no ip routing`). */
  fromDefaultGateway?: boolean;
}

export interface OwnAddress { address: string; mask: string; iface: string; up: boolean }

export interface LinkInfo { cabled: boolean; cable?: Cable; peer?: PortRef; usable: boolean; dce?: boolean; problem?: string }
export interface IfState { status: 'up' | 'down' | 'administratively down'; protocol: 'up' | 'down'; problem?: string }

/** What a vty line does with an incoming Telnet connection, or why TCP 22 is refused. */
export interface VtyDecision {
  /** true: the Telnet TCP connection is accepted; see `login` for what follows. false: the router refuses it. */
  accepted: boolean;
  /** Why the connection is refused. */
  reason?: 'not-ios' | 'no-vty' | 'no-free-line' | 'transport-input' | 'access-class' | 'ssh-not-modeled';
  /** One plain sentence. */
  text: string;
  /** The vty range that serves (or refuses) the connection. */
  line?: VtyRange;
  /** access-class evidence. */
  acl?: string;
  ace?: Ace;
  implicit?: boolean;
  /** What happens after the connection is accepted:
   *  'none' = no login, straight to the prompt; 'password' = asks for the line password;
   *  'password-not-set' = "Password required, but none set" and the session closes;
   *  'local' = asks for username/password; 'local-no-users' = login local without a usable user: nobody can log in. */
  login?: 'none' | 'password' | 'password-not-set' | 'local' | 'local-no-users';
}

/** FlowResult plus details the CLI, the PC prompt and the graders need. Structurally compatible with FlowResult. */
export interface SimFlowResult extends FlowResult {
  /** ok = answered; refused = the destination answered "no" (TCP reset: closed port, access-class, transport input);
   *  unreachable = an ICMP unreachable / administratively-prohibited came back; timeout = nothing came back. */
  outcome: 'ok' | 'refused' | 'unreachable' | 'timeout';
  /** Telnet/SSH to a router or switch: what the vty line decided. */
  vty?: VtyDecision;
  /** Address that sent the ICMP error when outcome is 'unreachable'. */
  unreachableFrom?: string;
  /** Source address of the answer as the sender sees it ("Reply from …"). Normally the address that was contacted. */
  repliedFrom?: string;
}

export interface QosPlanClass {
  /** Policy-map that holds the class and the class name. */
  policy: string;
  className: string;
  /** Parent class when this class sits in a nested (child) policy. */
  parentPolicy?: string;
  parentClass?: string;
  /** priority = low-latency queue (LLQ); bandwidth = guaranteed minimum (CBWFQ); fair-queue = WFQ among the flows of the class;
   *  default = no queueing command (plain FIFO, best effort). */
  treatment: 'priority' | 'bandwidth' | 'fair-queue' | 'default';
  /** Guaranteed rate for priority / bandwidth classes, kbit/s. */
  kbps?: number;
  /** `police` on the class, bit/s. */
  policeBps?: number;
  /** Plain description of what the class matches, e.g. 'access-group name matchPriority: permit icmp any any'. */
  match: string;
  /** One plain sentence describing the treatment. */
  text: string;
}
export interface QosPlan {
  /** true when an output service-policy is attached and its policy-map exists. */
  attached: boolean;
  /** Name given to `service-policy output`. */
  policy?: string;
  /** Why there is no effective output policy (or what is odd about it). */
  problem?: string;
  /** Nominal capacity for QoS Load, bit/s: DCE clock for cabled serial, modeled Ethernet speed, or interface-type default. */
  physicalBps: number;
  /** Explicit `clock rate` found on the DCE end of the serial link, bit/s. */
  clockRateBps?: number;
  /** Interface `bandwidth` (configured or platform default), kbit/s. */
  bandwidthKbps: number;
  bandwidthConfigured: boolean;
  /** Rate of the parent shaper (`shape average`), bit/s. Undefined when nothing is shaped. */
  shapedBps?: number;
  /** Class that carries the shaper, e.g. { policy: 'output_SE', className: 'class-default' }. */
  shaper?: { policy: string; className: string; text: string };
  /** Leaf classes in classification order (child classes when the policy is hierarchical). */
  classes: QosPlanClass[];
}

// ───────────────────────────── Internal ─────────────────────────────

/** Packet with simulator-private fields. Still plain JSON. */
export interface SimPacket extends Packet {
  inner?: SimPacket;
  /** ICMP errors only: the packet that caused the error, as the reporting device saw it (NAT rewrites it on the way back). */
  errFor?: Packet;
  /** ICMP unreachable code. */
  icmpCode?: 'net' | 'host' | 'port' | 'admin';
  /** TCP reset (connection refused). */
  tcpRst?: boolean;
  /** Negotiation-time test packet: "can ESP get through between the two tunnel endpoints?" */
  espProbe?: boolean;
}

/** Memo for routing tables within one API call. `dyn` holds the RIP/OSPF routes of every router (computed once). */
export interface RouteMemo { tables: Map<string, RouteEntry[]>; dyn?: Map<string, RouteEntry[]> }

export interface PendingLog { deviceId: string; severity: number; mnemonic: string; text: string }

/** State of one packet walk. */
export interface WalkState {
  delivery: Delivery;
  /** Stop recording steps (used while a packet goes round a routing loop). */
  quiet: boolean;
}

export interface WalkResult {
  delivery: Delivery;
  /** Interface on which the packet arrived at the device where it ended. */
  arrivedIface?: string;
  /** Answer the final device sends back (echo reply, SYN-ACK, reset, SNMP response). */
  reply?: SimPacket;
  /** ICMP error a device sends back to the source (unreachable, administratively prohibited, time exceeded). */
  icmpError?: SimPacket;
  /** Device that originates `reply` / `icmpError`. */
  responder?: string;
  vty?: VtyDecision;
}

/** Per-call context. Lives only for the duration of one public API call. */
export interface Ctx {
  world: World;
  /** Routing tables computed during this call (they cannot change while packets are in flight). */
  routes: RouteMemo;
  /** Interface states and broadcast domains seen during this call (cabling and shutdown cannot change meanwhile). */
  ifStates: Map<string, IfState>;
  reach: Map<string, { deviceId: string; ifName: string; hops: { switchId: string; inPort: string; outPort: string; vlan: number }[] }[]>;
  /** Log messages raised while packets were processed; sent to logging hosts when the call finishes. */
  logs: PendingLog[];
  /** Nesting depth of packet walks (IKE negotiation, DHCP conflict pings). */
  depth: number;
  /** Walk one packet from the device that creates it to wherever it ends. Set by pipeline.ts. */
  walk: (fromDeviceId: string, packet: SimPacket) => WalkResult;
  /** A fresh context on another world (a clone) — for "what if" tests that must not move any counter. */
  fork: (world: World) => Ctx;
}

export function addStep(st: WalkState, step: TraceStep): void {
  if (!st.quiet) st.delivery.steps.push(step);
}

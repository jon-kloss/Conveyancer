// Empire resource ledger aggregation — the single make/use/net truth shared by
// the map's ResourceOverview sidebar and the phone-breakpoint MobileDashboard.
// Solved group in/out rates + raw boundary supply, POWER_ITEM excluded; a
// boundary IN port not bound to an inter-factory route is new supply entering
// the empire (claimed node / assumed external feed), so raw ores don't read as
// a pure deficit — route-bound in-ports were already counted upstream.

import { POWER_ITEM } from "../state/types";
import type { Derived, GameData, Id, Plan } from "../state/types";
import { itemLabel } from "./format";

export interface Contribution {
  factory: Id;
  name: string;
  rate: number;
}

export interface LedgerRow {
  item: string;
  label: string;
  /** received raw boundary supply (a claimed node / assumed external feed) */
  raw: boolean;
  produced: number;
  consumed: number;
  net: number;
  makers: Contribution[];
  users: Contribution[];
}

export function buildLedgerRows(
  derived: Pick<Derived, "factories">,
  plan: Pick<Plan, "ports" | "factories">,
  items: GameData["items"],
): LedgerRow[] {
  const produced = new Map<string, number>();
  const consumed = new Map<string, number>();
  // per-item, per-factory contributions — the drill-down's evidence
  const makers = new Map<string, Map<Id, number>>();
  const users = new Map<string, Map<Id, number>>();
  const raw = new Set<string>();
  const add = (m: Map<string, number>, item: string, rate: number) => {
    if (!rate) return;
    m.set(item, (m.get(item) ?? 0) + rate);
  };
  const bump = (m: Map<string, Map<Id, number>>, item: string, fid: Id, rate: number) => {
    if (rate < 1e-9) return;
    let per = m.get(item);
    if (!per) {
      per = new Map();
      m.set(item, per);
    }
    per.set(fid, (per.get(fid) ?? 0) + rate);
  };
  for (const [fid, df] of Object.entries(derived.factories)) {
    for (const g of Object.values(df.groups)) {
      for (const [item, rate] of Object.entries(g.outRates)) {
        if (item === POWER_ITEM) continue;
        add(produced, item, rate);
        bump(makers, item, fid, rate);
      }
      for (const [item, rate] of Object.entries(g.inRates)) {
        if (item === POWER_ITEM) continue;
        add(consumed, item, rate);
        bump(users, item, fid, rate);
      }
    }
  }
  for (const p of Object.values(plan.ports)) {
    if (p.direction !== "in" || p.boundRoute) continue;
    const realized = derived.factories[p.factory]?.ports[p.id];
    if (realized) {
      add(produced, p.item, realized);
      bump(makers, p.item, p.factory, realized);
      raw.add(p.item);
    }
  }
  const contribs = (m: Map<string, Map<Id, number>> | undefined, item: string): Contribution[] =>
    [...(m?.get(item)?.entries() ?? [])]
      .map(([factory, rate]) => ({ factory, name: plan.factories[factory]?.name ?? "?", rate }))
      .sort((a, b) => b.rate - a.rate);
  const itemSet = new Set([...produced.keys(), ...consumed.keys()]);
  const out: LedgerRow[] = [];
  for (const item of itemSet) {
    const pr = produced.get(item) ?? 0;
    const co = consumed.get(item) ?? 0;
    if (pr < 1e-6 && co < 1e-6) continue;
    out.push({
      item,
      label: itemLabel(items, item),
      raw: raw.has(item),
      produced: pr,
      consumed: co,
      net: pr - co,
      makers: contribs(makers, item),
      users: contribs(users, item),
    });
  }
  // Busiest resources first — biggest total throughput at the top.
  out.sort((a, b) => b.produced + b.consumed - (a.produced + a.consumed));
  return out;
}

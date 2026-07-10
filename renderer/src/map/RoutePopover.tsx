// Right-drag route confirmation: pick which OUT→IN port pair the belt binds
// (auto-matched by item; can create the missing IN port on the target), plus
// the belt tier. Nothing mutates until CONFIRM.

import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import { beltCapacity, POWER_ITEM, type Command, type Id } from "../state/types";
import { fmtRate } from "../lib/format";

interface Candidate {
  key: string;
  label: string;
  outPort: Id;
  inPort: Id | null; // null = create on confirm
  item: string;
  power?: boolean; // power line joins the two factories into one circuit
}

export default function RoutePopover({
  fromFactory,
  toFactory,
  onClose,
}: {
  fromFactory: Id;
  toFactory: Id;
  onClose: () => void;
}) {
  const plan = useStore((s) => s.plan);
  const gamedata = useStore((s) => s.gamedata);
  const dispatch = useStore((s) => s.dispatch);
  const setSelection = useStore((s) => s.setSelection);
  const [tier, setTier] = useState(3);

  const candidates: Candidate[] = useMemo(() => {
    const src = plan.factories[fromFactory];
    const dst = plan.factories[toFactory];
    if (!src || !dst) return [];
    const out: Candidate[] = [];
    for (const pid of src.ports) {
      const p = plan.ports[pid];
      if (!p || p.direction !== "out" || p.boundRoute) continue;
      if (p.item === POWER_ITEM) continue; // power moves on lines, not belts
      const itemName = gamedata.items[p.item]?.displayName ?? p.item;
      const match = dst.ports
        .map((id) => plan.ports[id])
        .find((q) => q && q.direction === "in" && !q.boundRoute && q.item === p.item);
      if (match) {
        out.push({ key: `${pid}-${match.id}`, label: `${itemName}`, outPort: pid, inPort: match.id, item: p.item });
      } else {
        out.push({
          key: `${pid}-new`,
          label: `${itemName} — new IN port`,
          outPort: pid,
          inPort: null,
          item: p.item,
        });
      }
    }
    // power line: one per factory pair (the backend rejects duplicates)
    const hasLine = Object.values(plan.routes).some(
      (r) =>
        r.kind.kind === "power" &&
        ((r.endpoints[0] === fromFactory && r.endpoints[1] === toFactory) ||
          (r.endpoints[0] === toFactory && r.endpoints[1] === fromFactory)),
    );
    if (!hasLine) {
      out.push({ key: "power", label: "⚡ Power line — join grids", outPort: "", inPort: null, item: "", power: true });
    }
    return out;
  }, [plan, fromFactory, toFactory, gamedata.items]);

  const [picked, setPicked] = useState(0);

  const confirm = async () => {
    const c = candidates[picked];
    if (!c) return;
    const src = plan.factories[fromFactory]!;
    const dst = plan.factories[toFactory]!;
    const path = [src.position, dst.position];
    if (c.power) {
      const created = await dispatch([
        { type: "add_route", kind: { kind: "power" }, from: fromFactory, to: toFactory, path },
      ]);
      if (created[0]) setSelection({ kind: "route", id: created[0] });
      onClose();
      return;
    }
    if (c.inPort) {
      const created = await dispatch([
        { type: "add_route", kind: { kind: "belt", tier }, from: c.outPort, to: c.inPort, path },
      ]);
      if (created[0]) setSelection({ kind: "route", id: created[0] });
    } else {
      // create the IN port, then bind — two commands, one undo step
      const inCount = dst.ports.filter((id) => plan.ports[id]?.direction === "in").length;
      const cmds: Command[] = [
        {
          type: "add_port",
          factory: toFactory,
          direction: "in",
          item: c.item,
          rate: 0,
          rateCeiling: null,
          graphPos: { x: 0, y: 80 + inCount * 128 },
        },
      ];
      const created = await dispatch(cmds);
      const newPort = created[0];
      if (newPort) {
        const routeIds = await dispatch([
          { type: "add_route", kind: { kind: "belt", tier }, from: c.outPort, to: newPort, path },
        ]);
        if (routeIds[0]) setSelection({ kind: "route", id: routeIds[0] });
      }
    }
    onClose();
  };

  return (
    <div className="route-popover" data-testid="route-popover">
      <div className="t-label" style={{ marginBottom: 8 }}>
        DRAW ROUTE
      </div>
      {candidates.length === 0 ? (
        <div className="drawer-empty">
          No unbound OUT ports on {plan.factories[fromFactory]?.name}. Add an output port in its factory view
          first.
        </div>
      ) : (
        <>
          {candidates.map((c, i) => (
            <label className="route-cand" key={c.key}>
              <input type="radio" checked={picked === i} onChange={() => setPicked(i)} />
              <span>{c.label}</span>
            </label>
          ))}
          {!candidates[picked]?.power && (
            <div className="drawer-row" style={{ marginTop: 8 }}>
              <span className="drawer-row-name">Belt tier</span>
              <select className="mono" style={{ height: 24 }} value={tier} onChange={(e) => setTier(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((t) => (
                  <option key={t} value={t}>
                    MK.{t} — {fmtRate(beltCapacity(t))}/min
                  </option>
                ))}
              </select>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => void confirm()} data-testid="btn-route-confirm">
              CONFIRM ⏎
            </button>
            <button className="btn btn-ghost" onClick={onClose}>
              CANCEL
            </button>
          </div>
        </>
      )}
    </div>
  );
}

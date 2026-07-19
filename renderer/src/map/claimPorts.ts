// #120 — claim ⇄ port lifecycle helpers (leaflet-free: unit-testable in node).

/** Claim-shaped in-ports of one item that no LIVE claim accounts for:
 *  greedily match each claim's extraction rate to a port ceiling (±0.5); the
 *  leftovers are orphans (their claim was released while the port stayed —
 *  deliberately, when wired, so belts survive). */
export function orphanClaimPorts<P extends { id: string; rateCeiling: number | null }>(
  ports: P[],
  liveClaimRates: number[],
): P[] {
  const pool = [...ports];
  for (const rate of liveClaimRates) {
    const i = pool.findIndex((p) => p.rateCeiling != null && Math.abs(p.rateCeiling - rate) < 0.5);
    if (i >= 0) pool.splice(i, 1);
  }
  return pool;
}

export interface ReuseCandidate {
  id: string;
  rateCeiling: number | null;
  /** a belt touches this port — reuse it FIRST so its belts relight. */
  wired: boolean;
}

/** The port a NEW claim should reuse instead of adding a fresh one, or null.
 *
 *  Deliberately conservative — reusing the WRONG port corrupts a factory's
 *  input metering (set_port_ceiling clobbers its ceiling), which is far worse
 *  than the duplicate port it prevents:
 *
 *  - `null` in liveClaimRates = a same-factory same-item claim whose node we
 *    could not resolve (save-only nodes live outside the world catalog). Its
 *    port is invisible to rate-matching and would read as an orphan — bail.
 *  - No reuse unless claim-shaped ports OUTNUMBER live claims. The wizard
 *    builds ONE port per raw item with ceiling = the SUM of several claims'
 *    rates; no single claim rate-matches it, so pure rate-matching calls that
 *    live aggregate port an orphan. With 1 port for 2 claims there is no
 *    numeric excess, so the count guard keeps hands off it.
 */
export function pickReusePort<P extends ReuseCandidate>(
  ports: P[],
  liveClaimRates: Array<number | null>,
): P | null {
  if (liveClaimRates.some((r) => r == null)) return null;
  if (ports.length <= liveClaimRates.length) return null;
  const orphans = orphanClaimPorts(ports, liveClaimRates as number[]);
  if (orphans.length === 0) return null;
  return orphans.find((p) => p.wired) ?? orphans[0];
}

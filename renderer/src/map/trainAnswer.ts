// Task #49 train answer-sheet: "how many trains does this route need?" — the
// question players get wrong. The transport FORMULA (throughput, RTT, headway)
// is owned by Rust (crates/planner-core/src/transport.rs) and reused here two
// ways: the prospective popover calls the read-only `routeCalc` backend, and
// an existing route folds its already-derived math block. This module only
// does the trivial ceil/surplus wrapper (mirrored from Rust `train_answer`)
// and the plain-text clipboard payload (sheetToText-style). No plan mutation.

import { fmtKm, fmtRate } from "../lib/format";
import type { TrainAnswer, TransportMath } from "../state/types";

/** m:ss clock from seconds — the math block's time grammar. */
export const clockS = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

/** Fold an already-computed math block + its unit count + a demand into the
 *  answer — the ceil/surplus fold mirrored from Rust `train_answer`. Used for an
 *  EXISTING route whose math already arrived via the derived projection; the
 *  transport formula itself is never recomputed here. */
export function trainAnswerFromMath(
  math: TransportMath,
  units: number,
  demandPerMin: number,
): TrainAnswer {
  const perTrain = math.throughputPerMin / Math.max(1, units);
  const trainsNeeded = demandPerMin <= 0 || perTrain <= 0 ? 0 : Math.ceil(demandPerMin / perTrain);
  return {
    math,
    perTrainPerMin: perTrain,
    trainsNeeded,
    demandPerMin,
    surplusPerMin: math.throughputPerMin - demandPerMin,
    short: demandPerMin > math.throughputPerMin + 1e-6,
  };
}

export type TrainKind = "rail" | "truck" | "drone";

export interface TrainAnswerContext {
  kind: TrainKind;
  from: string;
  to: string;
  item: string;
}

export const UNIT: Record<TrainKind, string> = { rail: "consist", truck: "truck", drone: "drone" };

/** Plain-text clipboard payload — the same content the block shows, every
 *  number through the shared format helpers so a copy never leaks a raw float. */
export function trainAnswerToText(a: TrainAnswer, ctx: TrainAnswerContext): string {
  const unit = UNIT[ctx.kind];
  const total = a.perTrainPerMin * a.trainsNeeded;
  const L: string[] = [];
  L.push(`TRAIN ANSWER — ${ctx.from.toUpperCase()} → ${ctx.to.toUpperCase()}`);
  L.push(`${ctx.item.toUpperCase()} · ${ctx.kind.toUpperCase()} · ${fmtKm(a.math.effectiveLengthM)}`);
  L.push("");
  if (a.demandPerMin <= 0) {
    L.push(`TRAINS NEEDED  — (enter a target rate)`);
  } else {
    L.push(`TRAINS NEEDED  ${a.trainsNeeded}× ${unit}${a.trainsNeeded === 1 ? "" : "s"}`);
  }
  L.push(`PER ${unit.toUpperCase()}  ${fmtRate(a.perTrainPerMin)}/min`);
  L.push(`DEMAND  ${a.demandPerMin > 0 ? `${fmtRate(a.demandPerMin)}/min` : "—"}`);
  if (a.demandPerMin > 0) {
    if (a.short) {
      L.push(`RESULT  SHORT by ${fmtRate(a.demandPerMin - a.math.throughputPerMin)}/min — needs ${a.trainsNeeded}× ${unit}${a.trainsNeeded === 1 ? "" : "s"}`);
    } else {
      L.push(`RESULT  ${a.trainsNeeded}× → ${fmtRate(total)}/min · SURPLUS ${fmtRate(total - a.demandPerMin)}/min`);
    }
  }
  L.push("");
  L.push(`RTT  ${clockS(a.math.rttS)}`);
  if (a.math.headwayS != null) L.push(`HEADWAY  ${clockS(a.math.headwayS)}`);
  L.push(`ROUND TRIP  ${clockS(a.math.roundTripS)}`);
  return L.join("\n");
}

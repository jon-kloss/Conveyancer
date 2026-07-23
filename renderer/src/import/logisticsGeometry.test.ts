import { describe, it, expect } from "vitest";
import { extractLogistics, type BuiltPolyline } from "./logisticsGeometry";
import type { RawObject } from "./parseSnapshot";

// Raw actor shapes mirror what @etothepii's parser emits (verified against a
// real Dunarr-076.sav dump): spline actors carry a world transform + LOCAL
// SplinePointData (cm); power lines carry WORLD-space wire endpoint pairs.

const splinePoint = (loc: [number, number], leave: [number, number], arrive: [number, number]) => ({
  properties: {
    Location: { value: { x: loc[0], y: loc[1], z: 0 } },
    ArriveTangent: { value: { x: arrive[0], y: arrive[1], z: 0 } },
    LeaveTangent: { value: { x: leave[0], y: leave[1], z: 0 } },
  },
});

const beltActor = (tx: number, ty: number): RawObject => ({
  typePath: "/Game/FactoryGame/Buildable/Factory/ConveyorBeltMk3/Build_ConveyorBeltMk3.Build_ConveyorBeltMk3_C",
  transform: { translation: { x: tx, y: ty, z: 0 } },
  properties: {
    // straight 1000 cm run east: tangents along +X sized to the span
    mSplineData: {
      values: [
        splinePoint([0, 0], [1000, 0], [1, 0]),
        splinePoint([1000, 0], [1, 0], [1000, 0]),
      ],
    },
  },
});

const powerActor = (): RawObject => ({
  typePath: "/Game/FactoryGame/Buildable/Factory/PowerLine/Build_PowerLine.Build_PowerLine_C",
  transform: { translation: { x: 0, y: 0, z: 0 } },
  properties: {
    mWireInstances: {
      values: [
        {
          properties: {
            Locations: [{ value: { x: -5000, y: 100, z: 0 } }, { value: { x: 5000, y: 100, z: 0 } }],
          },
        },
      ],
    },
  },
});

const levels = (objects: RawObject[]) => ({ level: { objects } });

describe("extractLogistics — save actors → map polylines", () => {
  it("maps a belt spline into world meters (transform + local ÷ 100)", () => {
    const g = extractLogistics("T", levels([beltActor(-250000, 30000)]));
    expect(g.counts).toEqual({ belt: 1, pipe: 0, rail: 0, power: 0 });
    const belt = g.lines[0];
    expect(belt.kind).toBe("belt");
    // first point = translation (−2500, 300 m); last = +10 m east
    expect(belt.pts[0]).toBeCloseTo(-2500);
    expect(belt.pts[1]).toBeCloseTo(300);
    expect(belt.pts[belt.pts.length - 2]).toBeCloseTo(-2490);
    expect(belt.pts[belt.pts.length - 1]).toBeCloseTo(300);
    // Hermite subdivision inserted interior samples (4 steps → 5 points)
    expect(belt.pts.length).toBe(10);
    // a straight run subdivides to collinear points — y never leaves the line
    for (let i = 1; i < belt.pts.length; i += 2) expect(belt.pts[i]).toBeCloseTo(300);
  });

  it("extracts power-line wires as world-space segments and skips unknowns", () => {
    const junk: RawObject = { typePath: "/Game/FactoryGame/Build_ConveyorPole.Build_ConveyorPole_C" };
    const g = extractLogistics("T", levels([powerActor(), junk]));
    expect(g.counts.power).toBe(1);
    const wire = g.lines.find((l: BuiltPolyline) => l.kind === "power")!;
    expect(wire.pts).toEqual([-50, 1, 50, 1]);
  });

  it("tolerates malformed spline actors without dying", () => {
    const broken: RawObject = {
      typePath: "/Game/X/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C",
      transform: { translation: { x: 0, y: 0, z: 0 } },
      properties: { mSplineData: { values: [splinePoint([0, 0], [1, 0], [1, 0])] } }, // one point
    };
    const g = extractLogistics("T", levels([broken]));
    expect(g.lines).toEqual([]);
    expect(g.counts.belt).toBe(0);
  });
});

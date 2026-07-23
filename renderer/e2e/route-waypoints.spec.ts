// Planned-route waypoint authoring (SetRoutePath): the command persists
// interior waypoints, re-pins the endpoint anchors, and the map renders the
// selected route's handles. API-level — the drag interaction itself is
// exercised at the planner-core level (set_route_path_keeps_anchors…).

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "./helpers";

const API = "http://localhost:8791/api";
const edit = async (request: APIRequestContext, cmds: unknown[]) => {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return (await res.json()) as { created: string[] };
};
const hydrate = async (request: APIRequestContext) =>
  (await (await request.get(`${API}/hydrate`)).json()) as {
    plan: { routes: Record<string, { path: { x: number; y: number }[] }> };
  };

test("set_route_path stores interior waypoints and keeps endpoint anchors", async ({ request }) => {
  await resetView(request);
  const mk = async (name: string, x: number) =>
    (await edit(request, [{ type: "create_factory", name, position: { x, y: -4000 }, region: "GRASS FIELDS" }]))
      .created[0];
  const a = await mk("WP SOURCE WORKS", -4600);
  const b = await mk("WP SINK WORKS", -4200);
  const outP = (
    await edit(request, [
      { type: "add_port", factory: a, direction: "out", item: "Desc_IronIngot_C", rate: 30, rateCeiling: null, graphPos: { x: 500, y: 100 } },
    ])
  ).created[0];
  const inP = (
    await edit(request, [
      { type: "add_port", factory: b, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: null, graphPos: { x: 0, y: 100 } },
    ])
  ).created[0];
  const route = (
    await edit(request, [{
        type: "add_route",
        kind: { kind: "belt", tier: 3 },
        from: outP,
        to: inP,
        path: [{ x: -4600, y: -4000, z: 0 }, { x: -4200, y: -4000, z: 0 }],
      }])
  ).created[0];

  const before = (await hydrate(request)).plan.routes[route].path;
  expect(before.length).toBeGreaterThanOrEqual(2);

  // Author a waypoint; submit deliberately-bogus endpoints — the command
  // re-pins them to the live anchors.
  await edit(request, [
    {
      type: "set_route_path",
      id: route,
      path: [{ x: 0, y: 0, z: 0 }, { x: -4400, y: -4300, z: 0 }, { x: 9, y: 9, z: 0 }],
    },
  ]);
  const after = (await hydrate(request)).plan.routes[route].path;
  expect(after.length).toBe(3);
  expect(after[0]).toEqual(before[0]);
  expect(after[2]).toEqual(before[before.length - 1]);
  expect(after[1].x).toBe(-4400);
  expect(after[1].y).toBe(-4300);

  // cleanup: the suite's shared plan must not accumulate demo factories
  await edit(request, [{ type: "delete_factory", id: a }]);
  await edit(request, [{ type: "delete_factory", id: b }]);
});

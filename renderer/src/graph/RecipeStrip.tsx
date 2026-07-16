// Recipe strip (mock 4a, bottom-center, build-menu style tiles). Current =
// orange border; available (standard + unlocked alternates) = steel; alternates
// the imported save has NOT unlocked render locked (W2b — the unlocked set comes
// from the save's purchased schematics; DECISIONS.md).

import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import type { MachineGroup } from "../state/types";
import ItemIcon from "../lib/ItemIcon";

export default function RecipeStrip({ group }: { group: MachineGroup }) {
  const gamedata = useStore((s) => s.gamedata);
  const dispatch = useStore((s) => s.dispatch);
  const unlocked = useStore((s) => s.unlocked);
  const [query, setQuery] = useState("");

  const recipes = useMemo(() => {
    const manufacturers = new Set(
      Object.values(gamedata.machines)
        .filter((m) => m.kind === "manufacturer")
        .map((m) => m.className),
    );
    return Object.values(gamedata.recipes)
      .filter((r) => r.producedIn.some((m) => manufacturers.has(m)))
      .sort((a, b) => Number(a.alternate) - Number(b.alternate) || a.displayName.localeCompare(b.displayName));
  }, [gamedata]);

  // At real-catalog scale (~250 recipes) the full list is a long scroll — filter
  // by recipe name or its output item so any recipe is a few keystrokes away.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter((r) => {
      if (r.displayName.toLowerCase().includes(q)) return true;
      const out = r.products?.[0]?.[0];
      const outName = out ? (gamedata.items[out]?.displayName ?? "") : "";
      return outName.toLowerCase().includes(q);
    });
  }, [recipes, query, gamedata.items]);

  const pick = (recipeClass: string) => {
    const r = gamedata.recipes[recipeClass];
    const machine = r.producedIn.find((m) => gamedata.machines[m]?.kind === "manufacturer");
    if (!machine) return;
    void dispatch([{ type: "set_group_recipe", id: group.id, machine, recipe: recipeClass }]);
  };

  return (
    <div className="recipe-strip" data-testid="recipe-strip">
      <div className="recipe-strip-head t-label">
        <span>
          RECIPES <span className="key-hint">R</span>
        </span>
        <input
          className="recipe-strip-search mono"
          type="search"
          placeholder={`search ${recipes.length}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="recipe-search"
        />
      </div>
      <div className="recipe-strip-tiles" data-testid="recipe-strip-tiles">
        {shown.length === 0 && <div className="recipe-strip-empty mono">no recipe matches “{query}”</div>}
        {shown.map((r) => {
          const current = r.className === group.recipe;
          // an alternate is locked only until the save unlocks its recipe class;
          // unlocked alternates are selectable steel tiles like standard recipes.
          const locked = r.alternate && !unlocked.has(r.className);
          return (
            <button
              key={r.className}
              className={`recipe-tile ${current ? "current" : ""} ${locked ? "locked" : ""}`}
              disabled={locked || current}
              onClick={() => pick(r.className)}
              title={r.displayName}
            >
              <ItemIcon item={r.products?.[0]?.[0] ?? ""} displayName={r.displayName} size={28} />
              <span className="recipe-tile-name">{r.displayName}</span>
              <span className="mono recipe-tile-sub">
                {locked ? "NOT UNLOCKED" : gamedata.machines[r.producedIn[0]]?.displayName?.toUpperCase() ?? ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

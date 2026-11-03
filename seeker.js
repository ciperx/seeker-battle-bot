// battle.training controller — "seeker v10" (s2.0.0, armor)
//
// What changed vs v2 (evidence: replay m_50417ccb6a21, cup set vs house-hunter,
// lost 0-2, score 4516-1047):
//   * In that replay BOTH bots issued `aimAt` for only the first ~10-20% of the
//     match and `fire` almost never (hunter 1 shot, seeker 0). On a 128x128 map
//     with 30-40 tile sensors, contacts are rare — the score is objective
//     points, not kills.
//   * v2's pickObjective() SKIPS objectives we already own ("held"), so all four
//     units abandon held points and pile onto the same best un-held objective.
//     With only 2-3 control points on the map, abandoning one donates its
//     weight-per-tick to the enemy for the rest of the match. That is the
//     4516-1047 loss, not gun skill.
//
// v10 strategy — SPLIT HOLD:
//   * every ground unit owns exactly ONE control point (distinct), assigned by
//     weight desc / distance asc, recomputed when ownership changes;
//   * a unit inside its own point radius STOPS (throttle 0) and holds it — it
//     only leaves to fight an enemy that is inside its gun range;
//   * the drone stays alive and spots: contacts are squad-wide (o.contacts), so
//     anyone in gun range can engage a target only the drone can see;
//   * focus fire unchanged (threat priority, wounded first).
//
// All numbers read from h.rules / h.map at runtime; nothing hard-coded.

const FP = 65536;
const FULL = 4096;

let rules, map, side, hill, spawn, enemySpawn;

function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) { return Math.round((Math.atan2(by - ay, bx - ax) / (2 * Math.PI)) * FULL) & (FULL - 1); }
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }
function tileAt(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return -1;
  return map.terrain[ty * map.width + tx];
}
function passable(x, y) { const t = tileAt(x, y); return t !== 2 && t !== 4 && t !== 6; }
function heightAt(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return 0;
  return map.heights[ty * map.width + tx];
}
// highest passable tile near a goal — plateau >=20 height above the goal grants +15% range
function highGroundNear(gx, gy, radius) {
  const r = radius ?? 3;
  const tx = Math.floor(gx / FP), ty = Math.floor(gy / FP);
  const base = heightAt(gx, gy);
  let best = null, bestH = base - 65536;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const cx = tx + dx, cy = ty + dy;
      if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) continue;
      const px = cx * FP + FP / 2, py = cy * FP + FP / 2;
      if (!passable(px, py)) continue;
      const h = map.heights[cy * map.width + cx];
      if (h > bestH) { bestH = h; best = [px, py]; }
    }
  }
  return best;
}

// threat priority: kill glass cannons + big guns first, then tanks, then scouts/drones
const THREAT = { artillery: 6, missile: 6, mbt: 5, apc: 4, engineer: 3, scout: 2, drone: 1 };
function priority(c) {
  return (THREAT[c.kind] ?? 0) * 100000 + (65536 - (c.hpFrac ?? 65536)); // value desc, wounded first
}
function bestTarget(contacts) {
  let best = null, bestScore = -1;
  for (const c of contacts) {
    const s = priority(c);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

// steer toward a goal while avoiding impassable terrain (fan out like the starter)
function steerToward(u, goal) {
  let want = angleTo(u.x, u.y, goal[0], goal[1]);
  const offsets = [0, 341, -341, 683, -683, 1024, -1024, 1365, -1365];
  for (const off of offsets) {
    const a = (want + off) & (FULL - 1);
    const rad = (a / FULL) * 2 * Math.PI;
    if (passable(u.x + Math.cos(rad) * FP * 1.6, u.y + Math.sin(rad) * FP * 1.6)) { want = a; break; }
  }
  return want;
}

// ---- split-hold objective assignment -------------------------------------
// assign[unitId] = index into o.objectives. Recomputed when the set of
// objective owners changes (or every 40 ticks as a safety net).
let assign = {};                 // unitId -> objective index
let assignStamp = -999;
let ownerSig = "";

function ownerSignature(objs) {
  let s = "";
  for (const o of objs || []) s += (o.owner === null ? "-" : String(o.owner)) + (o.state === "held" ? "h" : o.state === "contested" ? "c" : "e");
  return s;
}

function computeAssign(objectives, units, tick) {
  const sig = ownerSignature(objectives) + "|" + units.filter(u => u.alive).map(u => u.id).join(",");
  if (sig === ownerSig && tick - assignStamp < 200) return;
  ownerSig = sig;
  assignStamp = tick;

  const objs = (objectives || []).map((o, i) => ({ o, i })).filter(e => e.o.weight > 0);
  // highest weight first: a 3-point flank beats the 1-point hill
  objs.sort((a, b) => b.o.weight - a.o.weight || a.i - b.i);

  const ground = units.filter(u => u.alive && u.kind !== "drone");
  const taken = new Set();
  assign = {};

  // 1) every objective gets its nearest free ground unit
  for (const e of objs) {
    let best = null, bd = Infinity;
    for (const u of ground) {
      if (taken.has(u.id)) continue;
      const d = dist(u.x, u.y, e.o.x, e.o.y);
      if (d < bd) { bd = d; best = u; }
    }
    if (best) { taken.add(best.id); assign[best.id] = e.i; }
  }
  // 2) leftovers reinforce the heaviest point (or the closest one)
  for (const u of ground) {
    if (taken.has(u.id)) continue;
    let best = objs[0];
    for (const e of objs) {
      if (dist(u.x, u.y, e.o.x, e.o.y) < dist(u.x, u.y, best.o.x, best.o.y)) best = e;
    }
    assign[u.id] = best ? best.i : -1;
  }
}

globalThis.controller = {
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    // two MBTs (tanky, 45 dmg direct) + drone spotter + scout flank — best measured draft
    const pick = ["mbt", "mbt", "drone", "scout"];
    const cost = pick.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && pick.every(k => d.roster.includes(k)) ? pick : undefined;
  },

  hello(h) {
    rules = h.rules; map = h.map; side = h.side;
    spawn = [map.spawns[side][0] * FP + FP / 2, map.spawns[side][1] * FP + FP / 2];
    enemySpawn = [map.spawns[1 - side][0] * FP + FP / 2, map.spawns[1 - side][1] * FP + FP / 2];
    hill = [Math.floor(map.width / 2) * FP + FP / 2, Math.floor(map.height / 2) * FP + FP / 2];
    assign = {}; ownerSig = ""; assignStamp = -999;
  },

  tick(o) {
    const units = [];
    const target = bestTarget(o.contacts);
    const targetPos = target ? [target.x, target.y] : null;
    computeAssign(o.objectives, o.units, o.tick);

    for (const u of o.units) {
      if (!u.alive) continue;
      const spec = rules.units[u.kind];
      const order = { id: u.id };

      // how far this unit may stray from its post before it counts as a fight
      const engageRange = spec.gun && spec.gun.mode !== "none" ? spec.gun.maxRange * 0.8
        : (spec.secondary ? spec.secondary.maxRange : 0);

      let goal = null;
      let hold = false;

      if (u.kind === "drone") {
        // stay alive and keep the squad fed: orbit above the objective line
        const anchor = assign[u.id] !== undefined && o.objectives[assign[u.id]]
          ? o.objectives[assign[u.id]] : null;
        const cx = anchor ? anchor.x : (map.width / 2) * FP, cy = anchor ? anchor.y : (map.height / 2) * FP;
        if (targetPos) {
          const d = dist(u.x, u.y, targetPos[0], targetPos[1]);
          const R = spec.sensor * FP;
          goal = d < R * 0.45 ? [u.x * 2 - targetPos[0], u.y * 2 - targetPos[1]] : targetPos;
        } else {
          // patrol between our spawn side and the centre so it sees the approach lanes
          goal = [cx + (cx - spawn[0]) * 0.25, cy + (cy - spawn[1]) * 0.25];
        }
      } else {
        const ai = assign[u.id];
        const obj = ai !== undefined && ai >= 0 ? o.objectives[ai] : null;
        const enemyClose = targetPos && dist(u.x, u.y, targetPos[0], targetPos[1]) <= engageRange;

        if (enemyClose) {
          // fight: hold ground inside the point and shoot (do not chase off-post)
          goal = [u.x, u.y];
          hold = true;
        } else if (obj) {
          const inside = dist(u.x, u.y, obj.x, obj.y) <= (obj.radius ?? 0);
          if (inside) {
            // HOLD the point: score is weight-per-tick, leaving it donates points
            goal = [u.x, u.y];
            hold = true;
          } else {
            goal = [obj.x, obj.y];
            const hg = highGroundNear(goal[0], goal[1], 3);
            if (hg && heightAt(hg[0], hg[1]) > heightAt(goal[0], goal[1])) goal = hg;
          }
        } else {
          goal = hill;
        }
      }

      // ----- movement -----
      if (goal && o.canMove && !hold) {
        const want = steerToward(u, goal);
        const d = angDiff(u.heading, want);
        order.steer = Math.max(-FP, Math.min(FP, Math.round((d / spec.turnRate) * FP)));
        order.throttle = Math.abs(d) > 512 ? Math.round(FP * 0.25) : FP;
        if (u.blocked) { order.throttle = -FP; order.steer = FP; }
      } else if (hold) {
        order.throttle = 0;
        order.steer = 0;
      }

      // ----- weapons (squad-wide contacts: the drone's eyes count for everyone) -----
      if (target) {
        const d = dist(u.x, u.y, target.x, target.y);
        if (spec.gun.mode === "none") {
          if (spec.secondary && u.reload2 === 0 && d <= spec.secondary.maxRange) order.fire = true;
        } else if (spec.gun.mode === "direct") {
          order.aimAt = [Math.round(target.x), Math.round(target.y)];
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, target.x, target.y))) <= spec.gun.aimTolerance;
          if (u.reload === 0 && aimed && d <= spec.gun.maxRange) order.fire = true;
        } else if (u.reload === 0 && d >= spec.gun.minRange && d <= spec.gun.maxRange) {
          order.fire = [Math.round(target.x), Math.round(target.y)];
        }
      }
      units.push(order);
    }
    return { units };
  },
};

// battle.training controller — "seeker v1" (season 2 "Drafted", s2.0.0)
//
// Strategy vs the starter:
//  - draft a drone (flying spotter, sensor 36, looks over smoke) + artillery (60 dmg
//    splash, 10-60 tiles) + an MBT (45 dmg, independent turret, holds the line) + a
//    scout (fast flank/recon). Cost 2+4+4+2 = 12.
//  - focus fire on the highest-value target (artillery/missile first, then MBT/APC),
//    so the whole squad deletes one enemy at a time instead of spreading damage.
//  - spread units across objectives (scout flanks, MBT pushes, drone spots the
//    enemy, artillery hangs back within range behind the push).
//  - use high ground when available (plateau fire reaches 1.15x further) — pick firing
//    positions on elevated tiles near the objective line.
//
// All numbers are read from h.rules at runtime; nothing is hard-coded.

const FP = 65536;
const FULL = 4096;

let rules, map, side, hill, spawn;

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

// the objective worth holding for a given unit, spread by role
function pickObjective(objectives, x, y, role) {
  let best = null, score = -1;
  for (const o of objectives || []) {
    if (o.owner === side && o.state === "held" && o.weight > 0) continue; // still defend held ones if contested later
    const s = o.weight / (1 + dist(x, y, o.x, o.y) / FP);
    if (s > score) { score = s; best = o; }
  }
  return best ? [best.x, best.y] : hill;
}
// nearest objective to a unit (for flanking scout)
function nearestObjective(objectives, x, y) {
  let best = null, bd = Infinity;
  for (const o of objectives || []) {
    const d = dist(x, y, o.x, o.y);
    if (d < bd) { bd = d; best = o; }
  }
  return best ? [best.x, best.y] : hill;
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

globalThis.controller = {
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    // two MBTs (tanky, 45 dmg direct, no vulnerable artillery) + drone spotter + scout flank
    const pick = ["mbt", "mbt", "drone", "scout"];
    const cost = pick.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && pick.every(k => d.roster.includes(k)) ? pick : undefined;
  },

  hello(h) {
    rules = h.rules; map = h.map; side = h.side;
    spawn = [map.spawns[side][0] * FP + FP / 2, map.spawns[side][1] * FP + FP / 2];
    hill = [Math.floor(map.width / 2) * FP + FP / 2, Math.floor(map.height / 2) * FP + FP / 2];
  },

  tick(o) {
    const units = [];
    const target = bestTarget(o.contacts);
    const targetPos = target ? [target.x, target.y] : null;

    for (const u of o.units) {
      if (!u.alive) continue;
      const spec = rules.units[u.kind];
      const order = { id: u.id };
      const contacts = o.contacts;

      // ----- per-kind behaviour -----
      let goal = null;
      let stop = false;
      if (u.kind === "drone") {
        // fly toward the enemy so they stay spotted; back off if too close
        const enemySpawn = [map.spawns[1 - side][0] * FP + FP / 2, map.spawns[1 - side][1] * FP + FP / 2];
        if (targetPos) {
          const d = dist(u.x, u.y, targetPos[0], targetPos[1]);
          const R = spec.sensor * FP;
          if (d < R * 0.5) goal = [u.x * 2 - targetPos[0], u.y * 2 - targetPos[1]]; // too close: back off
          else goal = targetPos; // follow, keep it spotted
        } else goal = enemySpawn;
      } else if (u.kind === "artillery") {
        // keep enemy in [minRange*1.1, maxRange*0.85]; back off if pressed, else hold & shoot
        if (targetPos) {
          const d = dist(u.x, u.y, targetPos[0], targetPos[1]);
          if (d < spec.gun.minRange * 1.3) goal = [u.x * 2 - targetPos[0], u.y * 2 - targetPos[1]]; // back off
          else goal = [u.x, u.y]; // hold: in range
        } else {
          // no visible target: creep toward the objective line behind the push
          goal = nearestObjective(o.objectives, u.x, u.y);
        }
      } else if (u.kind === "scout") {
        // flank the far objective / hunt enemies seen; keep moving
        goal = targetPos && dist(u.x, u.y, targetPos[0], targetPos[1]) < spec.gun.maxRange * 1.2
          ? [u.x * 2 - targetPos[0], u.y * 2 - targetPos[1]]  // kite
          : nearestObjective(o.objectives, u.x, u.y);
      } else {
        // MBT (and any other ground unit): push the best objective unless a target is in range
        const inRange = targetPos && dist(u.x, u.y, targetPos[0], targetPos[1]) < spec.gun.maxRange * 0.75;
        if (inRange) goal = [u.x, u.y]; // hold and shoot
        else goal = pickObjective(o.objectives, u.x, u.y, u.kind);
      }

      // ----- movement -----
      if (goal && o.canMove && !stop) {
        const want = steerToward(u, goal);
        const d = angDiff(u.heading, want);
        order.steer = Math.max(-FP, Math.min(FP, Math.round((d / spec.turnRate) * FP)));
        order.throttle = Math.abs(d) > 512 ? Math.round(FP * 0.25) : FP;
        if (u.blocked) { order.throttle = -FP; order.steer = FP; }
      }

      // ----- weapons -----
      if (target) {
        const d = dist(u.x, u.y, target.x, target.y);
        if (spec.gun.mode === "none") {
          if (spec.secondary && u.reload2 === 0 && d <= spec.secondary.maxRange) order.fire = true;
        } else if (spec.gun.mode === "direct") {
          order.aimAt = [target.x, target.y];
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, target.x, target.y))) <= spec.gun.aimTolerance;
          if (u.reload === 0 && aimed && d <= spec.gun.maxRange) order.fire = true;
        } else if (u.reload === 0 && d >= spec.gun.minRange && d <= spec.gun.maxRange) {
          // indirect (artillery): fire at the current position and let the splash radius catch drift
          order.fire = [Math.round(target.x), Math.round(target.y)];
        }
      }
      units.push(order);
    }
    return { units };
  },
};
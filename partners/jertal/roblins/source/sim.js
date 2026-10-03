// Roblins game logic. No rendering and no DOM: in solo it runs in the browser,
// and for co-op the same file will run on the Node server.
(function (root) {
  'use strict';
  var GOB = root.GOB = root.GOB || {};
  if (!GOB.Data && typeof require === 'function') require('./data.js');
  var D = GOB.Data;

  // Cell kinds
  var SOLID = 0, INSIDE = 1, OUTSIDE = 2, FIELDWALL = 3;
  // Cell tags (what carved an INSIDE cell)
  var TAG_ROOM = 1, TAG_CORRIDOR = 2, TAG_TUNNEL = 3;
  var SURFACES = Object.keys(D.surfaces);
  var SURF = {};
  SURFACES.forEach(function (n, i) { SURF[n] = i; });
  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // ---------- seeded randomness ----------

  function hashString(s) {
    s = String(s);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function makeRng(seed) {
    var a = hashString(seed) || 1;
    function next() {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    next.int = function (lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); }; // inclusive
    next.pick = function (arr) { return arr[Math.floor(next() * arr.length)]; };
    return next;
  }

  // ---------- tomb generation ----------

  function createWorld(seed, tombId) {
    function cellOf(px, pz) { return Math.floor(pz / D.cellSize) * T.grid.w + Math.floor(px / D.cellSize); }
    tombId = tombId || 'barrow';
    var T = D.tombs[tombId];
    if (T.layout === 'warren') return createWarren(seed, tombId, T);
    if (T.layout === 'sky') return createSky(seed, tombId, T);
    var cs = D.cellSize;
    var W = T.grid.w, H = T.grid.h, N = W * H;
    var I = T.interior;
    var r = makeRng(seed + ':' + tombId);

    var kind = new Uint8Array(N);
    var floor = new Float32Array(N);
    var ceil = new Float32Array(N);
    var surf = new Uint8Array(N);
    var room = new Int16Array(N).fill(-1);
    var tag = new Uint8Array(N);
    function id(x, y) { return y * W + x; }
    function inInterior(x, y) { return x >= I.x0 && x < I.x1 && y >= I.y0 && y < I.y1; }

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var c = id(x, y);
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) kind[c] = FIELDWALL;
        else if (!inInterior(x, y)) { kind[c] = OUTSIDE; surf[c] = SURF[T.outsideSurface || 'grass']; }
      }
    }

    // Rooms. The entrance hall is placed first, just inside the mound's south face.
    var R = T.rooms, rooms = [];
    function fits(rx, ry, rw, rh) {
      if (rx < I.x0 + 1 || ry < I.y0 + 1 || rx + rw > I.x1 - 1 || ry + rh > I.y1 - 1) return false;
      for (var i = 0; i < rooms.length; i++) {
        var o = rooms[i];
        if (rx < o.x + o.w + 1 && rx + rw + 1 > o.x && ry < o.y + o.h + 1 && ry + rh + 1 > o.y) return false;
      }
      return true;
    }
    function addRoom(rx, ry, rw, rh) {
      rooms.push({ id: rooms.length, x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1),
        type: null, dist: Infinity, level: 0, links: [] });
    }
    var entranceX = I.x1 - I.x0 >= 17 ? r.int(I.x0 + 8, I.x1 - 9) : (I.x0 + I.x1) >> 1; // a narrow hull: the breach is in the bow
    var ew = r.int(4, 5);
    addRoom(entranceX - (ew >> 1), I.y0 + 2, ew, 4);
    for (var a = 0; a < R.attempts && rooms.length < R.max; a++) {
      var rw = r.int(R.minSize, R.maxSize), rh = r.int(R.minSize, R.maxSize);
      var rx = r.int(I.x0 + 1, I.x1 - 1 - rw), ry = r.int(I.y0 + 1, I.y1 - 1 - rh);
      if (fits(rx, ry, rw, rh)) addRoom(rx, ry, rw, rh);
    }

    // Room graph: a minimum spanning tree plus a few extra links so there are loops.
    function manhattan(p, q) { return Math.abs(p.cx - q.cx) + Math.abs(p.cy - q.cy); }
    var links = [], used = rooms.map(function (_, i) { return i === 0; }), treeSize = 1;
    while (treeSize < rooms.length) {
      var best = null, bd = Infinity;
      for (var i = 0; i < rooms.length; i++) {
        if (!used[i]) continue;
        for (var j = 0; j < rooms.length; j++) {
          if (used[j]) continue;
          var d = manhattan(rooms[i], rooms[j]);
          if (d < bd) { bd = d; best = [i, j]; }
        }
      }
      used[best[1]] = true; treeSize++; links.push(best);
    }
    function linked(i, j) {
      return links.some(function (l) { return (l[0] === i && l[1] === j) || (l[0] === j && l[1] === i); });
    }
    for (i = 0; i < rooms.length; i++) {
      for (j = i + 1; j < rooms.length; j++) {
        if (!linked(i, j) && manhattan(rooms[i], rooms[j]) < R.extraLinkRange && r() < R.extraLinks) links.push([i, j]);
      }
    }
    links.forEach(function (l) { rooms[l[0]].links.push(l[1]); rooms[l[1]].links.push(l[0]); });

    // Carve rooms, then L-shaped corridors between linked room centers.
    function carve(cx, cy, t) {
      var cc = id(cx, cy);
      if (kind[cc] !== SOLID) return;
      kind[cc] = INSIDE; tag[cc] = t;
    }
    rooms.forEach(function (rm) {
      for (var yy = rm.y; yy < rm.y + rm.h; yy++) {
        for (var xx = rm.x; xx < rm.x + rm.w; xx++) {
          var cc = id(xx, yy);
          kind[cc] = INSIDE; tag[cc] = TAG_ROOM; room[cc] = rm.id;
        }
      }
    });
    links.forEach(function (l) {
      var p = rooms[l[0]], q = rooms[l[1]];
      var cx = p.cx, cy = p.cy;
      function walkTo(tx, ty) {
        while (cx !== tx) { cx += Math.sign(tx - cx); carve(cx, cy, TAG_CORRIDOR); }
        while (cy !== ty) { cy += Math.sign(ty - cy); carve(cx, cy, TAG_CORRIDOR); }
      }
      if (r() < 0.5) { walkTo(q.cx, cy); walkTo(q.cx, q.cy); } else { walkTo(cx, q.cy); walkTo(q.cx, q.cy); }
    });
    carve(entranceX, I.y0, TAG_CORRIDOR);
    carve(entranceX, I.y0 + 1, TAG_CORRIDOR);
    var entranceOut = { x: entranceX, y: I.y0 - 1 };

    // Depth. Floors sink with the number of corridor cells walked from the entrance;
    // crossing a room costs nothing, so rooms stay flat and neighbouring cells never
    // differ by more than one step of depth.
    var depth = new Int32Array(N).fill(-1);
    var deque = [id(entranceOut.x, entranceOut.y)], head = 0;
    depth[deque[0]] = 0;
    var settled = new Uint8Array(N);
    while (head < deque.length) {
      var cc = deque[head++];
      if (settled[cc]) continue;
      settled[cc] = 1;
      var ccx = cc % W, ccy = (cc / W) | 0;
      for (var k = 0; k < 4; k++) {
        var nx = ccx + DIRS[k][0], ny = ccy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var n = id(nx, ny);
        if (kind[n] !== INSIDE) continue;
        var cost = room[n] >= 0 && room[n] === room[cc] ? 0 : 1;
        if (depth[n] >= 0 && depth[n] <= depth[cc] + cost) continue;
        depth[n] = depth[cc] + cost;
        if (cost === 0) deque.splice(head, 0, n); else deque.push(n);
      }
    }
    var L = T.levels;
    function levelFor(d) { return Math.max(L.deepest, L.top + L.perCell * d); }
    rooms.forEach(function (rm) {
      rm.dist = depth[id(rm.cx, rm.cy)];
      rm.level = Math.round(levelFor(rm.dist) / T.stepQuantum) * T.stepQuantum;
    });

    // Room types: the deepest room holds the treasure.
    rooms[0].type = 'entrance';
    var treasure = rooms.slice(1).reduce(function (m, rm) { return rm.dist > m.dist ? rm : m; }, rooms[1] || rooms[0]);
    treasure.type = 'treasure';
    rooms.forEach(function (rm) {
      if (!rm.type) rm.type = r() < T.burialChance ? 'burial' : 'chamber';
    });

    // Floor heights for everything carved so far (the outdoors stays at 0).
    var q = T.stepQuantum;
    for (c = 0; c < N; c++) {
      if (kind[c] !== INSIDE) continue;
      floor[c] = room[c] >= 0 ? rooms[room[c]].level : Math.round(levelFor(depth[c]) / q) * q;
    }

    // The robbers' tunnel: a low crawlway from a deep room out through the mound's
    // west, east or north face. It climbs as a clean staircase that touches no other
    // passage, so several routes are tried and the first clean one is kept.
    var maxDist = treasure.dist;
    var deep = rooms.filter(function (rm) { return rm.type !== 'entrance' && rm.type !== 'treasure' && rm.dist >= maxDist * 0.6; });
    var others = rooms.filter(function (rm) { return rm.type !== 'entrance'; });
    var groundY = T.pit ? -T.pit.depth : 0; // where the robbers' tunnel comes out
    var FACES = {
      west:  { main: [-1, 0], side: [0, 1] },
      east:  { main: [1, 0], side: [0, 1] },
      north: { main: [0, 1], side: [1, 0] }
    };
    function isOpen(px, py) { return kind[id(px, py)] !== SOLID; }
    function atEdge(face, px, py) {
      return face === 'west' ? px === I.x0 : face === 'east' ? px === I.x1 - 1 : py === I.y1 - 1;
    }
    function sideOk(face, px, py) {
      return face === 'north' ? px >= I.x0 + 2 && px <= I.x1 - 3 : py >= I.y0 + 2 && py <= I.y1 - 3;
    }
    function planTunnel(rm, face, allowTouch, anyLength) {
      var F = FACES[face];
      var px = face === 'west' ? rm.x - 1 : face === 'east' ? rm.x + rm.w : r.int(rm.x, rm.x + rm.w - 1);
      var py = face === 'north' ? rm.y + rm.h : r.int(rm.y, rm.y + rm.h - 1);
      var span = face === 'west' ? px - I.x0 : face === 'east' ? I.x1 - 1 - px : I.y1 - 1 - py;
      // Long enough that every stair step stays climbable on the way up to ground level.
      var needLen = Math.ceil((groundY - rm.level) / (D.player.stepUp - 0.1)) + 2;
      var extra = Math.max(0, needLen - (span + 1));
      var sdir = r() < 0.5 ? -1 : 1, cells = [];
      while (true) {
        cells.push([px, py]);
        if (atEdge(face, px, py)) break;
        if (cells.length > 1) {
          var run = extra > 0 ? Math.min(extra, r.int(1, 3)) : 0;
          for (var s = 0; s < run; s++) {
            var sx = px + F.side[0] * sdir, sy = py + F.side[1] * sdir;
            if (!sideOk(face, sx, sy)) break;
            px = sx; py = sy; cells.push([px, py]); extra--;
          }
        }
        px += F.main[0]; py += F.main[1];
      }
      if (!anyLength && cells.length < needLen) return null;
      if (!allowTouch) {
        for (var i = 0; i < cells.length; i++) {
          if (isOpen(cells[i][0], cells[i][1])) return null;
          for (var k2 = 0; k2 < 4; k2++) {
            var ax = cells[i][0] + DIRS[k2][0], ay = cells[i][1] + DIRS[k2][1];
            if (inInterior(ax, ay) && isOpen(ax, ay) && room[id(ax, ay)] !== rm.id) return null;
          }
        }
      }
      return { room: rm, face: face, cells: cells, exit: { x: px + F.main[0], y: py + F.main[1] } };
    }
    var plan = null, faceNames = Object.keys(FACES);
    for (a = 0; a < 400 && !plan; a++) {
      var pool = a < 200 && deep.length ? deep : others;
      plan = planTunnel(r.pick(pool), r.pick(faceNames), false);
    }
    function rampFloors(pl2) { // ramp between the room, any passages the tunnel crosses, and the ground outside
      var anchors = [{ i: -1, f: pl2.room.level }], out = {};
      pl2.cells.forEach(function (pc, i) { var c0 = id(pc[0], pc[1]); if (kind[c0] !== SOLID) anchors.push({ i: i, f: floor[c0] }); });
      anchors.push({ i: pl2.cells.length, f: groundY });
      pl2.cells.forEach(function (pc, i) {
        var c0 = id(pc[0], pc[1]); if (kind[c0] !== SOLID) return;
        var a1 = 0; while (anchors[a1 + 1].i < i) a1++;
        var A = anchors[a1], B = anchors[a1 + 1];
        out[c0] = Math.round((A.f + (B.f - A.f) * (i - A.i) / (B.i - A.i)) / q) * q;
      });
      return out;
    }
    function rampOk(pl2) { // every step along it (and into what it meets) can be crawled up
      var fl = rampFloors(pl2);
      for (var key in fl) {
        var c0 = +key, x0 = c0 % W, y0 = (c0 / W) | 0;
        for (var k7 = 0; k7 < 4; k7++) {
          var n7 = id(x0 + DIRS[k7][0], y0 + DIRS[k7][1]), f7 = n7 in fl ? fl[n7] : kind[n7] === INSIDE ? floor[n7] : kind[n7] === OUTSIDE ? groundY : null;
          if (f7 !== null && Math.abs(f7 - fl[key]) > D.player.stepUp) return false;
        }
      }
      return true;
    }
    for (a = 0; a < 400 && !plan; a++) { plan = planTunnel(r.pick(others), r.pick(faceNames), true); if (plan && !rampOk(plan)) plan = null; }
    if (!plan) plan = planTunnel(treasure, 'north', true, true), plan.fallback = true;
    var tr = plan.room, exitOut = plan.exit, ramp = rampFloors(plan);
    plan.cells.forEach(function (pc) {
      var cc3 = id(pc[0], pc[1]);
      if (kind[cc3] !== SOLID) return;
      carve(pc[0], pc[1], TAG_TUNNEL);
      floor[cc3] = ramp[cc3];
    });

    // Ceilings and floor surfaces. A passage's ceiling clears its highest
    // neighbouring floor, so a goblin stepping down a stair never meets it head first.
    var maxCeil = T.kerbHeight - 0.2;
    for (c = 0; c < N; c++) {
      if (kind[c] !== INSIDE) continue;
      var type = room[c] >= 0 ? rooms[room[c]].type : (tag[c] === TAG_TUNNEL ? 'tunnel' : 'corridor');
      var base = floor[c];
      if (room[c] < 0) {
        var bx0 = c % W, by0 = (c / W) | 0;
        for (k = 0; k < 4; k++) {
          var nb = id(bx0 + DIRS[k][0], by0 + DIRS[k][1]);
          if (kind[nb] === INSIDE && floor[nb] > base) base = floor[nb];
        }
      }
      ceil[c] = Math.min(maxCeil, base + T.ceilings[type]);
      surf[c] = SURF[T.surfaces[type]];
    }

    // Chasms (Dwarf Ossuary): a chamber whose floor has fallen away into the dark, crossed
    // by a rope bridge joining its doorways. Bridge cells keep the room's floor, but only
    // a plank-wide strip of them is solid (see planked()); the rest of the room is the drop.
    var HZ = T.hazards, hz = makeRng(seed + ':' + tombId + ':hazards');
    var chasm = null, bridgeMask = null, chasmDrop = HZ && HZ.chasmDrop || 0;
    if (HZ && HZ.chasms) {
      chasm = new Uint8Array(N); bridgeMask = new Uint8Array(N);
      var cand = rooms.filter(function (rm) { return rm.type === 'chamber' && rm.id !== tr.id && rm.w >= 3 && rm.h >= 3 && rm.w * rm.h >= 12; });
      var nch = hz.int(HZ.chasms[0], HZ.chasms[1]);
      while (nch-- > 0 && cand.length) {
        var crm2 = cand.splice(Math.floor(hz() * cand.length), 1)[0];
        var inRoom = function (xx, yy) { return xx >= crm2.x && xx < crm2.x + crm2.w && yy >= crm2.y && yy < crm2.y + crm2.h; };
        var ways = [];
        for (var yy = crm2.y; yy < crm2.y + crm2.h; yy++) for (var xx = crm2.x; xx < crm2.x + crm2.w; xx++) {
          for (k = 0; k < 4; k++) {
            var ox = xx + DIRS[k][0], oy = yy + DIRS[k][1];
            if (!inRoom(ox, oy) && kind[id(ox, oy)] === INSIDE) { ways.push(id(xx, yy)); break; }
          }
        }
        if (ways.length < 2) continue;
        // Shortest paths inside the room from the first doorway to each of the others.
        var onBridge = {}, prev = {};
        prev[ways[0]] = -1;
        var bq = [ways[0]];
        for (var bi = 0; bi < bq.length; bi++) {
          var bc = bq[bi], bx0 = bc % W, by0 = (bc / W) | 0;
          for (k = 0; k < 4; k++) {
            var nbx = bx0 + DIRS[k][0], nby = by0 + DIRS[k][1], nb2 = id(nbx, nby);
            if (!inRoom(nbx, nby) || prev[nb2] !== undefined) continue;
            prev[nb2] = bc; bq.push(nb2);
          }
        }
        ways.forEach(function (wc0) { for (var pc = wc0; pc !== -1; pc = prev[pc]) onBridge[pc] = true; });
        crm2.type = 'chasm';
        for (yy = crm2.y; yy < crm2.y + crm2.h; yy++) for (xx = crm2.x; xx < crm2.x + crm2.w; xx++) {
          var rc2 = id(xx, yy);
          ceil[rc2] = Math.min(maxCeil, crm2.level + T.ceilings.chasm);
          if (onBridge[rc2]) {
            chasm[rc2] = 2; surf[rc2] = SURF[T.surfaces.chasm];
            for (k = 0; k < 4; k++) { // planks run toward neighbouring bridge cells and out through doorways
              var ax = xx + DIRS[k][0], ay = yy + DIRS[k][1], ac = id(ax, ay);
              if (inRoom(ax, ay) ? onBridge[ac] : kind[ac] === INSIDE) bridgeMask[rc2] |= 1 << k;
            }
          } else { chasm[rc2] = 1; floor[rc2] = crm2.level - chasmDrop; surf[rc2] = SURF.gravel; }
        }
      }
    }

    // Outdoor paths: landing to the entrance, and landing round to the tunnel exit.
    var landing = T.landing;
    function markPath(px, py) {
      if (px < 1 || py < 1 || px > W - 2 || py > H - 2) return;
      var cc = id(px, py);
      if (kind[cc] === OUTSIDE) surf[cc] = SURF.path;
    }
    function trail(x0, y0, x1, y1) {
      var px = x0, py = y0;
      markPath(px, py);
      while (px !== x1 || py !== y1) {
        if (px !== x1 && (py === y1 || r() < 0.5)) px += Math.sign(x1 - px); else py += Math.sign(y1 - py);
        markPath(px, py);
        if (r() < 0.3) markPath(px + (r() < 0.5 ? -1 : 1), py);
      }
    }
    trail(landing.x, landing.y, entranceOut.x, entranceOut.y);
    var west = plan.face === 'west' || (plan.face === 'north' && exitOut.x < (I.x0 + I.x1) / 2);
    var sideCol = west ? I.x0 - 2 : I.x1 + 1;
    var sideRow = plan.face === 'north' ? I.y1 : exitOut.y;
    trail(landing.x, landing.y, sideCol, I.y0 - 2);
    trail(sideCol, I.y0 - 2, sideCol, sideRow);
    trail(sideCol, sideRow, exitOut.x, exitOut.y);

    // A tomb at the bottom of a pit (the Drowned Catacombs): past the rim the ground drops to the pit
    // floor, and a switchback cut into the south wall goes down: east along the first row, back west
    // along the second, stepDown a cell. Off its edge is a long fall.
    if (T.pit) {
      var PIT = T.pit, legLen = Math.ceil(PIT.depth / PIT.stepDown / 2), rx0 = landing.x + 2;
      for (c = 0; c < N; c++) if (kind[c] === OUTSIDE && ((c / W) | 0) > PIT.rimRow) floor[c] = -PIT.depth;
      for (var li = 0; li < legLen; li++) {
        var c6 = id(rx0 + li, PIT.rimRow + 1), c7 = id(rx0 + legLen - 1 - li, PIT.rimRow + 2);
        floor[c6] = -PIT.stepDown * (li + 1); surf[c6] = SURF.stone;
        floor[c7] = Math.max(-PIT.depth, -PIT.stepDown * (legLen + li + 1)); surf[c7] = SURF.stone;
      }
    }

    // A tomb cut into a cliff (the Terracotta Mausoleum): the outside is solid rock but for a clearing the
    // Gutbucket drops into, a narrow canyon winding up to a courtyard at the cliff foot, and a cleft
    // out to wherever the robbers' tunnel comes out.
    if (T.canyon) {
      var keep = new Uint8Array(N), cr = makeRng(seed + ':' + tombId + ':canyon');
      var openCell = function (ox2, oy2) { if (ox2 < 1 || oy2 < 1 || ox2 > W - 2 || oy2 > H - 2) return; var oc = id(ox2, oy2); if (kind[oc] === OUTSIDE) keep[oc] = 1; };
      for (y = landing.y - 2; y <= landing.y + 3; y++) for (x = landing.x - 4; x <= landing.x + 4; x++) openCell(x, y); // the clearing, with room at the foot of the gangway
      for (y = I.y0 - 3; y < I.y0; y++) for (x = entranceOut.x - 2; x <= entranceOut.x + 2; x++) openCell(x, y); // the courtyard
      var kx = landing.x, ky = landing.y + 3; // the canyon, one or two cells wide, drifting toward the door
      while (ky < I.y0 - 3) {
        ky++;
        if (cr() < 0.55) { // it wanders, but never far from the line to the door
          var drift = Math.abs(entranceOut.x - kx) >= 4 || (kx !== entranceOut.x && cr() < 0.4) ? Math.sign(entranceOut.x - kx) : (cr() < 0.5 ? -1 : 1);
          if (kx + drift > I.x0 && kx + drift < I.x1 - 1) { openCell(kx + drift, ky - 1); kx += drift; }
        }
        openCell(kx, ky);
        if (cr() < 0.5) openCell(kx + 1, ky);
      }
      for (x = Math.min(kx, entranceOut.x); x <= Math.max(kx, entranceOut.x); x++) openCell(x, I.y0 - 3);
      // the cleft: the shortest way over what was open ground from the tunnel's exit to the courtyard
      var from = {}, cq = [id(exitOut.x, exitOut.y)], reached = -1;
      from[cq[0]] = -1;
      for (var ci5 = 0; ci5 < cq.length && reached < 0; ci5++) {
        var c5 = cq[ci5];
        if (keep[c5] && ((c5 / W) | 0) >= I.y0 - 3) { reached = c5; break; } // along the cliff foot, into the courtyard
        for (k = 0; k < 4; k++) {
          var n5 = c5 + DIRS[k][0] + DIRS[k][1] * W;
          if (from[n5] !== undefined || kind[n5] !== OUTSIDE) continue;
          from[n5] = c5; cq.push(n5);
        }
      }
      for (var p5 = reached; p5 >= 0; p5 = from[p5]) keep[p5] = 1;
      for (c = 0; c < N; c++) if (kind[c] === OUTSIDE && !keep[c]) kind[c] = FIELDWALL;
    }

    // Props. Solid ones block movement; the rest only matter to the renderer.
    var props = [];
    function wc(v) { return (v + 0.5) * cs; } // cell center to world
    function addProp(p) { props.push(p); return p; }

    var entX = wc(entranceX), entZ = I.y0 * cs - 0.45;
    if (T.entranceStyle === 'torii') { // a red torii gate before the door
      addProp({ type: 'torii_post', x: entX - 1.35, z: entZ - 1.2, rot: 0, h: 3.2, shape: 'circle', r: 0.16 });
      addProp({ type: 'torii_post', x: entX + 1.35, z: entZ - 1.2, rot: 0, h: 3.2, shape: 'circle', r: 0.16 });
      addProp({ type: 'torii_beam', x: entX, z: entZ - 1.2, y: 3.2, rot: 0 });
    } else if (T.entranceStyle === 'cave') { // a cave mouth in the hill, a giant mushroom either side
      addProp({ type: 'giant_cap', x: entX - 1.6, z: entZ - 0.2, rot: 0, h: 3.4, shape: 'circle', r: 0.4 });
      addProp({ type: 'giant_cap', x: entX + 1.7, z: entZ - 0.4, rot: 1, h: 2.6, shape: 'circle', r: 0.4 });
      addProp({ type: 'cave_mouth', x: entX, z: entZ, y: 0, rot: 0 });
    } else if (T.entranceStyle === 'breach') { // a hole stove in the bow, splintered planks all round
      addProp({ type: 'breach', x: entX, z: entZ, y: 0, rot: 0 });
    } else if (T.entranceStyle === 'arch') { // the stumps of a broken arch before the crypt door
      var ay0 = floor[id(entranceOut.x, entranceOut.y)];
      addProp({ type: 'ruin_column', x: entX - 1.5, z: entZ - 0.4, y: ay0, h: 3.6, rot: 0.3, shape: 'circle', r: 0.36 });
      addProp({ type: 'ruin_column', x: entX + 1.5, z: entZ - 0.4, y: ay0, h: 2.1, rot: 1.1, shape: 'circle', r: 0.36 });
    } else if (T.entranceStyle === 'gate') { // a door in the cliff, two giant clay guardians either side
      addProp({ type: 'soldier_statue', x: entX - 1.7, z: entZ - 0.6, rot: Math.PI, big: 1.6, shape: 'circle', r: 0.45 });
      addProp({ type: 'soldier_statue', x: entX + 1.7, z: entZ - 0.6, rot: Math.PI, big: 1.6, shape: 'circle', r: 0.45 });
      addProp({ type: 'lintel', x: entX, z: entZ, y: 3.0, rot: 0 });
    } else if (T.entranceStyle === 'adit') { // a timbered mine mouth
      addProp({ type: 'mine_post', x: entX - 1.26, z: entZ, rot: 0, h: 2.5, shape: 'circle', r: 0.17 });
      addProp({ type: 'mine_post', x: entX + 1.26, z: entZ, rot: 0, h: 2.5, shape: 'circle', r: 0.17 });
      addProp({ type: 'mine_beam', x: entX, z: entZ, y: 2.5, rot: 0 });
    } else {
      addProp({ type: 'standing_stone', x: entX - 1.4, z: entZ, rot: 0, h: 2.6, shape: 'circle', r: 0.36 });
      addProp({ type: 'standing_stone', x: entX + 1.4, z: entZ, rot: 0, h: 2.6, shape: 'circle', r: 0.36 });
      addProp({ type: 'lintel', x: entX, z: entZ, y: 2.6, rot: 0 });
    }

    // The Gutbucket lands on the landing spot, long side facing the tomb, with the
    // gangway gap in the gunwale on that side. Its lift is one of the few parts of the
    // world the simulation changes: it drops in at dusk and rises at dawn.
    var ship = makeShip(wc(landing.x), wc(landing.y)), scx = ship.x, scz = ship.z;
    shipProps(ship).forEach(addProp);

    function outsideFree(px, pz, margin) {
      var cx1 = Math.floor(px / cs), cy1 = Math.floor(pz / cs);
      if (cx1 < 1 || cy1 < 1 || cx1 > W - 2 || cy1 > H - 2) return false;
      if (cx1 >= I.x0 - 2 && cx1 < I.x1 + 2 && cy1 >= I.y0 - 2 && cy1 < I.y1 + 2) return false;
      var cc = id(cx1, cy1);
      if (kind[cc] !== OUTSIDE || surf[cc] === SURF.path) return false;
      if (px > ship.x0 - 3 && px < ship.x1 + 3 && pz > ship.z0 - 3 && pz < ship.z1 + 4) return false;
      for (var i2 = 0; i2 < props.length; i2++) {
        var o = props[i2];
        if (o.shape && !o.ship && Math.hypot(px - o.x, pz - o.z) < (o.r || 1) + margin) return false;
      }
      return true;
    }

    // Round a pit: old stakes fence every edge that drops more than a stair (the rim, the switchback's open
    // side), close enough that no goblin slips between, on the high side. The way down stays open.
    if (T.pit) {
      for (y = 1; y < Math.min(H - 1, T.pit.rimRow + 4); y++) for (x = 1; x < W - 1; x++) {
        var hc = id(x, y);
        if (kind[hc] !== OUTSIDE) continue;
        for (k = 0; k < 4; k++) {
          var lx2 = x + DIRS[k][0], ly2 = y + DIRS[k][1], lc2 = id(lx2, ly2);
          if (kind[lc2] !== OUTSIDE || floor[hc] - floor[lc2] < 1.0) continue;
          for (var sp = 0; sp < 5; sp++) { // five stakes along the shared edge, just inside the high cell
            var along = (sp + 0.5) / 5 * cs, inset = 0.18;
            var sx6 = DIRS[k][0] ? (DIRS[k][0] > 0 ? (x + 1) * cs - inset : x * cs + inset) : x * cs + along;
            var sz6 = DIRS[k][1] ? (DIRS[k][1] > 0 ? (y + 1) * cs - inset : y * cs + inset) : y * cs + along;
            addProp({ type: 'rim_post', x: sx6, z: sz6, y: floor[hc], rot: (sx6 * 7 + sz6 * 3) % 6.28, shape: 'circle', r: 0.1 });
          }
        }
      }
    }
    // The pit floor: dead trees, and the rubble of the cathedral that fell in (broken columns, heaps of stone).
    for (a = 0, k = 0; a < 500 && k < (T.outside.deadTrees || 0); a++) {
      var tx6 = r() * W * cs, tz6 = r() * H * cs, tc6 = cellOf(tx6, tz6);
      if (!outsideFree(tx6, tz6, 1.2) || (T.pit && (floor[tc6] > -T.pit.depth + 0.01 || ((tc6 / W) | 0) <= T.pit.rimRow + 4))) continue; // not on the switchback, nor at its foot
      addProp({ type: 'dead_tree', x: tx6, z: tz6, y: floor[tc6], h: 4 + r() * 3.5, rot: r() * 6.28, shape: 'circle', r: 0.28 }); k++;
    }
    for (a = 0, k = 0; a < 500 && k < (T.outside.rubble || 0); a++) {
      var rx6 = r() * W * cs, rz6 = r() * H * cs, rc6 = cellOf(rx6, rz6);
      if (!outsideFree(rx6, rz6, 1.0) || (T.pit && (floor[rc6] > -T.pit.depth + 0.01 || ((rc6 / W) | 0) <= T.pit.rimRow + 4))) continue;
      if (r() < 0.35) addProp({ type: 'ruin_column', x: rx6, z: rz6, y: floor[rc6], h: 1.1 + r() * 2.4, rot: r() * 6.28, shape: 'circle', r: 0.36 });
      else { var rs6 = 0.5 + r() * 0.8; addProp({ type: 'rubble', x: rx6, z: rz6, y: floor[rc6], s: rs6, rot: r() * 6.28, shape: 'circle', r: rs6 * 0.8 }); }
      k++;
    }

    // One ring of standing stones somewhere on the moor.
    for (a = 0; a < 60; a++) {
      var rcx = r() * W * cs, rcz = r() * (I.y0 - 2) * cs, ok = true, pts = [];
      for (k = 0; k < T.outside.ringStones && ok; k++) {
        var ang = k / T.outside.ringStones * Math.PI * 2;
        var sx = rcx + Math.cos(ang) * T.outside.ringRadius, sz = rcz + Math.sin(ang) * T.outside.ringRadius;
        if (!outsideFree(sx, sz, 1.2)) ok = false; else pts.push([sx, sz, ang]);
      }
      if (ok && outsideFree(rcx, rcz, 1)) {
        pts.forEach(function (pt) {
          addProp({ type: 'standing_stone', x: pt[0], z: pt[1], rot: -pt[2], h: 1.6 + r() * 1.2, shape: 'circle', r: 0.34 });
        });
        break;
      }
    }
    for (a = 0, k = 0; a < 300 && k < T.outside.boulders; a++) {
      var bx = r() * W * cs, bz = r() * H * cs, br = 0.45 + r() * 0.5;
      if (!outsideFree(bx, bz, br + 1.2)) continue;
      addProp({ type: 'boulder', x: bx, z: bz, rot: r() * Math.PI * 2, s: br, shape: 'circle', r: br * 0.9 });
      k++;
    }
    // A bamboo grove round the shrine hill, and stone lanterns along the way.
    for (a = 0, k = 0; a < 600 && k < (T.outside.bamboo || 0); a++) {
      var bx2 = r() * W * cs, bz2 = r() * H * cs;
      if (!outsideFree(bx2, bz2, 1.2)) continue;
      addProp({ type: 'bamboo', x: bx2, z: bz2, rot: r() * 6.28, h: 5 + r() * 4, n: 3 + Math.floor(r() * 5), shape: 'circle', r: 0.35 });
      k++;
    }
    for (a = 0, k = 0; a < 200 && k < (T.outside.stoneLanterns || 0); a++) {
      var lx3 = r() * W * cs, lz3 = r() * (I.y0 - 1) * cs;
      if (!outsideFree(lx3, lz3, 1.5)) continue;
      addProp({ type: 'stone_lantern', x: lx3, z: lz3, rot: r() * 0.5, shape: 'circle', r: 0.32 });
      k++;
    }
    // Giant mushrooms out on the hillside.
    for (a = 0, k = 0; a < 300 && k < (T.outside.caps || 0); a++) {
      var gx = r() * W * cs, gz = r() * H * cs;
      if (!outsideFree(gx, gz, 1.4)) continue;
      addProp({ type: 'giant_cap', x: gx, z: gz, rot: r() * 6.28, h: 2.2 + r() * 3, shape: 'circle', r: 0.4 });
      k++;
    }
    // The wreck's masts, snapped off and lying on the sand, and driftwood along the tideline.
    for (a = 0, k = 0; a < 200 && k < (T.outside.masts || 0); a++) {
      var along = r() < 0.5, mlen = 7 + r() * 5, mx2 = r() * W * cs, mz2 = r() * H * cs;
      var ok2 = true;
      for (var t7 = -mlen / 2; t7 <= mlen / 2 && ok2; t7 += 1) if (!outsideFree(mx2 + (along ? t7 : 0), mz2 + (along ? 0 : t7), 1.5)) ok2 = false;
      if (!ok2) continue;
      addProp({ type: 'fallen_mast', x: mx2, z: mz2, rot: along ? Math.PI / 2 : 0, len: mlen, shape: 'box', hw: along ? mlen / 2 : 0.3, hd: along ? 0.3 : mlen / 2 });
      k++;
    }
    for (a = 0, k = 0; a < 200 && k < (T.outside.driftwood || 0); a++) {
      var dx3 = r() * W * cs, dz3 = r() * H * cs;
      if (!outsideFree(dx3, dz3, 0.8)) continue;
      addProp({ type: 'driftwood', x: dx3, z: dz3, rot: r() * 6.28, s: 0.6 + r() * 1.2 });
      k++;
    }
    for (a = 0, k = 0; a < 300 && k < (T.outside.pines || 0); a++) {
      var px2 = r() * W * cs, pz2 = r() * H * cs;
      if (!outsideFree(px2, pz2, 1.4)) continue;
      addProp({ type: 'pine', x: px2, z: pz2, rot: r() * 6.28, h: 3 + r() * 3.5, dead: r() < 0.4, shape: 'circle', r: 0.3 });
      k++;
    }
    for (a = 0, k = 0; a < 200 && k < (T.outside.obelisks || 0); a++) {
      var ox2 = r() * W * cs, oz2 = r() * (I.y0 - 1) * cs;
      if (!outsideFree(ox2, oz2, 2)) continue;
      addProp({ type: 'obelisk', x: ox2, z: oz2, rot: r() * 0.4, h: 4 + r() * 2.5, shape: 'circle', r: 0.45 });
      k++;
    }

    // Burial halls get rows of stone slabs; the treasure room gets a plinth.
    var slabs = [], plinth = null, sarcophagus = null;
    rooms.forEach(function (rm) {
      if (rm.type === 'treasure' && T.treasureProp === 'sarcophagus') {
        // the royal sarcophagus in the middle, the death mask on a stand in a corner
        // (sized to sit inside the centre cell, so there's always a way round it)
        sarcophagus = addProp({ type: 'sarcophagus', x: wc(rm.cx), z: wc(rm.cy), y: rm.level, rot: 0, shape: 'box', hw: 0.5, hd: 0.95, room: rm.id });
        var corners = [[rm.x, rm.y, -1, -1], [rm.x + rm.w - 1, rm.y, 1, -1], [rm.x, rm.y + rm.h - 1, -1, 1], [rm.x + rm.w - 1, rm.y + rm.h - 1, 1, 1]];
        var corner = corners.filter(function (k5) { // a corner with walls on both outer sides, not a doorway
          return kind[id(k5[0] + k5[2], k5[1])] === SOLID && kind[id(k5[0], k5[1] + k5[3])] === SOLID;
        })[0] || corners[0];
        plinth = addProp({ type: 'plinth', x: wc(corner[0]) + corner[2] * 0.25, z: wc(corner[1]) + corner[3] * 0.25, y: rm.level, rot: 0,
          shape: 'box', hw: 0.45, hd: 0.45, room: rm.id, small: true });
      } else if (rm.type === 'treasure') {
        plinth = addProp({ type: 'plinth', x: wc(rm.cx), z: wc(rm.cy), y: rm.level, rot: 0, shape: 'box', hw: 0.6, hd: 0.6, room: rm.id, desk: T.treasureProp === 'desk', mother: T.treasureProp === 'mother_bed', altar: T.treasureProp === 'altar' });
      }
      if (rm.type !== 'burial' || rm.w < 3 || rm.h < 3) return;
      var alongZ = rm.w >= rm.h; // slabs lie across the long axis, like pews
      for (var yy = rm.y + 1; yy < rm.y + rm.h - 1; yy++) {
        for (var xx = rm.x + 1; xx < rm.x + rm.w - 1; xx++) {
          var lane = alongZ ? xx - rm.x : yy - rm.y;
          if (lane % 2 !== 1 || r() < 0.3) continue;
          if (T.burialProp === 'soldier_statue') { // a clay soldier, facing down the hall
            addProp({ type: 'soldier_statue', x: wc(xx), z: wc(yy), y: rm.level, rot: alongZ ? 0 : Math.PI / 2, shape: 'circle', r: 0.3, room: rm.id });
            continue;
          }
          slabs.push(addProp({ type: T.burialProp || 'slab', x: wc(xx), z: wc(yy), y: rm.level, rot: alongZ ? 0 : Math.PI / 2,
            shape: 'box', hw: alongZ ? 0.4 : 0.85, hd: alongZ ? 0.85 : 0.4, room: rm.id }));
        }
      }
    });

    // Sealed doors: the treasure room, and sometimes one more deep room, are shut
    // behind stone doors carved with runes. Never the entrance, never the tunnel's room.
    var RN = D.runes, doors = [], dr = makeRng(seed + ':' + tombId + ':doors'), sealed = [];
    if (treasure.id !== tr.id) sealed.push(treasure);
    var extraSeal = rooms.filter(function (rm) { return rm.type !== 'entrance' && rm.type !== 'chasm' && rm !== treasure && rm.id !== tr.id && rm.dist >= maxDist * 0.5; });
    if (extraSeal.length && dr() < RN.extraSealChance) sealed.push(extraSeal[Math.floor(dr() * extraSeal.length)]);
    sealed.forEach(function (rm) {
      var code = [];
      for (var ci = 0; ci < RN.codeLength; ci++) code.push(Math.floor(dr() * RN.glyphs));
      for (var yy = rm.y; yy < rm.y + rm.h; yy++) {
        for (var xx = rm.x; xx < rm.x + rm.w; xx++) {
          for (var k3 = 0; k3 < 4; k3++) {
            var ox = xx + DIRS[k3][0], oy = yy + DIRS[k3][1];
            if (ox >= rm.x && ox < rm.x + rm.w && oy >= rm.y && oy < rm.y + rm.h) continue;
            var oc = id(ox, oy), rc = id(xx, yy);
            if (kind[oc] !== INSIDE) continue;
            var dx = (xx + 0.5 + DIRS[k3][0] * 0.5) * cs, dz = (yy + 0.5 + DIRS[k3][1] * 0.5) * cs;
            var alongX = DIRS[k3][0] === 0; // the slab runs along x when the doorway faces z
            var door = { id: doors.length, room: rm.id, x: dx, z: dz, alongX: alongX, facing: k3,
              bottom: Math.min(floor[rc], floor[oc]), top: Math.min(ceil[rc], ceil[oc]), code: code, open: false, timer: 0 };
            doors.push(door);
            addProp({ type: 'door', door: door.id, x: dx, z: dz, y: door.bottom, shape: 'box', hw: alongX ? 1.0 : 0.15, hd: alongX ? 0.15 : 1.0 });
          }
        }
      }
    });

    // ---------- hazards (Pharaoh's Tomb) ----------
    var jackals = [], jars = [], traps = [];
    hz = makeRng(seed + ':' + tombId + ':hazards');
    if (HZ && HZ.jackals) {
      var sealedRoom = {};
      doors.forEach(function (d) { sealedRoom[d.room] = true; });
      function doorwayOf(rm) { // a room-edge cell with a passage leading out, and the direction out
        for (var t3 = 0; t3 < 40; t3++) {
          var xx = hz.int(rm.x, rm.x + rm.w - 1), yy = hz.int(rm.y, rm.y + rm.h - 1);
          for (var k4 = 0; k4 < 4; k4++) {
            var ox = xx + DIRS[k4][0], oy = yy + DIRS[k4][1];
            if (room[id(ox, oy)] === rm.id || kind[id(ox, oy)] !== INSIDE) continue;
            return { x: xx, y: yy, dir: k4 };
          }
        }
        return null;
      }
      // Jackal Wardens sit beside doorways into the deeper rooms, facing whoever comes through.
      var jr = rooms.filter(function (rm) { return rm.type !== 'entrance' && rm.type !== 'treasure' && rm.id !== tr.id && rm.dist >= maxDist * 0.3 && !sealedRoom[rm.id]; });
      var nj = hz.int(HZ.jackals[0], HZ.jackals[1]);
      for (var ja = 0; ja < 30 && jackals.length < nj && jr.length; ja++) {
        var jrm = jr[Math.floor(hz() * jr.length)];
        if (jackals.some(function (j) { return j.room === jrm.id; })) continue;
        var dw = doorwayOf(jrm);
        if (!dw) continue;
        var dv2 = DIRS[dw.dir], side = hz() < 0.5 ? 1 : -1;
        var jx = wc(dw.x) + dv2[1] * 0.74 * side + dv2[0] * 0.2, jz = wc(dw.y) + dv2[0] * 0.74 * side + dv2[1] * 0.2;
        var jk = { x: jx, z: jz, y: jrm.level, rot: Math.atan2(dv2[0], dv2[1]), room: jrm.id };
        jackals.push(jk);
        addProp({ type: 'jackal', x: jx, z: jz, y: jrm.level, rot: jk.rot, shape: 'circle', r: 0.35 });
      }
      // Cracked jars, full of scarabs, in corridors and rooms.
      var jarCells = [];
      for (c = 0; c < N; c++) if (kind[c] === INSIDE && tag[c] !== TAG_TUNNEL && depth[c] >= 3) jarCells.push(c);
      var njar = HZ.jars ? hz.int(HZ.jars[0], HZ.jars[1]) : 0;
      for (var jn = 0; jn < 40 && jars.length < njar && jarCells.length; jn++) {
        var jc = jarCells[Math.floor(hz() * jarCells.length)];
        var jx2 = wc(jc % W) + (hz() - 0.5) * 1.2, jz2 = wc((jc / W) | 0) + (hz() - 0.5) * 1.2;
        if (jars.some(function (j) { return Math.hypot(j.x - jx2, j.z - jz2) < 6; })) continue;
        jars.push({ x: jx2, z: jz2, y: floor[jc] });
        addProp({ type: 'cracked_jar', x: jx2, z: jz2, y: floor[jc], rot: hz() * 6.28 });
      }
      // Sand traps: a pressure plate in the middle of a chamber.
      var tr2 = rooms.filter(function (rm) { return rm.type === 'chamber' && rm.id !== tr.id && !sealedRoom[rm.id] && rm.w >= 3 && rm.h >= 3; });
      var nt = HZ.traps ? hz.int(HZ.traps[0], HZ.traps[1]) : 0;
      for (var tn = 0; tn < 20 && traps.length < nt && tr2.length; tn++) {
        var trm2 = tr2[Math.floor(hz() * tr2.length)];
        if (traps.some(function (t4) { return t4.room === trm2.id; })) continue;
        var maxLevel = Infinity;
        for (var yy2 = trm2.y; yy2 < trm2.y + trm2.h; yy2++) for (var xx2 = trm2.x; xx2 < trm2.x + trm2.w; xx2++) {
          var cc5 = id(xx2, yy2); maxLevel = Math.min(maxLevel, ceil[cc5] - floor[cc5] - 0.3);
        }
        traps.push({ room: trm2.id, x: wc(trm2.cx), z: wc(trm2.cy), y: trm2.level, max: maxLevel });
        addProp({ type: 'plate', x: wc(trm2.cx), z: wc(trm2.cy), y: trm2.level });
      }
    }

    // ---------- hazards (Dwarf Ossuary) ----------
    var caveins = [], lamps = [], roosts = [], rail = null, railCell = {};
    function roomOf(c2) { return room[c2] >= 0 ? rooms[room[c2]] : null; }
    function propNear(px, pz, rad) {
      return props.some(function (p) { return p.shape && !p.ship && Math.hypot(px - p.x, pz - p.z) < rad + (p.shape === 'circle' ? p.r : Math.max(p.hw, p.hd)); });
    }
    if (HZ && HZ.caveins) {
      // Weak ceilings: straight runs of corridor, away from rooms, shored up with split timbers.
      var weak = [];
      for (c = 0; c < N; c++) {
        if (tag[c] !== TAG_CORRIDOR || depth[c] < 2 || ceil[c] - floor[c] < 1.9) continue;
        var wx0 = c % W, wy0 = (c / W) | 0, open4 = [];
        for (k = 0; k < 4; k++) if (kind[id(wx0 + DIRS[k][0], wy0 + DIRS[k][1])] === INSIDE) open4.push(k);
        if (open4.length !== 2 || (open4[0] + 2) % 4 !== open4[1]) continue;
        var nearRoom = false;
        for (var ry = -1; ry <= 1; ry++) for (var rx = -1; rx <= 1; rx++) if (room[id(wx0 + rx, wy0 + ry)] >= 0) nearRoom = true;
        if (!nearRoom) weak.push({ c: c, axis: open4[0] % 2 });
      }
      var ncv = hz.int(HZ.caveins[0], HZ.caveins[1]);
      for (a = 0; a < 80 && caveins.length < ncv && weak.length; a++) {
        var wk = weak[Math.floor(hz() * weak.length)], wxc = wc(wk.c % W), wzc = wc((wk.c / W) | 0);
        if (caveins.some(function (cv) { return Math.hypot(cv.x - wxc, cv.z - wzc) < 9; })) continue;
        var dv3 = DIRS[wk.axis], cells2 = [wk.c];
        [1, -1].forEach(function (sgn) { var nc = id((wk.c % W) + dv3[0] * sgn, ((wk.c / W) | 0) + dv3[1] * sgn); if (tag[nc] === TAG_CORRIDOR) cells2.push(nc); });
        caveins.push({ x: wxc, z: wzc, y: floor[wk.c], top: ceil[wk.c], cells: cells2, alongX: wk.axis === 1 });
        addProp({ type: 'weak_timber', x: wxc, z: wzc, y: floor[wk.c], top: ceil[wk.c], alongX: wk.axis === 1 });
      }
    }
    if (HZ && HZ.carts) {
      // A mine-cart rail: from the entrance hall along the passages to the farthest room
      // it can reach without crossing a chasm, a rune door or a tomb, and never uphill in a crawlway.
      var sealedIds = {};
      doors.forEach(function (d) { sealedIds[d.room] = true; });
      var railOk = function (c3) {
        if (kind[c3] !== INSIDE || tag[c3] === TAG_TUNNEL || (chasm && chasm[c3])) return false;
        var rm3 = roomOf(c3);
        if (rm3 && (sealedIds[rm3.id] || rm3.type === 'treasure' || rm3.id === tr.id)) return false;
        return !propNear(wc(c3 % W), wc((c3 / W) | 0), 0.75);
      };
      var from = id(rooms[0].cx, rooms[0].cy), rprev = new Int32Array(N).fill(-2), rq = [from];
      rprev[from] = -1;
      for (var ri = 0; ri < rq.length; ri++) {
        var rcur = rq[ri], rx0 = rcur % W, ry0 = (rcur / W) | 0;
        for (k = 0; k < 4; k++) {
          var rn = id(rx0 + DIRS[k][0], ry0 + DIRS[k][1]);
          if (rprev[rn] !== -2 || !railOk(rn) || Math.abs(floor[rn] - floor[rcur]) > D.player.stepUp) continue;
          rprev[rn] = rcur; rq.push(rn);
        }
      }
      var bestRm = null, bestLen = 0, bestScore = -Infinity;
      rooms.forEach(function (rm) {
        if (rm.type === 'entrance' || rm.type === 'chasm' || rm.type === 'treasure' || sealedIds[rm.id] || rm.dist < maxDist * 0.35) return;
        var tc = id(rm.cx, rm.cy);
        if (rprev[tc] === -2) return;
        var len = 0;
        for (var pc = tc; pc !== -1; pc = rprev[pc]) len++;
        var score = len <= 40 ? len : 80 - len; // deep, but not an endless ride
        if (!bestRm || score > bestScore) { bestScore = score; bestLen = len; bestRm = rm; }
      });
      if (bestRm && bestLen >= HZ.cartMinCells) {
        var rcells = [];
        for (var pc2 = id(bestRm.cx, bestRm.cy); pc2 !== -1; pc2 = rprev[pc2]) rcells.unshift(pc2);
        var pts3 = rcells.map(function (c4) { return { x: wc(c4 % W), y: floor[c4], z: wc((c4 / W) | 0) }; });
        var total = 0;
        pts3.forEach(function (pt, i2) { pt.s = i2 ? total += Math.hypot(pt.x - pts3[i2 - 1].x, pt.z - pts3[i2 - 1].z) : 0; });
        rcells.forEach(function (c5) { railCell[c5] = true; });
        rail = { cells: rcells, pts: pts3, len: total, room: bestRm.id };
      }
    }
    if (HZ && HZ.lamps) {
      // Dwarven lamps, some still burning, on the walls of the halls.
      rooms.forEach(function (rm) {
        if (rm.type !== 'entrance' && hz() > HZ.lamps) return;
        var want = rm.type === 'entrance' ? 2 : 1;
        for (var t5 = 0; t5 < 30 && want > 0; t5++) {
          var lx = hz.int(rm.x, rm.x + rm.w - 1), ly = hz.int(rm.y, rm.y + rm.h - 1), lk = hz.int(0, 3);
          var lc = id(lx, ly);
          if (kind[id(lx + DIRS[lk][0], ly + DIRS[lk][1])] !== SOLID || (chasm && chasm[lc] === 1)) continue;
          var lpx = wc(lx) + DIRS[lk][0] * 0.88, lpz = wc(ly) + DIRS[lk][1] * 0.88;
          if (lamps.some(function (l) { return Math.hypot(l.x - lpx, l.z - lpz) < 3; })) continue;
          lamps.push({ x: lpx, z: lpz, y: Math.min(floor[lc] + 1.9, ceil[lc] - 0.35), dir: lk, cell: lc, room: rm.id });
          want--;
        }
      });
    }
    // Bat roosts: bats are wanderers, so any tomb may have one under a high ceiling
    // (several in their home tombs, chasms first).
    var WB = D.wanderers.bats, batsHome = WB.home.indexOf(tombId) >= 0, br = makeRng(seed + ':' + tombId + ':roosts');
    var rr = rooms.filter(function (rm) { return rm.type !== 'entrance' && rm.type !== 'treasure' && ceil[id(rm.cx, rm.cy)] - rm.level >= (batsHome ? 2.7 : 2.5); });
    for (var ri2 = rr.length - 1; ri2 > 0; ri2--) { var rj = Math.floor(br() * (ri2 + 1)), rt = rr[ri2]; rr[ri2] = rr[rj]; rr[rj] = rt; }
    rr = rr.filter(function (rm) { return rm.type === 'chasm'; }).concat(rr.filter(function (rm) { return rm.type !== 'chasm'; }));
    var rN = batsHome ? WB.roostsHome : WB.roostsAway, nr = rN[0] + Math.floor(br() * (rN[1] - rN[0] + 1));
    rr.slice(0, nr).forEach(function (rm) {
      var rc3 = id(rm.cx, rm.cy);
      roosts.push({ x: wc(rm.cx), z: wc(rm.cy), y: ceil[rc3] - 0.25, floor: rm.level, room: rm.id });
    });

    // Cover: crates and barrels standing near the walls of the halls, tall enough to
    // crouch behind. Never in a doorway, on the rails, or over a chasm.
    var cvr = makeRng(seed + ':' + tombId + ':cover');
    rooms.forEach(function (rm) {
      if (rm.type === 'chasm' || rm.w < 3 || rm.h < 3) return;
      var want = (rm.type === 'entrance' ? 1 : 1 + (rm.w * rm.h >= 16 ? 1 : 0)) + (cvr() < 0.35 ? 1 : 0) + (rm.type !== 'entrance' ? T.coverPerRoom || 0 : 0);
      for (var t6 = 0; t6 < 30 && want > 0; t6++) {
        var side = Math.floor(cvr() * 4), dv5 = DIRS[side];
        var along = side % 2 === 0 ? rm.x + Math.floor(cvr() * rm.w) : rm.y + Math.floor(cvr() * rm.h);
        var cx5 = side === 1 ? rm.x + rm.w - 1 : side === 3 ? rm.x : along, cy5 = side === 2 ? rm.y + rm.h - 1 : side === 0 ? rm.y : along;
        var c6 = id(cx5, cy5);
        if (kind[id(cx5 + dv5[0], cy5 + dv5[1])] !== SOLID || railCell[c6] || (chasm && chasm[c6])) continue;
        var doorway = false; // keep clear of any doorway along this wall, and of the cells either side of one
        for (var j6 = -1; j6 < 4; j6++) {
          var ax6 = cx5 + (j6 < 0 ? 0 : DIRS[j6][0]), ay6 = cy5 + (j6 < 0 ? 0 : DIRS[j6][1]);
          if (j6 >= 0 && room[id(ax6, ay6)] !== rm.id) continue;
          for (var k6 = 0; k6 < 4; k6++) { var nb6 = id(ax6 + DIRS[k6][0], ay6 + DIRS[k6][1]); if (kind[nb6] === INSIDE && room[nb6] !== rm.id) doorway = true; }
        }
        if (doorway) continue;
        // a goblin's width off the wall, so there's room to crouch behind it
        var barrel = cvr() < 0.45, px6 = wc(cx5) + (dv5[0] ? 0 : (cvr() - 0.5) * 0.6), pz6 = wc(cy5) + (dv5[1] ? 0 : (cvr() - 0.5) * 0.6);
        if (propNear(px6, pz6, 1.05)) continue; // leave a goblin's width between it and anything else
        if (T.style === 'cave') addProp({ type: 'giant_cap', x: px6, z: pz6, y: rm.level, rot: cvr() * 6.28, h: 1.9 + cvr() * 1.2, shape: 'circle', r: 0.36, room: rm.id });
        else if (barrel) addProp({ type: 'barrel', x: px6, z: pz6, y: rm.level, rot: cvr() * 6.28, shape: 'circle', r: 0.32, room: rm.id });
        else addProp({ type: 'crate', x: px6, z: pz6, y: rm.level, rot: (cvr() - 0.5) * 0.3, shape: 'box', hw: 0.38, hd: 0.38, room: rm.id });
        want--;
      }
    });

    // ---------- the Dwarf Ossuary: carved halls ----------
    // Square pillars hold up the big halls, stone guardians flank doorways, and a forge
    // still smoulders in one hall. Its own random stream, so the rest of the tomb stays put.
    var forges = [], DH = T.halls, dh = makeRng(seed + ':' + tombId + ':halls');
    if (DH) {
      var hallOk = function (rm) { return rm.type !== 'chasm' && rm.type !== 'treasure' && rm.id !== tr.id; };
      var clearCell = function (c7) { return !railCell[c7] && !(chasm && chasm[c7]); };
      rooms.forEach(function (rm) {
        if (rm.type !== 'chamber' || !hallOk(rm) || rm.w < 5 || rm.h < 5) return;
        [[1, 1], [rm.w - 2, 1], [1, rm.h - 2], [rm.w - 2, rm.h - 2]].forEach(function (o) {
          var c7 = id(rm.x + o[0], rm.y + o[1]), px7 = wc(rm.x + o[0]), pz7 = wc(rm.y + o[1]);
          if (!clearCell(c7) || propNear(px7, pz7, 1.1)) return;
          addProp({ type: 'dwarf_pillar', x: px7, z: pz7, y: rm.level, h: ceil[c7] - floor[c7], shape: 'box', hw: 0.32, hd: 0.32, room: rm.id });
        });
      });
      // Guardians: a pair of carved dwarves either side of a doorway, facing whoever comes in.
      var nStat = dh.int(DH.statues[0], DH.statues[1]), statued = {};
      for (var sa = 0; sa < 60 && nStat > 0; sa++) {
        var srm = rooms[Math.floor(dh() * rooms.length)];
        if (!hallOk(srm) || statued[srm.id] || srm.w < 3 || srm.h < 3) continue;
        var sx7 = dh.int(srm.x, srm.x + srm.w - 1), sy7 = dh.int(srm.y, srm.y + srm.h - 1), sk7 = -1;
        for (var k7 = 0; k7 < 4; k7++) {
          var on7 = id(sx7 + DIRS[k7][0], sy7 + DIRS[k7][1]);
          if (kind[on7] === INSIDE && room[on7] !== srm.id) sk7 = k7;
        }
        var sc7 = id(sx7, sy7);
        if (sk7 < 0 || !clearCell(sc7)) continue;
        var dv7 = DIRS[sk7], spots7 = [-1, 1].map(function (sd) {
          return [wc(sx7) + dv7[1] * 0.74 * sd - dv7[0] * 0.25, wc(sy7) + dv7[0] * 0.74 * sd - dv7[1] * 0.25];
        });
        if (spots7.some(function (s7) { return propNear(s7[0], s7[1], 0.45); })) continue;
        spots7.forEach(function (s7) {
          addProp({ type: 'dwarf_statue', x: s7[0], z: s7[1], y: srm.level, rot: Math.atan2(dv7[0], dv7[1]), shape: 'circle', r: 0.3, room: srm.id });
        });
        statued[srm.id] = true; nStat--;
      }
      // The forge: a stone hearth against a hall wall, coals still glowing.
      var nForge = dh.int(DH.forges[0], DH.forges[1]);
      for (var fa = 0; fa < 60 && forges.length < nForge; fa++) {
        var frm = rooms[Math.floor(dh() * rooms.length)];
        if (frm.type !== 'chamber' || !hallOk(frm) || frm.w < 3 || frm.h < 3 || forges.some(function (f) { return f.room === frm.id; })) continue;
        var fside = dh.int(0, 3), fdv = DIRS[fside];
        var falong = fside % 2 === 0 ? dh.int(frm.x + 1, frm.x + frm.w - 2) : dh.int(frm.y + 1, frm.y + frm.h - 2);
        var fcx = fside === 1 ? frm.x + frm.w - 1 : fside === 3 ? frm.x : falong, fcy = fside === 2 ? frm.y + frm.h - 1 : fside === 0 ? frm.y : falong;
        var fc = id(fcx, fcy);
        if (kind[id(fcx + fdv[0], fcy + fdv[1])] !== SOLID || !clearCell(fc)) continue;
        var fdoor = false;
        for (var k8 = 0; k8 < 4; k8++) { var nb8 = id(fcx + DIRS[k8][0], fcy + DIRS[k8][1]); if (kind[nb8] === INSIDE && room[nb8] !== frm.id) fdoor = true; }
        if (fdoor) continue;
        var ffx = wc(fcx) + fdv[0] * 0.45, ffz = wc(fcy) + fdv[1] * 0.45;
        if (propNear(ffx, ffz, 0.9)) continue;
        forges.push({ x: ffx - fdv[0] * 0.2, z: ffz - fdv[1] * 0.2, y: frm.level + 0.8, cell: fc, dir: fside, room: frm.id });
        addProp({ type: 'forge', x: ffx, z: ffz, y: frm.level, dir: fside, shape: 'box', hw: fdv[0] ? 0.5 : 0.8, hd: fdv[0] ? 0.8 : 0.5, room: frm.id });
      }
    }

    // ---------- the Mushroom Warren: glowcaps and puffballs ----------
    var glowcaps = [], puffballs = [];
    if (HZ && HZ.glowcaps) {
      var gr = makeRng(seed + ':' + tombId + ':glow');
      var floorSpot = function (rm, margin) { // a clear spot on a room's floor
        for (var t8 = 0; t8 < 20; t8++) {
          var fx = (rm.x + margin + gr() * (rm.w - 2 * margin)) * cs, fz = (rm.y + margin + gr() * (rm.h - 2 * margin)) * cs;
          if (!propNear(fx, fz, 0.7)) return [fx, fz];
        }
        return null;
      };
      rooms.forEach(function (rm) {
        var ng = HZ.glowcaps[0] + Math.floor(gr() * (HZ.glowcaps[1] - HZ.glowcaps[0] + 1));
        for (var i8 = 0; i8 < ng; i8++) {
          var sp8 = floorSpot(rm, 0.15);
          if (sp8) glowcaps.push({ x: sp8[0], z: sp8[1], y: rm.level, cell: cellOf(sp8[0], sp8[1]), room: rm.id });
        }
      });
      var pr = rooms.filter(function (rm) { return rm.type !== 'entrance'; });
      var np = HZ.puffballs[0] + Math.floor(gr() * (HZ.puffballs[1] - HZ.puffballs[0] + 1));
      for (var i9 = 0; i9 < np * 4 && puffballs.length < np && pr.length; i9++) {
        var prm = pr[Math.floor(gr() * pr.length)], sp9 = floorSpot(prm, 0.3);
        if (!sp9 || puffballs.some(function (q) { return Math.hypot(q.x - sp9[0], q.z - sp9[1]) < 5; })) continue;
        puffballs.push({ x: sp9[0], z: sp9[1], y: prm.level, room: prm.id });
        addProp({ type: 'puffball', x: sp9[0], z: sp9[1], y: prm.level });
      }
    }

    // ---------- the Yomi Shrine: paper walls, singing floors, hanging lanterns ----------
    var paper = null, hangLanterns = [];
    if (HZ && HZ.paper) {
      var yr = makeRng(seed + ':' + tombId + ':shrine');
      paper = new Uint8Array(N);
      // a wall one cell thick between two passages may be a paper screen
      for (var py2 = I.y0; py2 < I.y1; py2++) for (var px5 = I.x0; px5 < I.x1; px5++) {
        var pc5 = id(px5, py2);
        if (kind[pc5] !== SOLID) continue;
        var ew2 = kind[id(px5 - 1, py2)] === INSIDE && kind[id(px5 + 1, py2)] === INSIDE, ns2 = kind[id(px5, py2 - 1)] === INSIDE && kind[id(px5, py2 + 1)] === INSIDE;
        if ((ew2 || ns2) && yr() < HZ.paper) paper[pc5] = 1;
      }
      for (c = 0; c < N; c++) if (tag[c] === TAG_CORRIDOR && yr() < HZ.nightingale) surf[c] = SURF.nightingale;
      var spots = [];
      for (c = 0; c < N; c++) if (kind[c] === INSIDE && tag[c] !== TAG_TUNNEL && !(chasm && chasm[c]) && ceil[c] - floor[c] > 1.9) spots.push(c);
      var nl = HZ.lanterns[0] + Math.floor(yr() * (HZ.lanterns[1] - HZ.lanterns[0] + 1));
      for (var li = 0; li < nl * 6 && hangLanterns.length < nl && spots.length; li++) {
        var lc2 = spots[Math.floor(yr() * spots.length)], lx4 = wc(lc2 % W), lz4 = wc((lc2 / W) | 0);
        if (hangLanterns.some(function (hl) { return Math.hypot(hl.x - lx4, hl.z - lz4) < 5; })) continue;
        if (room[lc2] === 0) continue; // not in the entrance hall
        hangLanterns.push({ x: lx4, z: lz4, y: ceil[lc2] - 0.55, floor: floor[lc2], cell: lc2, obake: false });
      }
      var no = HZ.obake[0] + Math.floor(yr() * (HZ.obake[1] - HZ.obake[0] + 1));
      hangLanterns.slice().sort(function (p, q) { return (depth[q.cell] - depth[p.cell]) || (p.cell - q.cell); }).slice(0, no).forEach(function (hl) { hl.obake = true; });
    }

    // ---------- loot ----------
    // A separate random stream, so loot changes never reshuffle the tomb's layout.
    var LT = T.loot, lr = makeRng(seed + ':' + tombId + ':loot');
    var itemSpawns = [], chests = [];
    var lootIds = Object.keys(D.items).filter(function (key) {
      var it = D.items[key];
      return it.rarity > 0 && (it.tombs === 'any' || it.tombs === tombId);
    });
    function rollDef(depthT, handSized) { // handSized: only what fits in a chest or on a lid
      var total = 0;
      var ws = lootIds.map(function (key) {
        var it = D.items[key];
        var wgt = depthT + 0.15 >= it.depth && !(handSized && it.weight === 'twoHanded') ? it.rarity * (1 + depthT * it.depth * 3) : 0;
        total += wgt;
        return wgt;
      });
      var pick = lr() * total;
      for (var i = 0; i < lootIds.length; i++) { pick -= ws[i]; if (pick <= 0) return lootIds[i]; }
      return lootIds[0];
    }
    function spawnItem(def, x, y, z, depthT, chest) {
      var v = D.items[def].value, u = Math.pow(lr(), 1.4 - depthT * 0.8); // deeper rolls lean high
      itemSpawns.push({ def: def, value: Math.round(v[0] + (v[1] - v[0]) * u), x: x, y: y, z: z,
        rot: lr() * Math.PI * 2, chest: chest == null ? -1 : chest });
    }
    function spotFree(px, pz, rad) {
      for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (!p.shape) continue;
        var ex = p.shape === 'circle' ? p.r : Math.max(p.hw, p.hd);
        if (Math.hypot(px - p.x, pz - p.z) < ex + rad) return false;
      }
      for (i = 0; i < itemSpawns.length; i++) if (Math.hypot(px - itemSpawns[i].x, pz - itemSpawns[i].z) < 0.5) return false;
      return true;
    }
    function depthOf(rm) { return maxDist > 0 ? Math.min(1, rm.dist / maxDist) : 0; }
    function roomSpot(rm) {
      for (var t2 = 0; t2 < 20; t2++) {
        var px = rm.x * cs + 0.5 + lr() * (rm.w * cs - 1), pz = rm.y * cs + 0.5 + lr() * (rm.h * cs - 1);
        if (spotFree(px, pz, 0.35)) return [px, pz];
      }
      return null;
    }

    // Chests stand against a wall, facing into their room.
    var nChests = lr.int(LT.chests[0], LT.chests[1]);
    var chestRooms = rooms.filter(function (rm) { return rm.type !== 'entrance' && rm.type !== 'chasm'; });
    for (a = 0; a < 60 && chests.length < nChests; a++) {
      var crm = chestRooms[Math.floor(Math.pow(lr(), 0.7) * chestRooms.length)];
      var side = lr.int(0, 3), dv = DIRS[side];
      var along = side % 2 === 0 ? lr.int(crm.x, crm.x + crm.w - 1) : lr.int(crm.y, crm.y + crm.h - 1);
      var ccx2 = side === 1 ? crm.x + crm.w - 1 : side === 3 ? crm.x : along;
      var ccy2 = side === 2 ? crm.y + crm.h - 1 : side === 0 ? crm.y : along;
      if (kind[id(ccx2 + dv[0], ccy2 + dv[1])] !== SOLID || railCell[id(ccx2, ccy2)]) continue; // not in front of a doorway, nor on the rails
      var chx = wc(ccx2) + dv[0] * 0.55, chz = wc(ccy2) + dv[1] * 0.55;
      if (!spotFree(chx, chz, 0.6)) continue;
      var ci = chests.length;
      chests.push({ x: chx, z: chz, y: crm.level, rot: Math.atan2(-dv[0], -dv[1]), room: crm.id });
      addProp({ type: 'chest', x: chx, z: chz, y: crm.level, rot: Math.atan2(-dv[0], -dv[1]), shape: 'box',
        hw: dv[0] ? 0.3 : 0.45, hd: dv[0] ? 0.45 : 0.3, chest: ci });
      var cdepth = Math.min(1, depthOf(crm) + 0.15), nIn = lr.int(LT.chestItems[0], LT.chestItems[1]);
      for (var ii = 0; ii < nIn; ii++) {
        var slot = (ii - (nIn - 1) / 2) * 0.32 + (lr() - 0.5) * 0.06; // side by side along the chest, so each shows when it opens
        spawnItem(rollDef(cdepth, true), chx + (dv[0] ? 0 : slot), crm.level + 0.14, chz + (dv[0] ? slot : 0), cdepth, ci);
      }
    }

    // Loose loot in rooms: more, and better, the deeper you go.
    rooms.forEach(function (rm) {
      if (rm.type === 'entrance' || rm.type === 'chasm') return;
      var dT = depthOf(rm);
      var count = Math.max(0, Math.round(LT.perRoom + dT * LT.perRoomDepth + (lr() - 0.5)));
      for (var i = 0; i < count; i++) {
        var spot = roomSpot(rm);
        if (spot) spawnItem(rollDef(dT), spot[0], rm.level, spot[1], dT);
      }
    });
    // Grave goods left on burial slabs, at the foot of the carved effigy.
    slabs.forEach(function (sl) {
      if (lr() >= LT.slabGoods) return;
      var dT = depthOf(rooms[sl.room]), off = (lr() < 0.5 ? -1 : 1) * 0.72;
      spawnItem(rollDef(dT, true), sl.x + (sl.rot ? off : 0), sl.y + 0.62, sl.z + (sl.rot ? 0 : off), dT);
    });
    // The treasure room: an arm-ring on the plinth and a hoard urn on the floor.
    if (plinth) {
      var trm = rooms[plinth.room];
      spawnItem(LT.treasure.plinth, plinth.x, plinth.y + (plinth.small ? 0.96 : 1.06), plinth.z, 1);
      if (sarcophagus) spawnItem(LT.treasure.lid, sarcophagus.x, sarcophagus.y + 0.9, sarcophagus.z, 1);
      else { var us = roomSpot(trm); if (us) spawnItem(LT.treasure.floor, us[0], trm.level, us[1], 1); }
    }
    // A few things dropped in the corridors by earlier robbers.
    var corridorCells = [];
    for (c = 0; c < N; c++) if (tag[c] === TAG_CORRIDOR) corridorCells.push(c);
    for (i = 0; i < LT.corridorItems && corridorCells.length; i++) {
      var cc4 = corridorCells[Math.floor(lr() * corridorCells.length)];
      var dT2 = Math.min(1, Math.max(0, depth[cc4]) / Math.max(1, maxDist));
      var ix = cc4 % W, iy = (cc4 / W) | 0;
      spawnItem(rollDef(dT2), wc(ix) + (lr() - 0.5) * 1.2, floor[cc4], wc(iy) + (lr() - 0.5) * 1.2, dT2);
    }

    // Index solid props by the cells they touch, for fast collision checks.
    var propCells = {};
    props.forEach(function (p, pi) {
      if (!p.shape) return;
      var ex = p.shape === 'circle' ? p.r : p.hw, ez = p.shape === 'circle' ? p.r : p.hd;
      for (var yy = Math.floor((p.z - ez) / cs); yy <= Math.floor((p.z + ez) / cs); yy++) {
        for (var xx = Math.floor((p.x - ex) / cs); xx <= Math.floor((p.x + ex) / cs); xx++) {
          var key = id(xx, yy);
          (propCells[key] = propCells[key] || []).push(pi);
        }
      }
    });

    // Goblins start on deck by the gangway, facing the tomb.
    var spawn = { x: scx + 1.2, z: scz + 0.5 };
    spawn.yaw = Math.atan2(-(wc(entranceX) - spawn.x), -(I.y0 * cs - spawn.z));

    return {
      seed: String(seed), tombId: tombId, tomb: T, cs: cs, W: W, H: H,
      kind: kind, floor: floor, ceil: ceil, surf: surf, room: room, tag: tag,
      rooms: rooms, props: props, propCells: propCells,
      ship: ship, spawn: spawn, itemSpawns: itemSpawns, chests: chests,
      entrance: { x: wc(entranceX), z: I.y0 * cs, cell: entranceOut },
      exit: { x: wc(exitOut.x), z: wc(exitOut.y), cell: exitOut },
      tunnelRoom: tr.id, treasureRoom: treasure.id, tunnelFallback: !!plan.fallback, doors: doors,
      sarcophagus: sarcophagus, jackals: jackals, jars: jars, traps: traps, sand: new Float32Array(N), tide: -1e9,
      chasm: chasm, bridgeMask: bridgeMask, chasmDrop: chasmDrop, caveins: caveins, rail: rail, lamps: lamps, forges: forges, roosts: roosts,
      glowcaps: glowcaps, puffballs: puffballs, paper: paper, hangLanterns: hangLanterns
    };
  }

  // ---------- Craig's warren ----------
  // A fixed crater ringed by cliffs: the Gutbucket's landing spot at the south end,
  // Craig's pit in the middle behind a rail, and his throne on the far side.
  function makeShip(scx, scz) {
    var G = D.gutbucket, hl = G.length / 2, hw = G.width / 2;
    return {
      x: scx, z: scz, deck: G.deck, lift: 0,
      x0: scx - hl, x1: scx + hl, z0: scz - hw, z1: scz + hw,
      helm: { x: scx - hl + 0.8, z: scz },
      barrel: { x: scx - hl + 0.8, z: scz - hw + 0.6 },
      hatch: { x: scx + hl - 1.2, z: scz + 0.4 },
      mast: { x: scx + 0.9, z: scz - 0.5 },
      gangway: { x: scx, z: scz + hw },
      // Mortimer's tool rack against the north gunwale, his chart on a board by the helm, and
      // Craig's mood board on the mast, where you can read it from anywhere on deck.
      rack: { x: scx - hl + 3.3 + (D.shop.length - 6) * 0.3, z: scz - hw + 0.22 }, // grows toward the bow as the shop does
      chart: { x: scx - hl + 2.1, z: scz + hw - 0.62, hw: (D.travel.length * 0.4 + 0.25) / 2 }, // hw: half the board's width
      moodboard: { x: scx + 0.9, z: scz - 0.28 },
      pegs: D.shop.map(function (id, i) { return { id: id, x: scx - hl + 3.3 + (D.shop.length - 6) * 0.3 - (D.shop.length - 1) * 0.3 + i * 0.6, z: scz - hw + 0.34, y: G.deck + 0.92 }; }),
      pins: D.travel.map(function (d, i) { return { id: d.id, x: scx - hl + 2.1 - (D.travel.length - 1) * 0.2 + i * 0.4, z: scz + hw - 0.6, y: G.deck + 1.08 }; }),
      // Fitted upgrades that stand on deck: the scrying bowl by the helm (and the oil barrel, above).
      bowl: { x: scx - hl + 1.6, z: scz - 1.0 },
      gangwayUp: false, // pulled up by a goblin on deck (mutable, like lift; reset each night)
      hasBarrel: false // the oil barrel is an upgrade (set from the campaign each night, and when it's bought)
    };
  }
  function shipProps(ship) {
    var G = D.gutbucket, hl = G.length / 2, hw = G.width / 2, gw = G.gangway / 2, gt = 0.08, out = [];
    var scx = ship.x, scz = ship.z;
    out.push({ type: 'gunwale', x: scx, z: ship.z0 + gt, shape: 'box', hw: hl, hd: gt });
    out.push({ type: 'gangwayUp', x: scx, z: ship.z1 - gt, shape: 'box', hw: gw + 0.1, hd: gt, gangway: true }); // only there while it's pulled up
    out.push({ type: 'gunwale', x: (ship.x0 + scx - gw) / 2, z: ship.z1 - gt, shape: 'box', hw: (hl - gw) / 2, hd: gt });
    out.push({ type: 'gunwale', x: (scx + gw + ship.x1) / 2, z: ship.z1 - gt, shape: 'box', hw: (hl - gw) / 2, hd: gt });
    out.push({ type: 'gunwale', x: ship.x0 + gt, z: scz, shape: 'box', hw: gt, hd: hw });
    out.push({ type: 'gunwale', x: ship.x1 - gt, z: scz, shape: 'box', hw: gt, hd: hw });
    out.push({ type: 'mast', x: ship.mast.x, z: ship.mast.z, shape: 'circle', r: 0.14 });
    out.push({ type: 'helm', x: ship.helm.x, z: ship.helm.z, shape: 'circle', r: 0.2 });
    out.push({ type: 'barrel', x: ship.barrel.x, z: ship.barrel.z, shape: 'circle', r: 0.32, needsBarrel: true });
    out.push({ type: 'rack', x: ship.rack.x, z: ship.rack.z, shape: 'box', hw: D.shop.length * 0.3 + 0.1, hd: 0.12 });
    out.push({ type: 'chart', x: ship.chart.x, z: ship.chart.z + 0.1, shape: 'box', hw: ship.chart.hw, hd: 0.08 }); // the board on its post
    out.forEach(function (p) { p.ship = true; });
    return out;
  }
  function indexProps(props, cs, W) {
    var propCells = {};
    props.forEach(function (p, pi) {
      if (!p.shape) return;
      var ex = p.shape === 'circle' ? p.r : p.hw, ez = p.shape === 'circle' ? p.r : p.hd;
      for (var yy = Math.floor((p.z - ez) / cs); yy <= Math.floor((p.z + ez) / cs); yy++) {
        for (var xx = Math.floor((p.x - ex) / cs); xx <= Math.floor((p.x + ex) / cs); xx++) {
          var key = yy * W + xx;
          (propCells[key] = propCells[key] || []).push(pi);
        }
      }
    });
    return propCells;
  }

  function createWarren(seed, tombId, T) {
    var cs = D.cellSize, W = T.grid.w, H = T.grid.h, N = W * H;
    var kind = new Uint8Array(N), floor = new Float32Array(N), ceil = new Float32Array(N);
    var surf = new Uint8Array(N), room = new Int16Array(N).fill(-1), tag = new Uint8Array(N);
    var PT = T.pit, pcx = (PT.x + 0.5) * cs, pcz = (PT.y + 0.5) * cs;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var c = y * W + x;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { kind[c] = FIELDWALL; continue; }
        kind[c] = OUTSIDE; surf[c] = SURF[T.floorSurface];
        if (Math.hypot((x + 0.5) * cs - pcx, (y + 0.5) * cs - pcz) <= PT.radius) floor[c] = PT.floor;
      }
    }
    function isPit(cx, cy) { return cx >= 0 && cy >= 0 && cx < W && cy < H && floor[cy * W + cx] === PT.floor && kind[cy * W + cx] === OUTSIDE; }

    var props = [], hooks = [], improve = [];
    var ship = makeShip((T.landing.x + 0.5) * cs, (T.landing.y + 0.5) * cs);
    shipProps(ship).forEach(function (p) { props.push(p); });

    // The rail: posts just outside every pit edge, close enough that no goblin fits
    // between them, low enough to throw over.
    var seen = {};
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        if (!isPit(x, y)) continue;
        for (var k = 0; k < 4; k++) {
          var nx = x + DIRS[k][0], ny = y + DIRS[k][1];
          if (isPit(nx, ny)) continue;
          // the shared edge, pushed 0.25 m out of the pit
          var ex0, ez0, ex1, ez1, off = 0.25;
          if (k === 0) { ex0 = x * cs; ex1 = (x + 1) * cs; ez0 = ez1 = y * cs - off; }
          else if (k === 2) { ex0 = x * cs; ex1 = (x + 1) * cs; ez0 = ez1 = (y + 1) * cs + off; }
          else if (k === 1) { ez0 = y * cs; ez1 = (y + 1) * cs; ex0 = ex1 = (x + 1) * cs + off; }
          else { ez0 = y * cs; ez1 = (y + 1) * cs; ex0 = ex1 = x * cs - off; }
          for (var t = 0; t <= 4; t++) {
            var px = ex0 + (ex1 - ex0) * t / 4, pz = ez0 + (ez1 - ez0) * t / 4;
            // corners of the rail sit off the grid lines; nudge them outward too
            if (k === 0 || k === 2) { if (t === 0 && !isPit(x - 1, y)) px -= off; if (t === 4 && !isPit(x + 1, y)) px += off; }
            else { if (t === 0 && !isPit(x, y - 1)) pz -= off; if (t === 4 && !isPit(x, y + 1)) pz += off; }
            var key = Math.round(px * 10) + ',' + Math.round(pz * 10);
            if (seen[key]) continue;
            seen[key] = true;
            props.push({ type: 'post', x: px, z: pz, shape: 'circle', r: 0.14 });
          }
        }
      }
    }
    // Craig's throne on the far side, and torches round the pit.
    var throne = { x: (T.throne.x + 0.5) * cs, z: (T.throne.y + 0.5) * cs };
    props.push({ type: 'throne', x: throne.x, z: throne.z, shape: 'box', hw: 2.6, hd: 1.8 });
    T.torches.forEach(function (tc) { props.push({ type: 'torch', x: pcx + tc[0], z: pcz + tc[1], shape: 'circle', r: 0.2 }); });
    var board = { x: pcx + T.board[0], z: pcz + T.board[1] };
    props.push({ type: 'board', x: board.x, z: board.z, rot: Math.atan2(ship.x - board.x, ship.z - board.z), shape: 'circle', r: 0.25 });
    // The goblin camp: huts, treasure heaps, the cookfire, totems and braziers stand in the way;
    // the palisade's corner towers and gate towers poke out of the crater wall.
    var CP = T.camp;
    if (CP) {
      CP.huts.forEach(function (h) { props.push({ type: 'hut', x: pcx + h[0], z: pcz + h[1], shape: 'circle', r: h[2] * 0.95, size: h[2] }); });
      CP.hoard.forEach(function (h) { props.push({ type: 'hoard', x: pcx + h[0], z: pcz + h[1], shape: 'circle', r: h[2] * 0.85, size: h[2] }); });
      props.push({ type: 'cookfire', x: pcx + CP.cookfire[0], z: pcz + CP.cookfire[1], shape: 'circle', r: 0.8 });
      CP.totems.forEach(function (t) { props.push({ type: 'totem', x: pcx + t[0], z: pcz + t[1], shape: 'circle', r: 0.22 }); });
      CP.braziers.forEach(function (b) { props.push({ type: 'brazier', x: pcx + b[0], z: pcz + b[1], shape: 'circle', r: 0.4 }); });
      // the wardrobe: a rack with a hook for each cosmetic, facing the landing
      if (CP.wardrobe) {
        var wdx = pcx + CP.wardrobe[0], wdz = pcz + CP.wardrobe[1], wdc = Math.floor(wdz / cs) * W + Math.floor(wdx / cs), wdy = floor[wdc] || 0;
        hooks = D.wardrobe.map(function (id, i) { return { id: id, x: wdx + (i - (D.wardrobe.length - 1) / 2) * 0.55, z: wdz - 0.14, y: wdy + 1.3 }; });
        props.push({ type: 'wardrobe', x: wdx, z: wdz, y: wdy, shape: 'box', hw: D.wardrobe.length * 0.275 + 0.25, hd: 0.12 });
      }
      // the tinkers' board: a card for each Gutbucket upgrade, facing the landing
      if (CP.workshop) {
        var wkx = pcx + CP.workshop[0], wkz = pcz + CP.workshop[1], wkc = Math.floor(wkz / cs) * W + Math.floor(wkx / cs), wky = floor[wkc] || 0;
        improve = D.improvements.map(function (id, i) { return { id: id, x: wkx + (i - (D.improvements.length - 1) / 2) * 0.6, z: wkz - 0.1, y: wky + 1.45 }; });
        props.push({ type: 'workshop', x: wkx, z: wkz, y: wky, shape: 'box', hw: D.improvements.length * 0.3 + 0.2, hd: 0.12 });
      }
      [[cs, cs], [(W - 1) * cs, cs], [cs, (H - 1) * cs], [(W - 1) * cs, (H - 1) * cs], [ship.x - CP.gate - 1, cs], [ship.x + CP.gate + 1, cs]].forEach(function (t, i) {
        props.push({ type: 'tower', x: t[0], z: t[1], shape: 'circle', r: 1.5, gate: i >= 4 });
      });
    }

    var spawn = { x: ship.x + 1.2, z: ship.z + 0.5 };
    spawn.yaw = Math.atan2(-(pcx - spawn.x), -(pcz - spawn.z));
    return {
      seed: String(seed), tombId: tombId, tomb: T, cs: cs, W: W, H: H, warren: true,
      kind: kind, floor: floor, ceil: ceil, surf: surf, room: room, tag: tag,
      rooms: [], props: props, propCells: indexProps(props, cs, W),
      ship: ship, spawn: spawn, itemSpawns: [], chests: [],
      pit: { x: pcx, z: pcz, floor: PT.floor, radius: PT.radius }, throne: throne, board: board, hooks: hooks, improve: improve,
      entrance: { x: pcx, z: pcz }, exit: { x: pcx, z: pcz }, tunnelRoom: -1, treasureRoom: -1, doors: [],
      sarcophagus: null, jackals: [], jars: [], traps: [], sand: new Float32Array(N), tide: -1e9,
      chasm: null, bridgeMask: null, chasmDrop: 0, caveins: [], rail: null, lamps: [], forges: [], roosts: [], glowcaps: [], puffballs: [], paper: null, hangLanterns: []
    };
  }

  // Between days: the Gutbucket hangs over the clouds. Only its deck is floor; its
  // gangway is roped off. You can walk it, shop at the rack, read Craig's mood, pick a pin.
  function createSky(seed, tombId, T) {
    var cs = D.cellSize, W = T.grid.w, H = T.grid.h, N = W * H;
    var kind = new Uint8Array(N), floor = new Float32Array(N), ceil = new Float32Array(N);
    var surf = new Uint8Array(N), room = new Int16Array(N).fill(-1), tag = new Uint8Array(N);
    var ship = makeShip((T.landing.x + 0.5) * cs, (T.landing.y + 0.5) * cs), props = [];
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var c = y * W + x, cx = (x + 0.5) * cs, cz = (y + 0.5) * cs;
      var overShip = (x + 1) * cs > ship.x0 && x * cs < ship.x1 && (y + 1) * cs > ship.z0 && y * cs < ship.z1;
      kind[c] = overShip ? OUTSIDE : SOLID; surf[c] = SURF.wood; floor[c] = overShip ? -40 : 0; // nothing under the deck but cloud
    }
    shipProps(ship).forEach(function (p) { props.push(p); });
    props.push({ type: 'gangrope', x: ship.gangway.x, z: ship.z1 - 0.08, shape: 'box', hw: D.gutbucket.gangway / 2 + 0.1, hd: 0.08, ship: true });
    var spawn = { x: ship.x - 0.5, z: ship.z + 0.4, yaw: Math.atan2(-(ship.moodboard.x - ship.x + 0.5), -(ship.moodboard.z - ship.z - 0.4)) };
    return {
      seed: String(seed), tombId: tombId, tomb: T, cs: cs, W: W, H: H, sky: true,
      kind: kind, floor: floor, ceil: ceil, surf: surf, room: room, tag: tag,
      rooms: [], props: props, propCells: indexProps(props, cs, W),
      ship: ship, spawn: spawn, itemSpawns: [], chests: [],
      entrance: { x: ship.x, z: ship.z }, exit: { x: ship.x, z: ship.z }, tunnelRoom: -1, treasureRoom: -1, doors: [],
      sarcophagus: null, jackals: [], jars: [], traps: [], sand: new Float32Array(N), tide: -1e9,
      chasm: null, bridgeMask: null, chasmDrop: 0, caveins: [], rail: null, lamps: [], forges: [], roosts: [], glowcaps: [], puffballs: [], paper: null, hangLanterns: []
    };
  }

  // Loot from the hold, laid out on the deck from the hatch end. `list` is the item defs (or just a
  // count of small things). Big pieces (an item's `size`, meters across) go down first and keep their
  // room, so nothing pokes through its neighbour or the rail; small things fill the gaps.
  var SMALL_ITEM = 0.4;
  function deckSpots(ship, list) {
    var defs = typeof list === 'number' ? new Array(list).fill(null) : list;
    var sizeOf = function (d) { return (d && D.items[d] && D.items[d].size) || SMALL_ITEM; };
    var order = defs.map(function (d, i) { return i; }).sort(function (a, b) { return sizeOf(defs[b]) - sizeOf(defs[a]) || a - b; });
    var avoid = [ship.helm, ship.barrel, ship.mast, ship.chart, ship.hatch, ship.bowl], out = new Array(defs.length), placed = [];
    function free(gx, gz, r) {
      if (gx - r < ship.x0 + 0.15 || gx + r > ship.x1 - 0.15 || gz - r < ship.z0 + 0.15 || gz + r > ship.z1 - 0.15) return false; // inside the rail
      if (avoid.some(function (a) { return Math.hypot(gx - a.x, gz - a.z) < r + 0.4; })) return false;
      if (Math.abs(gx - ship.gangway.x) < 0.8 + r && gz > ship.z1 - 1.0 - r) return false;                   // keep the gangway clear
      if (Math.abs(gx - ship.rack.x) < D.shop.length * 0.3 + 0.3 + r && gz < ship.z0 + 0.7 + r) return false; // and the tool rack
      if (Math.abs(gx - ship.hatch.x) < 0.8 + r && Math.abs(gz - ship.hatch.z) < 0.8 + r) return false;       // and the hold hatch
      if (Math.abs(gx - ship.chart.x) < ship.chart.hw + r && Math.abs(gz - ship.chart.z) < 0.35 + r) return false; // and under Mortimer's chart
      return placed.every(function (p) { return Math.hypot(gx - p.x, gz - p.z) >= r + p.r + 0.04; });
    }
    for (var layer = 0, left = order.slice(); left.length; layer++) {
      var still = [];
      placed = [];
      left.forEach(function (i) {
        var r = sizeOf(defs[i]) / 2, spot = null;
        for (var gx = ship.x1 - 0.2; gx > ship.x0 && !spot; gx -= 0.15)
          for (var gz = ship.z0 + 0.2; gz < ship.z1 && !spot; gz += 0.15)
            if (free(gx, gz, r)) spot = { x: gx, z: gz };
        if (!spot) { still.push(i); return; }
        placed.push({ x: spot.x, z: spot.z, r: r });
        out[i] = { x: spot.x, z: spot.z, y: ship.deck + layer * 0.3 };
      });
      if (still.length === left.length) { still.forEach(function (i) { out[i] = { x: ship.x, z: ship.z, y: ship.deck + (layer + 1) * 0.3 }; }); break; } // nothing fits at all
      left = still;
    }
    return out;
  }

  // ---------- world queries ----------

  function cellAt(w, px, pz) {
    var x = Math.floor(px / w.cs), y = Math.floor(pz / w.cs);
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return -1;
    return y * w.W + x;
  }
  function isFloorKind(k) { return k === INSIDE || k === OUTSIDE; }

  // Rope bridges: only a plank-wide strip down the middle of a bridge cell, and out
  // toward the cells it joins, is solid. Everywhere else in a chasm room is the drop.
  function planked(w, c, px, pz) {
    var hw = w.tomb.hazards.bridgeWidth / 2, lx = px - (c % w.W + 0.5) * w.cs, lz = pz - (((c / w.W) | 0) + 0.5) * w.cs, m = w.bridgeMask[c];
    if (Math.abs(lx) <= hw && Math.abs(lz) <= hw) return true;
    if ((m & 1) && Math.abs(lx) <= hw && lz <= 0) return true;
    if ((m & 2) && Math.abs(lz) <= hw && lx >= 0) return true;
    if ((m & 4) && Math.abs(lx) <= hw && lz >= 0) return true;
    if ((m & 8) && Math.abs(lz) <= hw && lx <= 0) return true;
    return false;
  }
  function floorAt(w, c, px, pz) {
    var f = w.floor[c] + w.sand[c];
    if (w.chasm && w.chasm[c] === 2 && !planked(w, c, px, pz)) f -= w.chasmDrop;
    return f;
  }

  // The Gutbucket's deck only counts as floor while the ship is on the ground.
  function onDeckXZ(w, px, pz) {
    var s = w.ship;
    return s.lift < 0.01 && px > s.x0 && px < s.x1 && pz > s.z0 && pz < s.z1;
  }

  // Highest floor and lowest ceiling under a goblin's footprint.
  function footprint(w, px, pz, rad) {
    var out = { floor: -Infinity, ceil: Infinity, inside: false, deck: false };
    var pts = [[0, 0], [-rad, -rad], [rad, -rad], [-rad, rad], [rad, rad]];
    for (var i = 0; i < pts.length; i++) {
      var qx = px + pts[i][0], qz = pz + pts[i][1];
      var c = cellAt(w, qx, qz);
      if (c < 0 || !isFloorKind(w.kind[c])) continue;
      var f = floorAt(w, c, qx, qz);
      if (onDeckXZ(w, qx, qz)) { f = Math.max(f, w.ship.deck); if (i === 0) out.deck = true; }
      if (f > out.floor) out.floor = f;
      if (w.kind[c] === INSIDE) { out.inside = out.inside || i === 0; if (w.ceil[c] < out.ceil) out.ceil = w.ceil[c]; }
    }
    return out;
  }

  function openCell(w, x, z) { var c = cellAt(w, x, z); return c >= 0 && isFloorKind(w.kind[c]); }
  function hitsProp(p, px, pz, rad) {
    if (p.shape === 'circle') {
      var dx = px - p.x, dz = pz - p.z, rr = p.r + rad;
      return dx * dx + dz * dz < rr * rr;
    }
    var cx = Math.max(p.x - p.hw, Math.min(px, p.x + p.hw));
    var cz = Math.max(p.z - p.hd, Math.min(pz, p.z + p.hd));
    var ex = px - cx, ez = pz - cz;
    return ex * ex + ez * ez < rad * rad;
  }

  // Returns 0 when the spot is free, 'wall', or 'low' (ceiling too low to stand).
  function blockedAt(w, pl, px, pz, height) {
    var P = D.player, rad = P.radius, cs = w.cs;
    var x0 = Math.floor((px - rad) / cs), x1 = Math.floor((px + rad) / cs);
    var y0 = Math.floor((pz - rad) / cs), y1 = Math.floor((pz + rad) / cs);
    var feet = pl.grounded ? pl.y + P.stepUp : pl.y + 0.02;
    var result = 0;
    for (var cy = y0; cy <= y1; cy++) {
      for (var cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cy < 0 || cx >= w.W || cy >= w.H) return 'wall';
        var c = cy * w.W + cx, k = w.kind[c];
        if (!isFloorKind(k)) return 'wall';
        var f = w.floor[c] + w.sand[c];
        if (f > feet) return 'wall';
        if (k === INSIDE) {
          var room = w.ceil[c] - Math.max(f, pl.y);
          if (room < P.crouchHeight) return 'wall';
          if (room < height) result = 'low';
        }
        var list = w.propCells[c];
        if (list) {
          for (var i = 0; i < list.length; i++) {
            var p = w.props[list[i]];
            if (p.ship && w.ship.lift > 0.3) continue; // the ship has flown
            if (p.gangway && !w.ship.gangwayUp) continue; // the gangway's down: the gap is open
            if (p.needsBarrel && !w.ship.hasBarrel) continue; // no oil barrel fitted
            if (p.door !== undefined && w.doors[p.door].open) continue;
            if (p.chest !== undefined && w.chests[p.chest].loose) continue; // a mimic that got up and left
            if ((p.y || 0) < pl.y + P.stepUp && hitsProp(p, px, pz, rad)) return 'wall';
          }
        }
      }
    }
    var cart = w.rail && w.rail.cart; // the mine cart stands in the way
    if (cart && cart.y < pl.y + P.stepUp && inCart(cart, px, pz, rad)) return 'wall';
    return result;
  }

  // The tide (Sunken Galleon): the sea level at a given hour of the night, rising faster after midnight.
  function tideAt(TD, clock, pace) {
    if (TD.steps) { // a stepped flood: each bell, the water rises a step over riseHours
      var every = TD.every * (pace || 1), sum = 0;
      for (var i = 0; i < TD.steps; i++) sum += Math.max(0, Math.min(1, (clock - (TD.firstHour + i * every)) / TD.riseHours));
      return TD.low + (TD.high - TD.low) * sum / TD.steps;
    }
    var k = Math.max(0, Math.min(1, (clock - D.night.startHour) / (D.night.endHour - D.night.startHour)));
    return TD.low + (TD.high - TD.low) * Math.pow(k, TD.curve);
  }
  function surfaceAt(w, px, pz, py) {
    if (py !== undefined && py < w.tide - 0.05) return 'water';
    if (onDeckXZ(w, px, pz) && (py === undefined || py > w.ship.deck - 0.2)) return 'wood';
    var c = cellAt(w, px, pz);
    return SURFACES[c < 0 ? 0 : w.surf[c]];
  }

  // ---------- simulation state ----------

  // Where each goblin of the crew stands on deck: first by the gangway, the rest spread along it.
  var DECK_SPOTS = [[0, 0], [-1.3, 0], [-2.6, 0], [1.3, -0.9]];
  function createPlayer(w, id, slot) {
    var P = D.player, o = DECK_SPOTS[(slot || 0) % DECK_SPOTS.length];
    return {
      id: id, x: w.spawn.x + o[0], y: w.ship.deck + w.ship.lift, z: w.spawn.z + o[1], vx: 0, vz: 0, vy: 0,
      yaw: w.spawn.yaw, pitch: 0, grounded: true, crouching: false, sprinting: false,
      hp: P.maxHp, stamina: 1, staminaDelay: 0, exhausted: false,
      lanternOn: true, oil: 1, refilling: false, stride: 0, fallFrom: w.ship.deck,
      inside: false, onDeck: true, lowCeilingAhead: false, dead: false, deadTimer: 0,
      slots: [null, null, null, null], sel: 0, twoHanded: null, load: 0,
      focus: null, helmHold: 0, aboard: false, engulfed: null, struggle: 0, digestHurt: 0, leftBehind: false, cause: null, deathLoot: null, buried: false, digT: 0, warp: 0, carrying: null, carriedBy: null, signalT: 0, shellTalk: false, sandHurt: 0, translating: -1, translateT: 0, grumbleT: 0, swingT: 0, voiceT: 0, breath: 1, drownHurt: 0, underwater: false, spored: 0, holdingBreath: false, phantomT: 2, look: '', heldBy: null, bardOk: false
    };
  }

  function newCampaign(seed) {
    var E = D.economy;
    // night: the day number (a day is a night in a tomb or a visit to Craig); where: 'sky' between
    // days, 'tomb' or 'craig' during one.
    return { seed: String(seed), night: 1, where: 'sky', hold: [], history: [], gold: E.startGold, cut: E.firstCut,
      cutsPaid: 0, unlocks: [], pendingThrone: false, visit: null, over: false, kit: [], destination: 'barrow', debt: 0,
      upgrades: [], omen: null, lessons: false }; // lessons: Mortimer's first-night lessons (set by the client)
  }
  // Day of the 4-day cycle (1-4); day 4 always goes to Craig for the Cut.
  function cycleDay(campaign) { return ((campaign.night - 1) % D.economy.cycle) + 1; }
  // Which world a campaign is in right now (saves from before the sky had no 'where').
  function placeOf(campaign) {
    var where = campaign.where || (campaign.pendingThrone ? 'craig' : 'sky');
    return where === 'sky' ? 'sky' : where === 'craig' ? 'warren' : (campaign.destination || 'barrow');
  }
  function nightSeed(campaign) { return campaign.seed + '/night' + campaign.night; }

  function createState(w, campaign) {
    campaign = copyCampaign(campaign || newCampaign(w.seed));
    var omen = !w.warren && !w.sky && campaign.omen && D.omens.list[campaign.omen] ? campaign.omen : null, lootK = omen ? D.omens.list[omen].loot || 1 : 1;
    var items = w.itemSpawns.map(function (s, i) {
      return { id: i, def: s.def, value: Math.round(s.value * lootK), x: s.x, y: s.y, z: s.z, rot: s.rot,
        vx: 0, vy: 0, vz: 0, flying: false, holder: null, chest: s.chest, gone: false };
    });
    if (w.warren || w.sky) {
      // The hold comes out onto the deck; whatever isn't sold goes back in when we leave.
      var spots = deckSpots(w.ship, campaign.hold.map(function (h) { return h.def; }));
      items = campaign.hold.map(function (h, i) {
        return { id: i, def: h.def, value: h.value, night: h.night, x: spots[i].x, y: spots[i].y, z: spots[i].z,
          rot: (i * 2.4) % 6.28, vx: 0, vy: 0, vz: 0, flying: false, holder: null, chest: -1, gone: false };
      });
      campaign.hold = [];
    }
    w.doors.forEach(function (d) { d.open = false; d.timer = 0; });
    w.sand.fill(0);
    w.tide = w.tomb.tide ? tideAt(w.tomb.tide, D.night.startHour) : -1e9;
    w.ship.lift = w.sky ? 0 : D.night.liftHeight;
    w.ship.gangwayUp = false;
    w.ship.hasBarrel = hasUpgrade(campaign, 'oil_barrel');
    var state = {
      t: 0, phase: w.sky ? 'sky' : 'landing', phaseT: 0, clock: w.warren || w.sky ? 21 : D.night.startHour, lastHour: D.night.startHour, bellRung: false,
      campaign: campaign, players: { p1: createPlayer(w, 'p1') },
      items: items, chests: w.chests.map(function (ch) { return { open: false, mimic: false, x: ch.x, y: ch.y, z: ch.z }; }),
      monsters: [], seedBase: w.seed, rng: makeRng(w.seed + ':spawns'), spawnT: 0, knightOut: false,
      stowed: [], result: null, frenzy: false, omen: omen,
      scryT: 0, scryCd: 0, giantOut: false,
      warren: !!w.warren, sky: !!w.sky, terms: w.warren || w.sky ? throneTerms(campaign) : null,
      explored: exploredStart(w), roomsSeen: {}, panicT: 0,
      traps: w.traps.map(function (t) { return { triggered: false, pouring: false, t: 0, level: 0, max: t.max }; }),
      jars: w.jars.map(function () { return { cracked: false }; }),
      caveins: w.caveins.map(function () { return { strain: 0, rumbleT: 0, fallen: false }; }), cartPushed: false,
      glow: w.glowcaps.map(function () { return { cd: 0 }; }), clouds: [], phantoms: [], phantomId: 0,
      puffs: w.puffballs.map(function (pb, i) { return { t: 3 + (i * 2.7) % 8 }; })
    };
    if (w.rail) w.rail.cart = cartPose(w, { s: w.rail.len, dir: -1, v: 0, moving: false, rumbleT: 0, hitCd: 0 });
    spawnKit(state, w);
    // Some chests are mimics (fewer on the very first night).
    var MM = D.monsters.mimic, mr = makeRng(w.seed + ':mimics'), chance = (campaign.night || 1) <= 1 ? MM.firstNightChance : MM.chance;
    w.chests.forEach(function (ch, ci) {
      ch.loose = false;
      if (mr() >= chance || state.chests.filter(function (c) { return c.mimic; }).length >= w.chests.length - 1) return;
      state.chests[ci].mimic = true;
      addMonster(state, 'mimic', ch.x, ch.y, ch.z, { chest: ci, state: 'dormant', hp: MM.hp, calm: 0, dir: ch.rot });
    });
    // The Pharaoh lies in the sarcophagus; the Jackal Wardens sit by their doorways.
    if (w.sarcophagus) {
      var sp = w.sarcophagus;
      addMonster(state, 'pharaoh', sp.x, sp.y, sp.z, { state: 'dormant', groanT: 3, dir: 0, stepOut: { x: sp.x + 1.3, z: sp.z } });
    }
    w.hangLanterns.forEach(function (hl) { if (hl.obake) addMonster(state, 'chochin', hl.x, hl.floor, hl.z, { state: 'watch', hangY: hl.y, cd: 0, dir: hashString(hl.cell) % 628 / 100, sweep: 1 }); });
    w.jackals.forEach(function (j) { addMonster(state, 'jackal', j.x, j.y, j.z, { dir: j.rot, glow: false, state: 'watching' }); });
    w.roosts.forEach(function (ro, i) { addMonster(state, 'bats', ro.x, ro.y, ro.z, { state: 'roost', roost: i, restT: 0, shriekT: 0, mode: 'fly' }); });
    return state;
  }

  // Mortimer's map starts with the moor (or the warren) already drawn; the tomb fills in as you go.
  function exploredStart(w) {
    var e = new Uint8Array(w.W * w.H);
    for (var c = 0; c < e.length; c++) if (w.kind[c] === OUTSIDE) e[c] = 1;
    return e;
  }
  function newTool(state, defId, x, y, z, burn) {
    var def = D.items[defId];
    var it = { id: state.items.length, def: defId, value: 0, tool: true, x: x, y: y, z: z, rot: 0, vx: 0, vy: 0, vz: 0,
      flying: false, holder: null, chest: -1, gone: false, burn: burn != null ? burn : (def.burnSeconds || 0) };
    state.items.push(it);
    return it;
  }
  // The kit you carried home comes back in your hands (anything past four slots, on deck).
  function spawnKit(state, w) {
    var kit = (state.campaign.kit || []).filter(function (k) { return D.items[k.def]; }), pl = state.players.p1; // (tools that no longer exist are dropped)
    var onDeck = w.warren || w.sky ? state.items.map(function (it) { return it.def; }) : (state.campaign.hold || []).map(function (h) { return h.def; });
    var spots = deckSpots(w.ship, onDeck.concat(kit.map(function (k) { return k.def; }))).slice(onDeck.length);
    kit.forEach(function (k, i) {
      var it = newTool(state, k.def, spots[i].x, spots[i].y, spots[i].z, k.burn);
      var slot = pl.slots.indexOf(null);
      if (slot >= 0 && D.items[k.def].weight !== 'twoHanded') { pl.slots[slot] = it.id; it.holder = pl.id; }
    });
  }
  function kitOf(items) { return items.map(function (it) { return { def: it.def, burn: it.burn }; }); }

  // Ends a night: the hold keeps everything that came home. Returns the next campaign.
  function sumValue(list) { return list.reduce(function (s, it) { return s + it.value; }, 0); }
  function copyCampaign(c) {
    var out = {};
    for (var k in c) out[k] = Array.isArray(c[k]) ? c[k].slice() : c[k];
    if (c.visit) out.visit = { night: c.visit.night, sold: c.visit.sold.slice(), frenzySold: c.visit.frenzySold, cutPaid: c.visit.cutPaid, cutGiven: c.visit.cutGiven || 0 };
    return out;
  }

  // Ends a night: everything that came home goes into the hold, stamped with the
  // night it arrived (Frenzy prices only apply to that night's haul). Craig is next.
  function endNight(campaign, result) {
    var c = copyCampaign(campaign), frenzy = isFrenzy(campaign, campaign.night), wipedHold = [];
    if (result.wiped) { wipedHold = c.hold; c.hold = []; } // crew wipe: the hold goes too
    c.hold = c.hold.concat(result.stowed.map(function (it) { return { def: it.def, value: it.value, night: campaign.night }; }));
    c.history = c.history.concat([{ night: campaign.night, tomb: result.tomb, reason: result.reason, frenzy: frenzy,
      stowed: sumValue(result.stowed), stowedCount: result.stowed.length, lost: sumValue(result.lost),
      leftInTomb: result.leftInTomb ? result.leftInTomb.count : 0, leftBehind: result.leftBehind.length > 0, omen: campaign.omen || null }]);
    c.omen = null;
    c.kit = result.kit || [];
    // Craig hatches a new goblin for every one that died or was left behind, and bills for it.
    var fee = replacementFee(c, result), debtAdded = 0;
    if (fee > 0) {
      c.gold -= fee;
      if (c.gold < 0) { debtAdded = -c.gold; c.debt = (c.debt || 0) + debtAdded; c.gold = 0; }
    }
    c.lastNight = { fee: fee, debtAdded: debtAdded, deaths: (result.deaths || []).length, cause: result.deaths && result.deaths[0] ? result.deaths[0].cause : null,
      leftBehind: result.leftBehind.length, lost: sumValue(result.lost) + sumValue(wipedHold), lostCount: result.lost.length + wipedHold.length, wiped: !!result.wiped };
    c.history[c.history.length - 1].fee = fee;
    c.night = campaign.night + 1; // the next day starts up in the sky
    c.where = 'sky';
    c.pendingThrone = false;
    c.visit = null;
    return c;
  }

  function replacementFee(campaign, result) {
    var R = D.death, each = R.feeBase + R.feePerCut * (campaign.cutsPaid || 0), fee = 0;
    (result.deaths || []).forEach(function (d) { fee += d.bodyAboard ? Math.round(each * R.bodyAboardFactor) : each; });
    fee += (result.leftBehind || []).length * each;
    return Math.round(fee * upgradeFactor(campaign, 'fee'));
  }
  // What Craig takes on Cut night: the Cut itself, plus anything owed.
  function cutDue(campaign) { return campaign.cut + (campaign.debt || 0); }
  // What's still owed on the Cut today, after what's gone in the pit toward it.
  function cutLeft(campaign) { var v = campaign.visit; return v && v.night === campaign.night && v.cutPaid ? 0 : Math.max(0, cutDue(campaign) - (v && v.night === campaign.night && v.cutGiven || 0)); }
  function settleCut(c) { // the Cut's paid in full: the next one grows, the debt's gone
    var E = D.economy;
    c.cutsPaid += 1;
    c.cut = Math.round(c.cut * E.cutGrowth + E.cutAdd); // debt doesn't make the next Cut bigger
    c.debt = 0;
    c.visit.cutPaid = true;
  }

  // ---------- Craig: selling and the Cut ----------

  function isFrenzy(campaign, night) {
    var E = D.economy;
    return night >= E.frenzyFromNight && makeRng(campaign.seed + ':frenzy:' + night)() < E.frenzyChance;
  }

  // Craig's terms on day campaign.night, if you go to him that day: his mood by day of the
  // cycle (with the odd good mood), the cycle's craving, and whether he's in a Frenzy.
  function throneTerms(campaign) {
    var E = D.economy, day = campaign.night, cd = cycleDay(campaign), cycle = Math.floor((day - 1) / E.cycle);
    var spike = makeRng(campaign.seed + ':mood:' + day)() < E.spikeChance;
    var cravings = Object.keys(D.cravings);
    var craving = cravings[Math.floor(makeRng(campaign.seed + ':craving:' + cycle)() * cravings.length)];
    return {
      night: day, day: day, cycleDay: cd, cycleNight: cd, cutNight: cd === E.cycle, nightsToCut: E.cycle - cd,
      rate: E.rates[cd - 1] + (spike ? E.spikeBonus : 0), spike: spike,
      craving: craving, frenzy: isFrenzy(campaign, day)
    };
  }

  function offerFor(item, terms) {
    var E = D.economy, def = D.items[item.def];
    var fresh = terms.frenzy && item.night === terms.day - 1; // last night's haul
    var craved = (def.tags || []).indexOf(terms.craving) >= 0;
    var rate = fresh ? Math.max(E.frenzyRate, terms.rate) : terms.rate;
    return { price: Math.round(item.value * rate * (craved ? E.cravingBonus : 1)), fresh: fresh, craved: craved, rate: rate };
  }

  // Sells one piece of loot to Craig (it's already left the hold). Returns the new
  // campaign, the sale, and an unlock if a Frenzy haul just beat the Cut on its own.
  function sellOne(campaign, item) {
    var E = D.economy, terms = throneTerms(campaign), c = copyCampaign(campaign), unlocked = null;
    if (!c.visit || c.visit.night !== terms.night) c.visit = { night: terms.night, sold: [], frenzySold: 0, cutPaid: false, cutGiven: 0 };
    var o = offerFor(item, terms), cut0 = c.cut; // the Cut as it stood before this sale (paying it raises the next one)
    var sale = { def: item.def, value: item.value, price: o.price, fresh: o.fresh, craved: o.craved, toCut: 0 };
    if (terms.cutNight && !c.visit.cutPaid) { // Cut day: Craig takes his Cut out of the first of it
      var owed = cutLeft(c);
      sale.toCut = Math.min(owed, o.price);
      c.visit.cutGiven = (c.visit.cutGiven || 0) + sale.toCut;
      if (sale.toCut >= owed) { sale.cutDone = true; sale.due = cutDue(c); settleCut(c); }
      sale.cutLeft = cutLeft(c);
    }
    c.gold += o.price - sale.toCut;
    if (o.fresh) c.visit.frenzySold += o.price;
    c.visit.sold = c.visit.sold.concat([sale]);
    if (terms.frenzy && c.visit.frenzySold >= cut0 && c.unlocks.indexOf(E.frenzyUnlock) < 0) {
      c.unlocks = c.unlocks.concat([E.frenzyUnlock]);
      unlocked = E.frenzyUnlock;
    }
    return { campaign: c, sale: sale, unlocked: unlocked };
  }

  // Sells hold items (by index) to Craig. Returns the new campaign and what happened.
  function sell(campaign, indices) {
    var pick = {}, sales = [], unlocked = null, c = copyCampaign(campaign), keep = [];
    indices.forEach(function (i) { pick[i] = true; });
    campaign.hold.forEach(function (it, i) { if (!pick[i]) keep.push(it); });
    c.hold = keep;
    campaign.hold.forEach(function (it, i) {
      if (!pick[i]) return;
      var r = sellOne(c, it);
      c = r.campaign; sales.push(r.sale);
      if (r.unlocked) unlocked = r.unlocked;
    });
    return { campaign: c, sales: sales, unlocked: unlocked };
  }

  // The campaign as it stands mid-visit: gold so far, and every unsold piece back in the hold.
  function visitCampaign(state) {
    var c = copyCampaign(state.campaign);
    var left = state.items.filter(function (it) { return !it.gone; });
    c.hold = left.filter(function (it) { return !it.tool; }).map(function (it) { return { def: it.def, value: it.value, night: it.night }; });
    c.kit = kitOf(left.filter(function (it) { return it.tool; }));
    return c;
  }

  // Cut night: Craig takes his Cut, or the crew goes in the pit.
  // Whatever's still owed comes out of your gold on the way out.
  function payCut(campaign) {
    var c = copyCampaign(campaign), due = cutDue(c);
    if (!c.visit || c.visit.night !== c.night) c.visit = { night: c.night, sold: [], frenzySold: 0, cutPaid: false, cutGiven: 0 };
    if (c.visit.cutPaid) return { campaign: c, paid: true, due: 0, already: true, left: c.gold, bare: false }; // paid in loot already
    var owed = cutLeft(c);
    if (c.gold < owed) { c.over = true; c.pendingThrone = false; return { campaign: c, paid: false, due: owed, short: owed - c.gold }; }
    c.gold -= owed;
    settleCut(c);
    return { campaign: c, paid: true, due: owed, left: c.gold, bare: c.gold < due * 0.2 };
  }

  // Leaving the throne room. On Cut night the Cut must be paid first.
  function leaveThrone(campaign) {
    var terms = throneTerms(campaign);
    if (terms.cutNight && !(campaign.visit && campaign.visit.night === terms.night && campaign.visit.cutPaid)) return null;
    var c = copyCampaign(campaign);
    c.pendingThrone = false;
    c.night = campaign.night + 1; c.where = 'sky'; c.visit = null;
    return c;
  }

  // ---------- players ----------

  var NO_SHUN = { mimic: 1, jackal: 1, chochin: 1, bats: 1, scarabs: 1, knight: 1, hands: 1 }; // (the knight never comes aboard anyway)
  var NO_INPUT = { fwd: 0, strafe: 0, yaw: 0, pitch: 0, sprint: false, crouch: false, jump: false, lantern: false,
    use: false, useHeld: false, useItem: false, drop: false, toss: false, slot: -1, slotDelta: 0 };

  function weightOf(it) { return D.inventory.weights[D.items[it.def].weight]; }
  function heldItem(state, pl) {
    var hid = pl.twoHanded !== null ? pl.twoHanded : pl.slots[pl.sel];
    return hid === null ? null : state.items[hid];
  }
  function carried(state, pl) {
    var out = [];
    if (pl.twoHanded !== null) out.push(state.items[pl.twoHanded]);
    pl.slots.forEach(function (sid) { if (sid !== null) out.push(state.items[sid]); });
    return out;
  }
  function release(state, pl, it) {
    if (pl.twoHanded === it.id) pl.twoHanded = null;
    for (var i = 0; i < pl.slots.length; i++) if (pl.slots[i] === it.id) pl.slots[i] = null;
    it.holder = null;
  }
  function eyeY(pl) { var P = D.player; return pl.y + (pl.crouching ? P.crouchHeight : P.height) - P.eyeOffset; }
  function lookDir(pl) {
    var cp = Math.cos(pl.pitch);
    return [-Math.sin(pl.yaw) * cp, Math.sin(pl.pitch), -Math.cos(pl.yaw) * cp];
  }

  // What the goblin is looking at within reach: a score for how squarely the look
  // ray passes a target, or -1 if it misses.
  function aimScore(pl, d, tx, ty, tz, rad) {
    var vx = tx - pl.x, vy = ty - eyeY(pl), vz = tz - pl.z;
    var t = vx * d[0] + vy * d[1] + vz * d[2];
    if (t < 0 || t > D.inventory.reach) return -1;
    var px = vx - d[0] * t, py = vy - d[1] * t, pz = vz - d[2] * t;
    var perp = Math.sqrt(px * px + py * py + pz * pz);
    return perp > rad ? -1 : perp / rad + t * 0.1;
  }
  function findFocus(state, w, pl) {
    var d = lookDir(pl), best = null, bs = Infinity, hands = pl.carrying === null;
    function consider(kind, fid, x, y, z, rad) {
      var s = aimScore(pl, d, x, y, z, rad);
      if (s >= 0 && s < bs) { bs = s; best = { kind: kind, id: fid }; }
    }
    // a fallen crewmate, to carry home (both hands, so not while hugging loot)
    if (hands && pl.twoHanded === null) for (var bid in state.players) {
      var bp = state.players[bid];
      if (bid !== pl.id && bp.dead && bp.carriedBy === null) consider('body', bid, bp.x, bp.y + 0.25, bp.z, 0.55);
    }
    if (hands) state.items.forEach(function (it) {
      if (it.gone || it.holder !== null || it.flying || it.inCube != null) return;
      if (it.chest >= 0 && !state.chests[it.chest].open) return;
      var two = D.items[it.def].weight === 'twoHanded';
      consider('item', it.id, it.x, it.y + (two ? 0.35 : 0.08), it.z, two ? 0.55 : 0.32);
    });
    if (hands) w.chests.forEach(function (ch, ci) {
      var cs2 = state.chests[ci], mm = cs2.mimic ? mimicAt(state, ci) : null;
      if (!cs2.open && !(mm && (mm.state === 'awake' || mm.dead))) consider('chest', ci, cs2.x, cs2.y + 0.35, cs2.z, 0.5);
    });
    var s = w.ship;
    if (s.lift < 0.01 && state.phase === 'night') {
      consider('helm', 0, s.helm.x, s.deck + 1.05, s.helm.z, 0.4);
      consider('hatch', 0, s.hatch.x, s.deck + 0.1, s.hatch.z, 0.6);
    }
    if (s.lift < 0.01 && (state.phase === 'visit' || state.phase === 'sky')) consider('helm', 0, s.helm.x, s.deck + 1.05, s.helm.z, 0.4);
    if (s.lift < 0.01 && (state.phase === 'night' || state.phase === 'visit' || state.phase === 'sky')) {
      if (hands) s.pegs.forEach(function (pg, i) { consider('shop', i, pg.x, pg.y, pg.z, 0.17); });
      if (state.phase === 'sky') s.pins.forEach(function (pn, i) { consider('pin', i, pn.x, pn.y, pn.z, 0.12); });
      if (state.phase === 'night' && !w.sky && !w.warren) consider('gangway', 0, s.gangway.x, s.deck + 0.35, s.z1 - 0.05, 0.55);
      if (state.phase === 'night' && hasUpgrade(state.campaign, 'scrying_bowl')) consider('bowl', 0, s.bowl.x, s.deck + 0.85, s.bowl.z, 0.3);
    }
    (w.hooks || []).forEach(function (h, i) { consider('hook', i, h.x, h.y, h.z, 0.15); }); // the wardrobe, in Craig's camp
    (w.improve || []).forEach(function (u, i) { consider('upgrade', i, u.x, u.y, u.z, 0.2); }); // the tinkers' board, in Craig's camp
    w.doors.forEach(function (d) { if (!d.open) consider('door', d.id, d.x, d.bottom + 1.0, d.z, 1.0); });
    var cart = w.rail && w.rail.cart;
    if (cart && !cart.moving) { var hd = cartHandle(cart, pl); consider('cart', 0, hd.x, hd.y, hd.z, 0.35); }
    return best;
  }

  // ---------- Mortimer: the shop, the chart, tools and runes ----------

  function buy(state, pl, defId, events) {
    var def = D.items[defId], c = state.campaign;
    if (c.gold < def.price) { events.push({ type: 'broke', player: pl.id, def: defId }); return; }
    var slot = pl.twoHanded !== null ? -1 : pl.slots[pl.sel] === null ? pl.sel : pl.slots.indexOf(null);
    if (slot < 0) { events.push({ type: 'handsFull', player: pl.id }); return; }
    c.gold -= def.price;
    var it = newTool(state, defId, pl.x, pl.y, pl.z);
    it.holder = pl.id; pl.slots[slot] = it.id; pl.sel = slot;
    events.push({ type: 'bought', player: pl.id, def: defId, price: def.price, gold: c.gold, item: it.id });
  }

  // ---- the Gutbucket's gear: the gangway and the scrying bowl
  function inShipRect(w, x, z) { var s = w.ship; return s.lift < 0.5 && x > s.x0 - 0.25 && x < s.x1 + 0.25 && z > s.z0 - 0.25 && z < s.z1 + 0.25; }
  function gangwayUp(state, w) { return !!w.ship.gangwayUp && !w.warren && !w.sky; }
  // E at the gangway: up from the deck, down from either end. Not while someone's standing in the gap.
  function toggleGangway(state, w, pl, events) {
    var s = w.ship, gw = D.gutbucket.gangway / 2;
    if (!w.ship.gangwayUp) {
      if (!pl.onDeck) return; // you pull it up from aboard
      for (var pid in state.players) {
        var p = state.players[pid];
        if (!p.dead && Math.abs(p.x - s.gangway.x) < gw + 0.35 && Math.abs(p.z - (s.z1 - 0.08)) < 0.4) { events.push({ type: 'gangwayBlocked', player: pl.id }); return; }
      }
    }
    w.ship.gangwayUp = !w.ship.gangwayUp;
    events.push({ type: 'gangway', up: w.ship.gangwayUp, player: pl.id, x: s.gangway.x, z: s.z1 });
  }
  function monsterAboard(state, w) { return state.monsters.some(function (m) { return !m.dead && inShipRect(w, m.x, m.z); }); }
  function scry(state, pl, events) {
    var B = D.upgrades.scrying_bowl;
    if (!hasUpgrade(state.campaign, 'scrying_bowl') || state.phase !== 'night') return;
    if (state.scryCd > 0) { events.push({ type: 'scryWait', player: pl.id, left: state.scryCd }); return; }
    state.scryT = B.scrySeconds; state.scryCd = B.cooldown;
    events.push({ type: 'scry', player: pl.id });
  }
  // Where a recalled goblin lands: its own spot on deck.
  function yankAboard(w, pl) {
    var o = DECK_SPOTS[((parseInt(String(pl.id).slice(1), 10) || 1) - 1) % DECK_SPOTS.length];
    pl.x = w.spawn.x + o[0]; pl.z = w.spawn.z + o[1]; pl.y = w.ship.deck + w.ship.lift;
    pl.vx = pl.vy = pl.vz = 0; pl.buried = false; pl.heldBy = null; pl.warp = (pl.warp || 0) + 1;
  }
  function stepGear(state, w, inputs, dt, events) {
    var c = state.campaign, s = w.ship, night = state.phase === 'night' && s.lift < 0.01;
    state.scryT = Math.max(0, (state.scryT || 0) - dt); state.scryCd = Math.max(0, (state.scryCd || 0) - dt);
    for (var pid in state.players) {
      var pl = state.players[pid], inp = inputs[pid] || NO_INPUT;
      if (pl.dead) continue;
      if (inp.scry && night) scry(state, pl, events);
    }
  }

  function hasUpgrade(campaign, id) { return !!(campaign && campaign.upgrades && campaign.upgrades.indexOf(id) >= 0); }
  // Gutbucket upgrades are the campaign's: bought once, kept every day after.
  function buyUpgrade(state, pl, id, events) {
    var up = D.upgrades[id], c = state.campaign;
    if (!up) return;
    if (hasUpgrade(c, id)) { events.push({ type: 'fitted', player: pl.id, id: id }); return; }
    if (c.gold < up.price) { events.push({ type: 'broke', player: pl.id, upgrade: id }); return; }
    c.gold -= up.price;
    c.upgrades = (c.upgrades || []).concat([id]);
    events.push({ type: 'upgraded', player: pl.id, id: id, price: up.price, gold: c.gold });
  }
  // What an upgrade does to a number (fares, fees): the product of every fitted upgrade's factor.
  function upgradeFactor(campaign, key) {
    var f = 1;
    ((campaign && campaign.upgrades) || []).forEach(function (u) { if (D.upgrades[u] && D.upgrades[u][key]) f *= D.upgrades[u][key]; });
    return f;
  }
  function fareOf(campaign, dest) { return Math.round((dest.cost || 0) * upgradeFactor(campaign, 'fare')); }
  // The weather over a destination on this day, or null. Rolled from the seed, so the chart can show it
  // before you go and every goblin in the crew sees the same.
  function omenOf(campaign, destId) {
    var O = D.omens, night = campaign.night || 1, T = D.tombs[destId];
    if (!T || T.warren || T.sky || night < O.fromNight) return null;
    var r = makeRng(campaign.seed + ':omen:' + night + ':' + destId);
    if (r() >= O.chance) return null;
    var pool = Object.keys(O.list).filter(function (k) { var o = O.list[k]; return (!o.tombs || o.tombs.indexOf(destId) >= 0) && night >= (o.fromNight || 0); });
    var total = pool.reduce(function (s, k) { return s + O.list[k].weight; }, 0), roll = r() * total;
    for (var i = 0; i < pool.length; i++) { roll -= O.list[pool[i]].weight; if (roll < 0) return pool[i]; }
    return pool.length ? pool[pool.length - 1] : null;
  }
  // A look is a list of cosmetic ids, at most one per slot (hat, ear, eye, lantern).
  function cleanLook(s) {
    var seen = {}, out = [];
    String(s).split(',').forEach(function (id) { var cd = Object.prototype.hasOwnProperty.call(D.cosmetics, id) && D.cosmetics[id]; if (cd && !seen[cd.slot]) { seen[cd.slot] = true; out.push(id); } });
    return out.join(',');
  }

  function choosePin(state, pl, dest, events) {
    if (cycleDay(state.campaign) === D.economy.cycle && !dest.craig) { events.push({ type: 'onlyCraig', player: pl.id }); return; }
    if (dest.craig) { state.campaign.destination = 'craig'; events.push({ type: 'destination', player: pl.id, dest: 'craig' }); return; }
    if (!dest.charted || !D.tombs[dest.id]) { events.push({ type: 'uncharted', player: pl.id, dest: dest.id }); return; }
    if (state.campaign.gold < fareOf(state.campaign, dest)) { events.push({ type: 'broke', player: pl.id, dest: dest.id }); return; }
    state.campaign.destination = dest.id;
    events.push({ type: 'destination', player: pl.id, dest: dest.id });
  }

  function useTool(state, w, pl, it, events) {
    var def = D.items[it.def];
    if (def.use === 'swing') {
      if (pl.swingT > 0) return;
      pl.swingT = def.swingSeconds;
      events.push({ type: 'swing', player: pl.id, loud: def.noise, radius: def.noise * D.noise.baseRadius * 0.5, x: pl.x, z: pl.z });
      clubHit(state, w, pl, events);
    } else if (def.use === 'flash') {
      release(state, pl, it); it.gone = true;
      events.push({ type: 'flash', player: pl.id, x: pl.x, y: eyeY(pl), z: pl.z, loud: def.noise,
        radius: def.noise * D.noise.baseRadius, seconds: def.flashSeconds });
      flashMonsters(state, w, pl.x, pl.z, def.flashSeconds, events);
    } else if (def.use === 'refill') {
      if (pl.oil >= 0.99) { events.push({ type: 'noNeed', player: pl.id }); return; }
      pl.oil = 1;
      release(state, pl, it); it.gone = true;
      events.push({ type: 'refill', player: pl.id });
    } else if (def.use === 'recall') { // the recall totem: Mortimer yanks you home, once
      var s = w.ship;
      if (state.phase !== 'night' || s.lift > 0.01 || pl.onDeck) { events.push({ type: 'noNeed', player: pl.id, recall: true }); return; }
      if ((pl.engulfed !== null && pl.engulfed !== undefined) || pl.carrying !== null) { events.push({ type: 'recallStuck', player: pl.id }); return; }
      release(state, pl, it); it.gone = true;
      var fx = pl.x, fz = pl.z;
      yankAboard(w, pl);
      events.push({ type: 'recalled', player: pl.id, fromX: fx, fromZ: fz, x: pl.x, z: pl.z });
    }
  }

  function openRoomDoors(w, roomId, events) {
    w.doors.forEach(function (d) {
      if (d.room !== roomId) return;
      d.open = true; d.timer = D.runes.openSeconds;
      events.push({ type: 'doorOpen', door: d.id, x: d.x, z: d.z });
    });
  }

  function stepDoors(state, w, dt, events) {
    w.doors.forEach(function (d) {
      if (!d.open) return;
      d.timer -= dt;
      if (d.timer > 0) return;
      for (var pid in state.players) { // never shut on a goblin standing in the doorway
        var p = state.players[pid];
        if (Math.abs(p.x - d.x) < (d.alongX ? 1.3 : 0.5) && Math.abs(p.z - d.z) < (d.alongX ? 0.5 : 1.3)) { d.timer = 0.5; return; }
      }
      d.open = false;
      events.push({ type: 'doorShut', door: d.id, x: d.x, z: d.z });
    });
  }

  // Mortimer draws what the goblin has seen: nearby cells, and whole rooms once entered.
  function revealAround(state, w, pl) {
    var cx = Math.floor(pl.x / w.cs), cy = Math.floor(pl.z / w.cs), R = D.map.revealRadius;
    for (var y = cy - R; y <= cy + R; y++) {
      for (var x = cx - R; x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= w.W || y >= w.H) continue;
        var c = y * w.W + x;
        if (isFloorKind(w.kind[c])) state.explored[c] = 1;
      }
    }
    var here = cellAt(w, pl.x, pl.z), rm = here >= 0 ? w.room[here] : -1;
    if (rm >= 0 && !state.roomsSeen[rm]) {
      state.roomsSeen[rm] = true;
      var R2 = w.rooms[rm];
      for (var yy = R2.y; yy < R2.y + R2.h; yy++) for (var xx = R2.x; xx < R2.x + R2.w; xx++) state.explored[yy * w.W + xx] = 1;
    }
  }

  function pickUp(state, pl, it, events) {
    var two = D.items[it.def].weight === 'twoHanded';
    if (two) {
      if (pl.twoHanded !== null || pl.slots.some(function (x) { return x !== null; })) {
        events.push({ type: 'handsFull', player: pl.id, twoHanded: true });
        return;
      }
      pl.twoHanded = it.id;
    } else {
      if (pl.twoHanded !== null) { events.push({ type: 'handsFull', player: pl.id }); return; }
      var slot = pl.slots[pl.sel] === null ? pl.sel : pl.slots.indexOf(null);
      if (slot < 0) { events.push({ type: 'handsFull', player: pl.id }); return; }
      pl.slots[slot] = it.id;
      pl.sel = slot;
    }
    it.holder = pl.id; it.chest = -1; it.inCart = false; it.handled = true; // crabs only go for loot a goblin has put down
    if (it.lostWith) { // a dead goblin's dropped loot, picked up again: no longer lost with them
      var dp = state.players[it.lostWith];
      if (dp && dp.deathLoot) for (var q = 0; q < dp.deathLoot.length; q++) if (dp.deathLoot[q].def === it.def && dp.deathLoot[q].value === it.value) { dp.deathLoot.splice(q, 1); break; }
      it.lostWith = null;
    }
    if (D.items[it.def].cursed) { it.marked = true; events.push({ type: 'cursedPickup', player: pl.id, def: it.def }); }
    if (D.items[it.def].wakes === 'pharaoh') wakePharaoh(state, events);
    events.push({ type: 'pickup', player: pl.id, item: it.id, def: it.def });
  }

  // Put an item down just in front of the goblin, or at its feet if a wall is there.
  function dropItem(state, w, pl, it, events) {
    release(state, pl, it);
    var fx = pl.x - Math.sin(pl.yaw) * 0.55, fz = pl.z - Math.cos(pl.yaw) * 0.55;
    var fp = footprint(w, fx, fz, 0), cart = w.rail && w.rail.cart;
    if (cart && !cart.moving && Math.hypot(fx - cart.x, fz - cart.z) < 0.75) { // into the mine cart's bed
      it.x = cart.x + (fx - cart.x) * 0.3; it.z = cart.z + (fz - cart.z) * 0.3; it.y = cart.y + 0.38; it.rot = pl.yaw;
      thud(it, events, 0.8);
      events.push({ type: 'drop', player: pl.id, item: it.id });
      return;
    }
    if (fp.floor === -Infinity || fp.floor > pl.y + 0.3 || blockedAt(w, pl, fx, fz, 0.1) === 'wall') {
      fx = pl.x; fz = pl.z; fp = footprint(w, fx, fz, 0);
    }
    it.x = fx; it.z = fz; it.y = fp.floor; it.rot = pl.yaw;
    thud(it, events, 0.5);
    events.push({ type: 'drop', player: pl.id, item: it.id });
  }

  function throwItem(state, w, pl, it, events) {
    release(state, pl, it);
    var d = lookDir(pl), sp = D.inventory.throwSpeed[D.items[it.def].weight] || 4;
    it.x = pl.x + d[0] * 0.4; it.z = pl.z + d[2] * 0.4; it.y = eyeY(pl) - 0.15;
    if (!openAt(w, it.x, it.z, it.y)) { it.x = pl.x; it.z = pl.z; } // face to a wall: it leaves from the goblin, not from inside the rock
    it.vx = d[0] * sp + pl.vx * 0.5; it.vy = d[1] * sp + 1.5; it.vz = d[2] * sp + pl.vz * 0.5;
    it.flying = true;
    events.push({ type: 'throw', player: pl.id, item: it.id });
  }

  function thud(it, events, scale) {
    var loud = D.noise.thud[D.items[it.def].weight] * (scale || 1);
    events.push({ type: 'thud', item: it.id, def: it.def, loud: loud, radius: loud * D.noise.baseRadius, x: it.x, z: it.z });
  }

  function stepPlayer(state, w, pl, inp, dt, events) {
    var P = D.player, Lt = D.lantern, INV = D.inventory;
    if (typeof inp.bardOk === 'boolean') pl.bardOk = inp.bardOk; // "Let the Bard borrow my voice" (it can change its mind after death, too)
    if (pl.dead) return; // lies where it fell until the night ends
    pl.yaw = inp.yaw; pl.pitch = inp.pitch;

    if (state.phase === 'pit') { stepPitFall(state, w, pl); pl.focus = null; return; }
    // Riding the Gutbucket down at dusk or up at dawn: look around, nothing else.
    if (state.phase === 'landing' || ((state.phase === 'liftoff' || state.phase === 'over') && pl.aboard)) {
      pl.y = w.ship.deck + w.ship.lift; pl.vx = pl.vz = pl.vy = 0; pl.grounded = true;
      pl.onDeck = true; pl.inside = false; pl.focus = null;
      return;
    }
    if (state.phase === 'over') return;

    // Load: everything carried slows you down and makes you louder.
    var list = carried(state, pl);
    pl.load = list.reduce(function (s2, it) { return s2 + weightOf(it); }, 0);
    var loadSpeed = Math.max(INV.minSpeedFactor, 1 - pl.load * INV.speedPerWeight);
    list.forEach(function (it) { if (D.items[it.def].slow) loadSpeed *= D.items[it.def].slow; });
    if (pl.carrying !== null) loadSpeed *= D.coop.bodySlow; // a crewmate over your shoulder

    // Inside a Gelatinous Cube: struggle out before it digests you.
    if (pl.engulfed !== null) { stepEngulfed(state, w, pl, inp, dt, events); return; }
    if (pl.heldBy !== null && pl.heldBy !== undefined) { // gripped by the Drowned Hands
      var hm = state.monsters[pl.heldBy];
      if (!hm || hm.dead || hm.holding !== pl.id) pl.heldBy = null;
      else inp = Object.assign({}, inp, { fwd: 0, strafe: 0, jump: false, sprint: false });
    }

    // Buried in a sand trap: nothing to do but struggle (or dig).
    var hc = cellAt(w, pl.x, pl.z);
    if (!pl.buried && hc >= 0 && w.sand[hc] > 0 && w.kind[hc] === INSIDE && w.ceil[hc] - (w.floor[hc] + w.sand[hc]) < P.crouchHeight - 0.02) {
      pl.buried = true; pl.digT = 0; pl.sandHurt = 0;
      events.push({ type: 'buried', player: pl.id });
    }
    if (pl.buried) { stepBuried(state, w, pl, inp, dt, events); return; }

    // Crouching: stay down if there's no room to stand.
    var here = footprint(w, pl.x, pl.z, P.radius);
    var headroom = here.ceil - pl.y;
    pl.crouching = !!inp.crouch || headroom < P.height;
    var height = pl.crouching ? P.crouchHeight : P.height;

    // Stamina and speed.
    var moving = Math.abs(inp.fwd) + Math.abs(inp.strafe) > 0.01;
    if (pl.exhausted && pl.stamina > P.staminaRecover) pl.exhausted = false;
    pl.sprinting = !!inp.sprint && moving && inp.fwd > 0 && !pl.crouching && !pl.exhausted && pl.grounded;
    if (pl.sprinting) {
      pl.stamina -= P.staminaDrain * (1 + pl.load * INV.drainPerWeight) * dt;
      pl.staminaDelay = P.staminaRegenDelay;
      if (pl.stamina <= 0) { pl.stamina = 0; pl.exhausted = true; }
    } else {
      pl.staminaDelay -= dt;
      if (pl.staminaDelay <= 0) pl.stamina = Math.min(1, pl.stamina + P.staminaRegen * loadSpeed * dt);
    }
    var speed = (pl.crouching ? P.crouchSpeed : pl.sprinting ? P.sprintSpeed : P.walkSpeed) * loadSpeed;

    var sy = Math.sin(pl.yaw), cy = Math.cos(pl.yaw);
    var wx = -sy * inp.fwd + cy * inp.strafe, wz = -cy * inp.fwd - sy * inp.strafe;
    var wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    var blend = Math.min(1, P.accel * dt * (pl.grounded ? 1 : P.airControl));
    pl.vx += (wx * speed - pl.vx) * blend;
    pl.vz += (wz * speed - pl.vz) * blend;

    // Horizontal movement, one axis at a time so goblins slide along walls.
    pl.lowCeilingAhead = false;
    // Already overlapping something (landing beside a step, sand rising): step out to the nearest clear spot. Only if
    // there's none within a goblin's width is it free to wriggle, and even then never with its middle into rock.
    var stuck = blockedAt(w, pl, pl.x, pl.z, height) === 'wall';
    if (stuck) {
      for (var nr = 0.04; nr <= 0.33 && stuck; nr += 0.04) {
        for (var na = 0; na < 8; na++) {
          var ox = pl.x + Math.cos(na * Math.PI / 4) * nr, oz = pl.z + Math.sin(na * Math.PI / 4) * nr;
          if (blockedAt(w, pl, ox, oz, height) !== 'wall') { pl.x = ox; pl.z = oz; stuck = false; break; }
        }
      }
    }
    var bx = blockedAt(w, pl, pl.x + pl.vx * dt, pl.z, height);
    if (!bx || (stuck && openCell(w, pl.x + pl.vx * dt, pl.z))) pl.x += pl.vx * dt; else { if (bx === 'low') pl.lowCeilingAhead = true; pl.vx = 0; }
    var bz = blockedAt(w, pl, pl.x, pl.z + pl.vz * dt, height);
    if (!bz || (stuck && openCell(w, pl.x, pl.z + pl.vz * dt))) pl.z += pl.vz * dt; else { if (bz === 'low') pl.lowCeilingAhead = true; pl.vz = 0; }

    // Vertical movement: follow stairs, hop, fall.
    here = footprint(w, pl.x, pl.z, P.radius * 0.7);
    var fl = here.floor === -Infinity ? pl.y : here.floor;
    if (pl.grounded) {
      if (inp.jump && !pl.crouching) {
        pl.vy = P.jumpSpeed * Math.sqrt(loadSpeed); pl.grounded = false; pl.fallFrom = pl.y;
      } else if (fl < pl.y - 0.6) {
        pl.grounded = false; pl.vy = 0; pl.fallFrom = pl.y;
      } else {
        pl.y += (fl - pl.y) * Math.min(1, 14 * dt);
        if (Math.abs(fl - pl.y) < 0.005) pl.y = fl;
      }
    }
    if (!pl.grounded) {
      pl.vy -= P.gravity * dt;
      pl.y += pl.vy * dt;
      if (pl.y > pl.fallFrom) pl.fallFrom = pl.y;
      if (pl.y + height > here.ceil) { pl.y = here.ceil - height; if (pl.vy > 0) pl.vy = 0; }
      if (pl.y <= fl) {
        var drop = pl.fallFrom - fl;
        pl.y = fl; pl.vy = 0; pl.grounded = true;
        var surface = surfaceAt(w, pl.x, pl.z, pl.y);
        var loud = D.noise.land * D.surfaces[surface].loud * (1 + pl.load * INV.noisePerWeight);
        events.push({ type: 'land', player: pl.id, surface: surface, drop: drop, loud: loud,
          radius: loud * D.noise.baseRadius, x: pl.x, z: pl.z });
        var lc = cellAt(w, pl.x, pl.z);
        if (drop > P.safeFall) hurt(state, w, pl, (drop - P.safeFall) * P.fallDamagePerMeter, w.chasm && lc >= 0 && w.chasm[lc] ? 'chasm' : 'fall', events);
      }
    }

    // Footsteps are noise: the renderer plays them, and monsters will hear them.
    var hs = Math.hypot(pl.vx, pl.vz);
    if (pl.grounded && hs > 0.3) {
      pl.stride += hs * dt;
      var strideLen = pl.crouching ? P.strideCrouch : pl.sprinting ? P.strideSprint : P.strideWalk;
      if (pl.stride >= strideLen) {
        pl.stride = 0;
        var surf = surfaceAt(w, pl.x, pl.z, pl.y);
        var base = pl.crouching ? D.noise.crouch : pl.sprinting ? D.noise.sprint : D.noise.walk;
        var l2 = base * D.surfaces[surf].loud * (1 + pl.load * INV.noisePerWeight);
        if (pl.crouching && D.surfaces[surf].crouchSilent) l2 = 0.02; // creeping on nightingale boards: not a peep
        events.push({ type: 'step', player: pl.id, surface: surf, loud: l2, radius: l2 * D.noise.baseRadius,
          x: pl.x, z: pl.z, load: pl.load });
      }
    } else {
      pl.stride = Math.min(pl.stride, 0.5);
    }

    // Inventory: pick a slot, then use, drop or throw what's in it.
    if (pl.twoHanded === null) {
      if (inp.slot >= 0 && inp.slot < INV.slots) pl.sel = inp.slot;
      if (inp.slotDelta) pl.sel = ((pl.sel + inp.slotDelta) % INV.slots + INV.slots) % INV.slots; // a merged input can carry several ticks
    }
    pl.focus = findFocus(state, w, pl);
    var held = heldItem(state, pl);
    if (inp.use && pl.focus) {
      var f = pl.focus;
      if (f.kind === 'item') pickUp(state, pl, state.items[f.id], events);
      else if (f.kind === 'chest' && state.chests[f.id].mimic) {
        var mim = mimicAt(state, f.id);
        events.push({ type: 'bite', monster: mim.id, x: mim.x, z: mim.z, first: true });
        wakeMimic(state, w, mim, events, 'opened');
        mim.cd = D.monsters.mimic.biteCooldown;
        hurt(state, w, pl, D.monsters.mimic.bite, 'mimic', events);
      } else if (f.kind === 'chest') {
        state.chests[f.id].open = true;
        var ch = w.chests[f.id], cl = D.noise.chest;
        events.push({ type: 'chestOpen', player: pl.id, chest: f.id, loud: cl, radius: cl * D.noise.baseRadius, x: ch.x, z: ch.z });
      } else if (f.kind === 'shop') buy(state, pl, D.shop[f.id], events);
      else if (f.kind === 'body') liftBody(state, pl, state.players[f.id], events);
      else if (f.kind === 'cart') pushCart(state, w, pl, events);
      else if (f.kind === 'pin') choosePin(state, pl, D.travel[f.id], events);
      else if (f.kind === 'upgrade') { buyUpgrade(state, pl, D.improvements[f.id], events); w.ship.hasBarrel = hasUpgrade(state.campaign, 'oil_barrel'); }
      else if (f.kind === 'bowl') scry(state, pl, events);
      else if (f.kind === 'gangway') toggleGangway(state, w, pl, events);
      else if (f.kind === 'hook') events.push({ type: 'tryWear', player: pl.id, id: D.wardrobe[f.id] }); // its own client knows what it owns
      else if (f.kind === 'hatch' && pl.carrying !== null) events.push({ type: 'noStowBody', player: pl.id });
      else if (f.kind === 'hatch' && held && held.tool) events.push({ type: 'noStowTool', player: pl.id });
      else if (f.kind === 'hatch' && held) {
        release(state, pl, held);
        held.gone = true;
        state.stowed.push({ def: held.def, value: held.value });
        events.push({ type: 'stow', player: pl.id, item: held.id, def: held.def });
      }
    }
    if (pl.focus && pl.focus.kind === 'helm' && inp.useHeld) {
      pl.helmHold += dt;
      if (pl.helmHold >= D.night.helmHoldSeconds) { pl.helmHold = 0; if (state.warren) departWarren(state, w, events); else if (state.sky) departSky(state, w, events); else liftOff(state, w, 'helm', events); }
    } else pl.helmHold = 0;
    // Rune doors: stand still and hold E while Mortimer grumbles out a translation.
    var RN = D.runes, still = Math.hypot(pl.vx, pl.vz) < 0.25;
    if (pl.focus && pl.focus.kind === 'door' && inp.useHeld && still) {
      if (pl.translating !== pl.focus.id) { pl.translating = pl.focus.id; pl.translateT = 0; pl.grumbleT = 0; }
      pl.translateT += dt; pl.grumbleT -= dt;
      if (pl.grumbleT <= 0) {
        pl.grumbleT = 0.8;
        events.push({ type: 'grumble', player: pl.id, loud: RN.grumbleNoise, radius: RN.grumbleNoise * D.noise.baseRadius * 0.6, x: pl.x, z: pl.z });
      }
      if (pl.translateT >= RN.translateSeconds) {
        openRoomDoors(w, w.doors[pl.translating].room, events);
        events.push({ type: 'translated', player: pl.id, door: pl.translating });
        pl.translating = -1; pl.translateT = 0;
      }
    } else { pl.translating = -1; pl.translateT = 0; }

    held = heldItem(state, pl);
    if (pl.swingT > 0) pl.swingT -= dt;
    if (held && inp.useItem && held.tool) useTool(state, w, pl, held, events);
    held = heldItem(state, pl);
    if (pl.carrying !== null) {
      var body = state.players[pl.carrying];
      if (!body || !body.dead) pl.carrying = null;
      else if (inp.drop) setBodyDown(state, w, pl, events);
      else { body.x = pl.x; body.z = pl.z; body.y = pl.y + D.coop.bodyHeight; body.yaw = pl.yaw; }
      inp = Object.assign({}, inp, { drop: false });
    }
    if (typeof inp.look === 'string' && inp.look !== pl.look) pl.look = cleanLook(inp.look);
    if (inp.signal && pl.lanternOn) { pl.signalT = D.coop.signalSeconds; events.push({ type: 'signal', player: pl.id, x: pl.x, z: pl.z }); } // costs nothing
    pl.signalT = Math.max(0, pl.signalT - dt);
    pl.shellTalk = !!inp.shell && !!held && !!D.items[held.def].shell;
    if (held && inp.drop) dropItem(state, w, pl, held, events);
    else if (held && inp.toss) throwItem(state, w, pl, held, events); // two-handed loot is heaved, not thrown far

    // Under water (the Sunken Galleon's tide): the lantern drowns, then so do you.
    var TD = w.tomb.tide, wasUnder = pl.underwater;
    pl.underwater = !!TD && eyeY(pl) < w.tide;
    if (pl.underwater) {
      if (pl.lanternOn) { pl.lanternOn = false; events.push({ type: 'lanternDrowned', player: pl.id }); }
      if (!wasUnder) events.push({ type: 'dive', player: pl.id, x: pl.x, z: pl.z });
      pl.breath = Math.max(0, pl.breath - dt / TD.breathSeconds);
      if (pl.breath <= 0) {
        pl.drownHurt += TD.drownPerSecond * dt;
        if (pl.drownHurt >= 3) { var dh = Math.floor(pl.drownHurt); pl.drownHurt -= dh; hurt(state, w, pl, dh, 'drowned', events); if (pl.dead) return; }
      }
    } else {
      if (wasUnder) events.push({ type: 'surface', player: pl.id, gasp: pl.breath < 0.5, x: pl.x, z: pl.z });
      pl.breath = Math.min(1, pl.breath + dt / 3);
    }

    // Lantern oil.
    if (inp.lantern) {
      if (pl.lanternOn) { pl.lanternOn = false; events.push({ type: 'lantern', player: pl.id, on: false }); }
      else if (pl.underwater) events.push({ type: 'lanternWet', player: pl.id });
      else if (pl.oil > Lt.relightCost) { pl.oil -= Lt.relightCost; pl.lanternOn = true; events.push({ type: 'lantern', player: pl.id, on: true }); }
      else events.push({ type: 'lanternEmpty', player: pl.id });
    }
    if (pl.lanternOn) {
      pl.oil -= dt / Lt.burnSeconds;
      if (pl.oil <= 0) { pl.oil = 0; pl.lanternOn = false; events.push({ type: 'lanternOut', player: pl.id }); }
    }
    var VO = D.noise.voice;
    if ((inp.voice || 0) > VO.threshold) {
      pl.voiceT -= dt;
      if (pl.voiceT <= 0) {
        pl.voiceT = VO.every;
        events.push({ type: 'voice', player: pl.id, loud: inp.voice, radius: inp.voice * VO.radius, x: pl.x, z: pl.z });
      }
    } else pl.voiceT = 0;
    pl.refilling = false;
    var s = w.ship;
    if (s.lift < 0.01 && s.hasBarrel && Math.hypot(pl.x - s.barrel.x, pl.z - s.barrel.z) < Lt.refillRadius && pl.oil < 1) {
      pl.oil = Math.min(1, pl.oil + Lt.refillRate * dt);
      pl.refilling = true;
    }

    var fpNow = footprint(w, pl.x, pl.z, 0);
    pl.inside = fpNow.inside;
    pl.inCover = inCover(w, pl);
    revealAround(state, w, pl);
    pl.onDeck = fpNow.deck && pl.y > s.deck - 0.2;
  }

  function hurt(state, w, pl, amount, cause, events) {
    // With the gangway up, nothing out there can reach you on deck (arrows still fly over).
    if (MON[cause] && cause !== 'ranger' && pl.onDeck && gangwayUp(state, w) && !monsterAboard(state, w)) { events.push({ type: 'gangwaySaved', player: pl.id, cause: cause, x: pl.x, z: pl.z }); return; }
    pl.hp = Math.max(0, pl.hp - amount);
    events.push({ type: 'hurt', player: pl.id, amount: amount, cause: cause });
    if (pl.hp <= 0 && !pl.dead) die(state, w, pl, cause, events);
  }

  // The death flop: the goblin drops where it stands and everything it carried
  // spills beside it. That loot is lost with it. If nobody's left standing,
  // Mortimer panics and lifts off early.
  // Carrying a fallen crewmate: up over the shoulder with E, down again with G. A body brought
  // aboard saves most of Craig's fee for hatching a new goblin.
  function liftBody(state, pl, body, events) {
    if (!body || !body.dead || body.carriedBy !== null || pl.carrying !== null || pl.twoHanded !== null) return;
    pl.carrying = body.id; body.carriedBy = pl.id;
    events.push({ type: 'liftBody', player: pl.id, body: body.id, x: pl.x, z: pl.z });
  }
  function setBodyDown(state, w, pl, events) {
    var body = state.players[pl.carrying];
    pl.carrying = null;
    if (!body) return;
    var d = lookDir(pl), bx = pl.x + d[0] * 0.5, bz = pl.z + d[2] * 0.5, c = cellAt(w, bx, bz);
    if (c < 0 || !isFloorKind(w.kind[c]) || Math.abs(floorAt(w, c, bx, bz) - pl.y) > 0.4) { bx = pl.x; bz = pl.z; } // no room ahead: at your feet
    body.x = bx; body.z = bz; body.y = pl.y; body.carriedBy = null;
    events.push({ type: 'dropBody', player: pl.id, body: body.id, x: bx, z: bz });
  }

  function die(state, w, pl, cause, events) {
    if (pl.carrying !== null) setBodyDown(state, w, pl, events);
    pl.shellTalk = false; pl.signalT = 0;
    pl.deathLoot = [];
    carried(state, pl).forEach(function (it, i) {
      release(state, pl, it);
      it.x = pl.x + ((i % 2) - 0.5) * 0.5; it.z = pl.z + ((i >> 1) - 0.5) * 0.5; it.y = pl.y;
      it.vx = it.vy = it.vz = 0; it.flying = false;
      it.lostWith = pl.id;
      if (!it.tool) pl.deathLoot.push({ def: it.def, value: it.value });
    });
    pl.dead = true; pl.cause = cause; pl.vx = pl.vz = pl.vy = 0; pl.lanternOn = pl.oil > 0; pl.helmHold = 0; pl.translating = -1;
    events.push({ type: 'death', player: pl.id, cause: cause, x: pl.x, y: pl.y, z: pl.z });
    var anyAlive = false;
    for (var pid in state.players) if (!state.players[pid].dead) anyAlive = true;
    if (!anyAlive && state.phase === 'night') state.panicT = D.death.panicSeconds;
  }

  // ---------- thrown loot ----------

  function openAt(w, px, pz, py) {
    var c = cellAt(w, px, pz);
    if (c < 0 || !isFloorKind(w.kind[c])) return false;
    if (floorAt(w, c, px, pz) > py + 0.05) return false;
    return w.kind[c] === OUTSIDE || w.ceil[c] > py;
  }

  // Does a thrown thing going from (ox, oz) to (nx, nz) at height y hit the Gutbucket's side?
  // The sides are padded by about a loot's half-width (`pad`), so nothing sinks into the planks.
  function shipWall(w, ox, oz, nx, nz, y) {
    var s = w.ship, t = 0.16, pad = 0.16, top = s.deck + s.lift + 0.85;
    if (y > top || y < s.lift - 0.6) return false; // over the rail, or under the hull in the air
    var gap = !w.sky && !s.gangwayUp && Math.abs(nx - s.gangway.x) < D.gutbucket.gangway / 2 && y > s.lift - 0.1; // the gangway's gap
    var inside = ox > s.x0 + t / 2 && ox < s.x1 - t / 2 && oz > s.z0 + t / 2 && oz < s.z1 - t / 2; // which side of the planks it started
    if (inside) { // on deck: no closer to a side than the pad, moving outward
      var lo = t + pad;
      return (nx < s.x0 + lo && nx < ox) || (nx > s.x1 - lo && nx > ox) || (nz < s.z0 + lo && nz < oz) || (nz > s.z1 - lo && nz > oz && !gap);
    }
    if (gap && Math.max(oz, nz) >= s.z1 - t) return false; // in through the gangway gap
    var inBox = function (x, z) { return x > s.x0 - pad && x < s.x1 + pad && z > s.z0 - pad && z < s.z1 + pad; };
    return inBox(nx, nz) && !inBox(ox, oz); // outside: stopped at the pad (something already in the planks is let out)
  }
  function sellInPit(state, it, events) {
    if (it.tool) { it.gone = true; events.push({ type: 'junk', item: it.id, def: it.def }); return; }
    var r = sellOne(state.campaign, it);
    state.campaign = r.campaign;
    it.gone = true;
    events.push({ type: 'sold', item: it.id, def: it.def, price: r.sale.price, value: it.value,
      fresh: r.sale.fresh, craved: r.sale.craved, gold: state.campaign.gold, toCut: r.sale.toCut, cutLeft: r.sale.cutLeft });
    if (r.sale.cutDone) events.push({ type: 'cutPaid', due: r.sale.due, left: state.campaign.gold, bare: false, inPit: true });
    if (r.unlocked) events.push({ type: 'unlocked', name: r.unlocked });
  }

  function stepItem(state, w, it, dt, events) {
    it.vy -= D.player.gravity * dt;
    var nx = it.x + it.vx * dt, nz = it.z + it.vz * dt, ny = it.y + it.vy * dt;
    var hit = false;
    if (!openAt(w, nx, it.z, it.y)) { it.vx = -it.vx * 0.35; nx = it.x; hit = true; }
    if (!openAt(w, nx, nz, it.y)) { it.vz = -it.vz * 0.35; nz = it.z; hit = true; }
    if (shipWall(w, it.x, it.z, nx, it.z, it.y)) { it.vx = -it.vx * 0.35; nx = it.x; hit = true; }
    if (shipWall(w, nx, it.z, nx, nz, it.y)) { it.vz = -it.vz * 0.35; nz = it.z; hit = true; }
    if (footprint(w, nx, nz, 0).floor === -Infinity) { nx = it.x; nz = it.z; it.vx = -it.vx * 0.35; it.vz = -it.vz * 0.35; hit = true; } // never into solid rock
    var fp = footprint(w, nx, nz, 0);
    if (ny > fp.ceil - 0.1) { ny = fp.ceil - 0.1; if (it.vy > 0) it.vy = -it.vy * 0.3; hit = true; }
    it.rot += dt * 9;
    if (ny <= fp.floor) {
      ny = fp.floor;
      if (it.vy < -2.5) { it.vy = -it.vy * 0.3; it.vx *= 0.6; it.vz *= 0.6; hit = true; }
      else { it.vx = it.vy = it.vz = 0; it.flying = false; hit = true; }
    }
    it.x = nx; it.y = ny; it.z = nz;
    if (state.monsters) state.monsters.forEach(function (m) {
      if (m.type === 'mimic' && !m.dead && m.state === 'dormant' && Math.hypot(m.x - it.x, m.z - it.z) < D.monsters.mimic.revealRange && it.y < m.y + 0.9) {
        wakeMimic(state, w, m, events, 'thrown');
        events.push({ type: 'mimicReveal', monster: m.id, x: m.x, z: m.z });
      }
    });
    if (hit) thud(it, events, it.flying ? 0.8 : 1);
    if (!it.flying && w.warren && state.phase === 'visit' && it.y < w.pit.floor + 0.5) sellInPit(state, it, events); // not once we're leaving (that sale would go nowhere)
  }

  // ---------- monsters ----------
  // Each follows one rule. Monsters walk the tomb grid (closed rune doors and low
  // ceilings stop them); the Knight steers freely across the open moor.
  var MON = D.monsters;

  function monsterGrid(w) {
    if (w._mgrid) return w._mgrid;
    var N = w.W * w.H, block = new Uint8Array(N), doorAt = {};
    w.props.forEach(function (p) {
      if (!p.shape || p.ship || p.type === 'door' || p.type === 'chest' || p.type === 'jackal' || p.type === 'dwarf_statue' || p.type === 'soldier_statue' || p.type === 'crate' || p.type === 'barrel' || p.type === 'giant_cap' || p.type === 'rim_post') return; // statues and cover leave room to walk round
      var c = cellAt(w, p.x, p.z);
      if (c >= 0) block[c] = 1;
    });
    var sh = w.ship; // nothing that walks gets onto the Gutbucket
    for (var sz = Math.floor(sh.z0 / w.cs); sz <= Math.floor(sh.z1 / w.cs); sz++) for (var sx = Math.floor(sh.x0 / w.cs); sx <= Math.floor(sh.x1 / w.cs); sx++) block[sz * w.W + sx] = 1;
    w.doors.forEach(function (d) {
      var o = DIRS[d.facing];
      var a = cellAt(w, d.x - o[0] * 0.5, d.z - o[1] * 0.5), b = cellAt(w, d.x + o[0] * 0.5, d.z + o[1] * 0.5);
      doorAt[a * N + b] = d; doorAt[b * N + a] = d;
    });
    w._mgrid = { block: block, doorAt: doorAt, N: N };
    return w._mgrid;
  }
  function monsterCell(w, c, height, mode) {
    var k = w.kind[c];
    if (w.sand[c] > 0.41 && mode !== 'fly') return false;
    if (k !== INSIDE && k !== OUTSIDE) return false;
    if (mode === 'inside' && k !== INSIDE) return false;
    return k !== INSIDE || w.ceil[c] - w.floor[c] >= height;
  }
  function monsterEdge(w, g, a, b, mode) {
    if (mode !== 'fly' && Math.abs(w.floor[a] - w.floor[b]) > D.player.stepUp + 0.01) return false;
    var d = g.doorAt[a * g.N + b];
    return !d || d.open;
  }
  // Cells-to-target for every cell, walking as this monster walks.
  function flowField(w, target, height, mode) {
    var g = monsterGrid(w), dist = new Int16Array(g.N).fill(-1), q = [target];
    dist[target] = 0;
    for (var qi = 0; qi < q.length; qi++) {
      var c = q[qi], cx = c % w.W, cy = (c / w.W) | 0;
      for (var k = 0; k < 4; k++) {
        var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= w.W || ny >= w.H) continue;
        var n = ny * w.W + nx;
        if (dist[n] >= 0 || (g.block[n] && mode !== 'fly') || !monsterCell(w, n, height, mode) || !monsterEdge(w, g, n, c, mode)) continue;
        dist[n] = dist[c] + 1;
        q.push(n);
      }
    }
    return dist;
  }
  function setGoal(w, m, x, z, height, mode) {
    var c = cellAt(w, x, z);
    m.tx = x; m.tz = z;
    if (c < 0 || (monsterGrid(w).block[c] && onDeckXZ(w, x, z))) { m.flow = null; return; } // not onto the deck
    var doorKey = w.doors.map(function (d) { return d.open ? 1 : 0; }).join('');
    if (c !== m.goalCell || doorKey !== m.doorKey || !m.flow) { m.goalCell = c; m.doorKey = doorKey; m.flow = flowField(w, c, height, mode); }
  }
  // Steps a grid-walking monster toward its goal. Returns true once it's there (or can't get there).
  function walkToGoal(w, m, speed, dt) {
    var c = cellAt(w, m.x, m.z);
    if (!m.flow || c < 0 || m.flow[c] < 0) return true;
    var aimX = m.tx, aimZ = m.tz;
    if (m.flow[c] > 0) {
      var cx = c % w.W, cy = (c / w.W) | 0, g = monsterGrid(w);
      for (var k = 0; k < 4; k++) {
        var n = (cy + DIRS[k][1]) * w.W + cx + DIRS[k][0];
        if (m.flow[n] === m.flow[c] - 1 && monsterEdge(w, g, c, n, m.mode)) { var aim = aroundCover(w, n, (cx + DIRS[k][0] + 0.5) * w.cs, (cy + DIRS[k][1] + 0.5) * w.cs, m.mode); aimX = aim[0]; aimZ = aim[1]; break; }
      }
      if (k === 4) { m.flow = null; return true; } // no way on from here any more (a door shut): stop, and the caller picks again
    }
    var dx = aimX - m.x, dz = aimZ - m.z, d = Math.hypot(dx, dz);
    if (m.flow[c] === 0 && d < 0.35) return true;
    if (d > 1e-4) {
      var stepLen = Math.min(d, speed * dt);
      m.x += dx / d * stepLen; m.z += dz / d * stepLen;
      m.dir = turnToward(m.dir, Math.atan2(dx, dz), 6 * dt);
    }
    var fc = cellAt(w, m.x, m.z), f = w.floor[fc] + w.sand[fc];
    if (m.mode !== 'fly') m.y += (f - m.y) * Math.min(1, 10 * dt);
    m.moving = true;
    return false;
  }
  // A crate or barrel in the next cell: aim for the clear side of the cell instead of its middle.
  var AROUND = [[0, 0], [0.62, 0], [-0.62, 0], [0, 0.62], [0, -0.62], [0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]];
  function aroundCover(w, c, x, z, mode) {
    var list = w.propCells[c];
    if (!list || mode === 'fly') return [x, z];
    var cover = list.map(function (i) { return w.props[i]; }).filter(function (p) { return p.type === 'crate' || p.type === 'barrel' || p.type === 'jackal' || p.type === 'dwarf_statue' || p.type === 'soldier_statue' || p.type === 'giant_cap'; });
    if (!cover.length) return [x, z];
    var best = AROUND[0], bd = -Infinity;
    AROUND.forEach(function (o) {
      var d = Infinity;
      cover.forEach(function (p) { d = Math.min(d, Math.hypot(x + o[0] - p.x, z + o[1] - p.z) - (p.r || Math.max(p.hw, p.hd))); });
      if (d > bd + 1e-6) { bd = d; best = o; }
    });
    return [x + best[0], z + best[1]];
  }
  function turnToward(a, b, maxStep) {
    var d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + Math.max(-maxStep, Math.min(maxStep, d));
  }
  // A clear straight line through open cells (no closed doors) - for the Ranger's arrows.
  // throughPaper: paper screens (the Yomi Shrine) don't block it, for a goblin whose light throws a shadow on them.
  function losVia(w, g, a, s, b) { var d1 = g.doorAt[a * g.N + s], d2 = g.doorAt[s * g.N + b]; return isFloorKind(w.kind[s]) && (!d1 || d1.open) && (!d2 || d2.open); }
  function lineOfSight(w, x0, z0, x1, z1, throughPaper) {
    var g = monsterGrid(w), steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.5), prev = cellAt(w, x0, z0);
    for (var i = 1; i <= steps; i++) {
      var c = cellAt(w, x0 + (x1 - x0) * i / steps, z0 + (z1 - z0) * i / steps);
      if (c >= 0 && throughPaper && w.paper && w.paper[c]) continue;
      if (c < 0 || !isFloorKind(w.kind[c])) return false;
      if (c !== prev) {
        var ddx = (c % w.W) - (prev % w.W), ddy = ((c / w.W) | 0) - ((prev / w.W) | 0);
        if (ddx && ddy) { if (!losVia(w, g, prev, prev + ddx, c) && !losVia(w, g, prev, prev + ddy * w.W, c)) return false; }
        else { var d = g.doorAt[prev * g.N + c]; if (d && !d.open) return false; }
        prev = c;
      }
    }
    return true;
  }
  function goblins(state) {
    var out = [];
    for (var pid in state.players) { var p = state.players[pid]; if (!p.dead && !p.aboard) out.push(p); }
    return out;
  }
  function nearestGoblin(state, x, z, filter) {
    var best = null, bd = Infinity;
    goblins(state).forEach(function (p) {
      if (filter && !filter(p)) return;
      var d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = p; }
    });
    return best;
  }
  // ---- sight and hiding
  // How tall a prop stands as cover (meters above its base); 0 if it hides nothing.
  var COVER = { standing_stone: 'h', obelisk: 'h', pine: 'h', mine_post: 'h', boulder: 's',
    slab: 0.72, dwarf_tomb: 0.74, dwarf_pillar: 'h', dwarf_statue: 1.75, forge: 1.1, giant_cap: 'h', grove_cap: 0.7, cargo: 0.85, cabinet: 1.6, soldier_statue: 1.8, ruin_column: 'h', rubble: 's', stone_lantern: 1.4, bamboo: 'h', coffin: 0.56, sarcophagus: 0.95, plinth: 0.95, jackal: 1.6, chest: 0.56, crate: 0.95, barrel: 0.9 };
  function coverOf(p) {
    var c = COVER[p.type];
    return c === 'h' ? p.h : c === 's' ? p.s * 1.1 : c || 0;
  }
  function lit(state, p, w) { return p.lanternOn || (heldItem(state, p) && heldItem(state, p).def === 'torch') || (w ? nearGlow(w, p) : false); }
  // Standing by a glowcap lights you up as well as any lantern.
  function nearGlow(w, p) {
    var HZ = w.tomb.hazards;
    if (!HZ || !HZ.glowRange) return false;
    for (var i = 0; i < w.glowcaps.length; i++) { var g = w.glowcaps[i]; if (Math.abs(g.y - p.y) < 2 && Math.hypot(g.x - p.x, g.z - p.z) < HZ.glowRange) return true; }
    return false;
  }
  // Can monster m see goblin p? A view cone, a range that shrinks for a crouching or unlit
  // goblin, walls and shut doors, and cover: a prop between them that's tall enough to hide
  // the goblin (crouching behind waist-high cover, or standing behind something taller).
  function canSee(state, w, m, p, spec) {
    if (p.onDeck && p.crouching && !inShipRect(w, m.x, m.z)) return false; // down behind the gunwale
    var S0 = D.sight, fov = (spec.fov || S0.fov) * Math.PI / 180;
    var dx = p.x - m.x, dz = p.z - m.z, d = Math.hypot(dx, dz);
    if (Math.abs(p.y - m.y) > 3) return false;
    var range = (lit(state, p, w) ? (spec.lit || S0.lit) : (spec.dark || S0.dark)) * (p.crouching ? (spec.crouch || S0.crouch) : 1);
    if (d > range) return false;
    if (d > S0.near && fov < Math.PI * 2) {
      var off = Math.atan2(Math.sin(Math.atan2(dx, dz) - m.dir), Math.cos(Math.atan2(dx, dz) - m.dir));
      if (Math.abs(off) > fov / 2) return false;
    }
    if (d < 0.5) return true;
    if (!lineOfSight(w, m.x, m.z, p.x, p.z, lit(state, p, w))) return false;
    var need = p.crouching ? S0.coverCrouch : S0.coverStand, steps = Math.floor((d - 0.3) / 0.2);
    for (var i = 2; i <= steps; i++) {
      var sx = m.x + dx / d * i * 0.2, sz = m.z + dz / d * i * 0.2, list = w.propCells[cellAt(w, sx, sz)];
      if (!list) continue;
      for (var j = 0; j < list.length; j++) {
        var pr = w.props[list[j]];
        if (pr.ship || pr.door !== undefined || (pr.chest !== undefined && w.chests[pr.chest].loose)) continue;
        if ((pr.y || 0) + coverOf(pr) - p.y >= need && hitsProp(pr, sx, sz, 0.02)) return false;
      }
    }
    return true;
  }
  // Is the goblin crouched right up against cover? (Shown on the HUD; the monster still decides.)
  function inCover(w, p) {
    if (!p.crouching) return false;
    var c0 = cellAt(w, p.x, p.z), cx = c0 % w.W, cy = (c0 / w.W) | 0;
    for (var yy = cy - 1; yy <= cy + 1; yy++) for (var xx = cx - 1; xx <= cx + 1; xx++) {
      var list = w.propCells[yy * w.W + xx];
      if (list) for (var i = 0; i < list.length; i++) {
        var pr = w.props[list[i]];
        if (!pr.ship && pr.door === undefined && (pr.y || 0) + coverOf(pr) - p.y >= D.sight.coverCrouch && hitsProp(pr, p.x, p.z, 0.75)) return true;
      }
    }
    return false;
  }
  // A monster hunting by sight: chases the goblin it can see; once it can't, goes to where it
  // last saw one and searches, then gives up. Returns where to go, or null to carry on as normal.
  function trackBySight(state, w, m, spec, dt, events) {
    var seen = null, bd = Infinity;
    goblins(state).forEach(function (p) {
      if (p.onDeck || (spec.outside && p.inside)) return;
      var d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d < bd && canSee(state, w, m, p, spec)) { bd = d; seen = p; }
    });
    if (seen) {
      m.lastSeen = { x: seen.x, z: seen.z }; m.searchT = 0; m.searching = false;
      if (!m.spotted) { m.spotted = true; events.push({ type: 'spotted', monster: m.id, kind: m.type, player: seen.id, x: m.x, z: m.z }); }
      return { x: seen.x, z: seen.z, what: 'goblin', player: seen };
    }
    if (!m.lastSeen) return null;
    if (!m.searching && Math.hypot(m.lastSeen.x - m.x, m.lastSeen.z - m.z) < 0.9) m.searching = true;
    if (m.searching) {
      m.searchT += dt;
      m.dir += dt * 1.6 * Math.sin(m.searchT * 1.3); // looking about
      if (m.searchT >= (spec.search || D.sight.search)) {
        m.lastSeen = null; m.searching = false; m.spotted = false;
        events.push({ type: 'lostYou', monster: m.id, kind: m.type, x: m.x, z: m.z });
        return null;
      }
      return { x: m.x, z: m.z, what: 'search' };
    }
    return { x: m.lastSeen.x, z: m.lastSeen.z, what: 'lastSeen' };
  }

  function addMonster(state, type, x, y, z, extra) {
    var m = { id: state.monsters.length, type: type, x: x, y: y, z: z, dir: 0, state: 'idle', stunT: 0, blindT: 0,
      cd: 0, dead: false, moving: false, rng: makeRng(state.seedBase + ':' + type + ':' + state.monsters.length) };
    for (var k in extra) m[k] = extra[k];
    state.monsters.push(m);
    return m;
  }

  // ---- the Mimic Chest: looks like a chest, bites whoever opens it
  function wakeMimic(state, w, m, events, why) {
    if (m.dead || m.state === 'awake') return;
    m.state = 'awake'; m.calm = 0;
    w.chests[m.chest].loose = true; // no longer where its chest used to stand
    events.push({ type: 'mimicWake', monster: m.id, why: why, x: m.x, z: m.z });
  }
  function mimicAt(state, chestIndex) {
    for (var i = 0; i < state.monsters.length; i++) { var m = state.monsters[i]; if (m.type === 'mimic' && m.chest === chestIndex) return m; }
    return null;
  }
  function killMimic(state, w, m, events) {
    m.dead = true;
    var ch = state.chests[m.chest];
    ch.open = true; ch.x = m.x; ch.z = m.z;
    var k = 0;
    state.items.forEach(function (it) { // whatever it swallowed spills out
      if (it.chest !== m.chest || it.gone) return;
      it.chest = -1; it.x = m.x + ((k % 2) - 0.5) * 0.7; it.z = m.z + ((k >> 1) - 0.5) * 0.7; it.y = m.y; k++;
    });
    events.push({ type: 'mimicDead', monster: m.id, x: m.x, z: m.z });
  }
  function stepMimic(state, w, m, dt, events) {
    var MM = MON.mimic;
    state.chests[m.chest].x = m.x; state.chests[m.chest].z = m.z; state.chests[m.chest].y = m.y;
    if (m.state !== 'awake' || m.stunT > 0 || m.blindT > 0) { m.moving = false; return; }
    var t = nearestGoblin(state, m.x, m.z), d = t ? Math.hypot(t.x - m.x, t.z - m.z) : Infinity;
    if (d < 1.0 && Math.abs(t.y - m.y) < 1 && m.cd <= 0) {
      m.cd = MM.biteCooldown; m.calm = 0;
      events.push({ type: 'bite', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, t, MM.awakeBite, 'mimic', events);
      return;
    }
    m.moving = false;
    var tr = trackBySight(state, w, m, MM.sight, dt, events);
    if (!tr) { // lost you: it settles back down to wait
      m.calm += dt;
      if (m.calm > MM.calmAfter) { m.state = 'dormant'; m.spotted = false; events.push({ type: 'mimicSleep', monster: m.id }); }
      return;
    }
    m.calm = 0;
    if (tr.what === 'search') return;
    setGoal(w, m, tr.x, tr.z, 0.5, 'inside');
    if (walkToGoal(w, m, MM.hopSpeed, dt) && tr.what === 'lastSeen') m.searching = true;
  }

  // ---- the Ranger: blind, hunts by sound
  function stepRanger(state, w, m, dt, events, noises) {
    var R = MON.ranger;
    m.shootCd -= dt; m.stabCd -= dt; m.moving = false;
    noises.forEach(function (e) {
      if (Math.hypot(e.x - m.x, e.z - m.z) <= e.radius * R.hearing) { m.heard = { x: e.x, z: e.z, loud: e.loud || 0.5 }; m.fresh = true; }
    });
    var t = nearestGoblin(state, m.x, m.z);
    if (t && Math.hypot(t.x - m.x, t.z - m.z) < R.stabRange && Math.abs(t.y - m.y) < 1.5 && m.stabCd <= 0) {
      m.stabCd = R.stabCooldown;
      events.push({ type: 'stab', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, t, R.stab, 'ranger', events);
    }
    if (m.fresh) {
      m.fresh = false;
      var hd = Math.hypot(m.heard.x - m.x, m.heard.z - m.z);
      if (m.state === 'draw') m.aim = { x: m.heard.x, z: m.heard.z }; // follows the sound until it lets go
      else if (m.shootCd <= 0 && hd < R.shootRange && hd > 1.5 && lineOfSight(w, m.x, m.z, m.heard.x, m.heard.z)) {
        m.state = 'draw'; m.drawT = R.drawSeconds; m.aim = { x: m.heard.x, z: m.heard.z };
        events.push({ type: 'creak', monster: m.id, x: m.x, z: m.z });
      } else {
        if (m.state !== 'hunt') events.push({ type: 'rangerHeard', monster: m.id, x: m.x, z: m.z });
        m.state = 'hunt'; setGoal(w, m, m.heard.x, m.heard.z, R.height, 'inside');
      }
    }
    if (m.state === 'draw') {
      m.dir = turnToward(m.dir, Math.atan2(m.aim.x - m.x, m.aim.z - m.z), 8 * dt);
      m.drawT -= dt;
      if (m.drawT > 0) return;
      var hit = null;
      goblins(state).forEach(function (p) {
        if (p.onDeck && p.crouching && !inShipRect(w, m.x, m.z)) return; // the arrow thunks into the gunwale
        if (!hit && Math.hypot(p.x - m.aim.x, p.z - m.aim.z) < R.arrowHitRadius) hit = p;
      });
      var ac = cellAt(w, m.aim.x, m.aim.z), ay = ac >= 0 ? w.floor[ac] : m.y;
      events.push({ type: 'arrow', monster: m.id, hit: !!hit, from: { x: m.x, y: m.y + 1.45, z: m.z },
        to: { x: m.aim.x, y: hit ? hit.y + 0.7 : ay + 0.25, z: m.aim.z } });
      if (hit) hurt(state, w, hit, R.arrowDamage, 'arrow', events);
      m.shootCd = R.shootCooldown;
      m.state = 'hunt'; setGoal(w, m, m.aim.x, m.aim.z, R.height, 'inside');
      return;
    }
    if (m.state === 'hunt') {
      if (walkToGoal(w, m, m.heard && m.heard.loud >= 0.8 ? R.rushSpeed : R.huntSpeed, dt)) {
        m.state = 'sniff'; m.sniffT = R.sniffSeconds;
        events.push({ type: 'sniff', monster: m.id, x: m.x, z: m.z });
      }
      return;
    }
    if (m.state === 'sniff') {
      m.sniffT -= dt; m.dir += dt * 1.1;
      if (m.sniffT <= 0) { m.state = 'wander'; m.wanderT = 0; }
      return;
    }
    // wander between rooms, pausing now and then
    m.state = 'wander';
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    if (!m.flow || walkToGoal(w, m, R.wanderSpeed, dt)) {
      var rm = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      setGoal(w, m, (rm.x + 0.5 + m.rng() * (rm.w - 1)) * w.cs, (rm.y + 0.5 + m.rng() * (rm.h - 1)) * w.cs, R.height, 'inside');
      m.pauseT = m.rng() < 0.4 ? 1.5 + m.rng() * 2 : 0;
      if (m.pauseT) events.push({ type: 'sniff', monster: m.id, x: m.x, z: m.z });
    }
  }

  // ---- the Knight Errant: hunts goblins in the open
  function knightFree(w, x, z, rad) {
    var r = rad || MON.knight.radius, s = w.ship;
    if (x > s.x0 - r - 0.4 && x < s.x1 + r + 0.4 && z > s.z0 - r - 0.4 && z < s.z1 + r + 1.8) return false; // the ship and its gangplank
    var pts = [[r, 0], [-r, 0], [0, r], [0, -r]];
    for (var i = 0; i < pts.length; i++) {
      var c = cellAt(w, x + pts[i][0], z + pts[i][1]);
      if (c < 0 || w.kind[c] !== OUTSIDE) return false;
    }
    for (i = 0; i < w.props.length; i++) {
      var p = w.props[i];
      if (p.shape === 'circle' && !p.ship && Math.hypot(p.x - x, p.z - z) < p.r + r) return false;
    }
    return true;
  }
  function stepKnight(state, w, m, dt, events) {
    var K = MON.knight;
    m.hitCd -= dt; m.snortT -= dt;
    if (m.snortT <= 0) { m.snortT = 5 + m.rng() * 6; events.push({ type: 'snort', monster: m.id, x: m.x, z: m.z }); }
    if (m.blindT > 0) { m.speed = Math.max(0, m.speed - 9 * dt); m.state = 'rearing'; return; }
    // He hunts by sight: out in the open, lit goblins from far off; rocks and trees hide you.
    var tr = trackBySight(state, w, m, K.sight, dt, events), target = tr && tr.player ? tr.player : null;
    var want = m.dir, spd = K.patrolSpeed;
    if (m.overshoot > 0) { m.overshoot -= dt; spd = K.chargeSpeed; }
    else if (tr && !target) { // rides to where he last saw you, and circles there
      m.state = 'search';
      if (tr.what === 'lastSeen') {
        want = Math.atan2(tr.x - m.x, tr.z - m.z); spd = K.patrolSpeed * 1.4;
        if (Math.hypot(tr.x - m.x, tr.z - m.z) < 3) m.searching = true;
      } else want = m.dir + 0.9;
    }
    else if (target) {
      want = Math.atan2(target.x + target.vx * 0.35 - m.x, target.z + target.vz * 0.35 - m.z);
      spd = K.chargeSpeed;
      if (m.state !== 'charge') events.push({ type: 'charge', monster: m.id, x: m.x, z: m.z });
      m.state = 'charge';
    } else {
      m.state = 'patrol';
      if (!m.wp || Math.hypot(m.wp.x - m.x, m.wp.z - m.z) < 3) m.wp = knightSpot(state, w, m.rng, 10);
      if (m.wp) want = Math.atan2(m.wp.x - m.x, m.wp.z - m.z);
    }
    m.dir = turnToward(m.dir, want, (m.state === 'charge' ? K.chargeTurnRate : K.turnRate) * dt);
    m.speed += Math.max(-K.accel * 2 * dt, Math.min(K.accel * dt, spd - m.speed));
    var nx = m.x + Math.sin(m.dir) * m.speed * dt, nz = m.z + Math.cos(m.dir) * m.speed * dt;
    if (knightFree(w, nx, nz)) { m.x = nx; m.z = nz; }
    else { // wheel away from whatever's in the way
      m.speed *= 0.4;
      var left = knightFree(w, m.x + Math.sin(m.dir + 1.2) * 1.5, m.z + Math.cos(m.dir + 1.2) * 1.5);
      m.dir += (left ? 1 : -1) * Math.min(1, 2.5 * dt + 0.15);
      m.overshoot = 0; m.wp = null;
    }
    m.moving = m.speed > 0.2;
    if (target && m.hitCd <= 0 && m.speed > 3 && Math.hypot(target.x - m.x, target.z - m.z) < K.hitRange) {
      m.hitCd = K.hitCooldown; m.overshoot = K.overshootSeconds;
      target.vx += Math.sin(m.dir) * 6; target.vz += Math.cos(m.dir) * 6; target.warp = (target.warp || 0) + 1;
      events.push({ type: 'lance', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, target, K.hit, 'knight', events);
    }
  }
  function knightSpot(state, w, rng, minFromShip) {
    for (var a = 0; a < 60; a++) {
      var x = rng() * w.W * w.cs, z = rng() * w.H * w.cs;
      if (!knightFree(w, x, z) || Math.hypot(x - w.ship.x, z - w.ship.z) < minFromShip) continue;
      return { x: x, z: z };
    }
    return null;
  }

  // ---- Pharaoh's Tomb: curses, the Mummy, the Pharaoh, scarabs, the Jackal Warden

  // The nearest cursed thing: the goblin carrying it, where it was dropped, or the
  // Gutbucket's gangway if it's aboard. onlyDef narrows it to one kind (the Pharaoh's lid).
  function curseTarget(state, w, m, onlyDef) {
    var best = null, bd = Infinity, s = w.ship;
    var gang = { x: s.gangway.x, z: s.gangway.z + 1.4 };
    function consider(x, z, what) { var d = Math.hypot(x - m.x, z - m.z); if (d < bd) { bd = d; best = { x: x, z: z, what: what }; } }
    state.items.forEach(function (it) {
      // cursed loot marks whoever takes it: untouched, it's just lying in the dark
      if (it.gone || (onlyDef ? it.def !== onlyDef : !(D.items[it.def].cursed && it.marked))) return;
      if (it.holder !== null) {
        var h = state.players[it.holder];
        if (h.onDeck && s.lift < 0.01) consider(gang.x, gang.z, 'ship'); else consider(h.x, h.z, 'goblin');
      } else if (onDeckXZ(w, it.x, it.z) && it.y > s.deck - 0.2) consider(gang.x, gang.z, 'ship');
      else consider(it.x, it.z, 'item');
    });
    if (!onlyDef && state.stowed.concat(state.campaign.hold || []).some(function (h) { return D.items[h.def].cursed; })) consider(gang.x, gang.z, 'ship');
    return best;
  }

  function stepMummy(state, w, m, dt, events, spec, lidOnly) {
    m.moving = false;
    m.groanT -= dt;
    if (m.groanT <= 0) { m.groanT = 6 + m.rng() * 6; events.push({ type: 'groan', monster: m.id, kind: m.type, x: m.x, z: m.z }); }
    if (m.blindT > 0) return;
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (near && nd < spec.hitRange && Math.abs(near.y - m.y) < 1.5 && m.cd <= 0) {
      m.cd = spec.hitCooldown;
      events.push({ type: 'mummyHit', monster: m.id, kind: m.type, x: m.x, z: m.z });
      hurt(state, w, near, spec.hit, m.type, events);
      return;
    }
    // cursed loot first (it always knows where that is), then any goblin it can see
    var tgt = curseTarget(state, w, m, lidOnly ? 'sarcophagus_lid' : null);
    m.curseBlockT = Math.max(0, (m.curseBlockT || 0) - dt);
    m.cursing = !!tgt && tgt.what !== 'ship' && !(m.curseBlockT > 0); // on the trail of cursed loot (for the warning sounds)
    if (tgt && tgt.what === 'ship') {
      // Waiting at the gangway for loot that's gone aboard: a goblin that comes into view, or just
      // comes close, is worth chasing again.
      var seen = trackBySight(state, w, m, spec.sight, dt, events), close = null, cd = spec.reaggro;
      goblins(state).forEach(function (p) {
        var d = Math.hypot(p.x - m.x, p.z - m.z);
        if (!p.onDeck && d < cd && Math.abs(p.y - m.y) < 2) { cd = d; close = p; }
      });
      if (seen && seen.what === 'goblin') tgt = seen;
      else if (close) {
        tgt = { x: close.x, z: close.z, what: 'goblin', player: close };
        m.lastSeen = { x: close.x, z: close.z }; m.searchT = 0; m.searching = false;
        if (!m.spotted) { m.spotted = true; events.push({ type: 'spotted', monster: m.id, kind: m.type, player: close.id, x: m.x, z: m.z }); }
      }
    }
    if (!tgt) tgt = trackBySight(state, w, m, spec.sight, dt, events);
    if (!tgt || tgt.what === 'search') return; // stands where it is, swaying
    setGoal(w, m, tgt.x, tgt.z, spec.height, 'any');
    var there = walkToGoal(w, m, spec.speed, dt);
    if (there && tgt.what === 'lastSeen') m.searching = true;
    if (there && tgt.what !== 'ship' && tgt.what !== 'lastSeen' && Math.hypot(tgt.x - m.x, tgt.z - m.z) > 3) { m.curseBlockT = 5; m.cursing = false; } // can't get there (a sealed door): it waits, quietly, and tries again
    if (there && tgt.what === 'ship' && !m.atShip) { m.atShip = true; events.push({ type: 'mummyAtShip', monster: m.id }); }
    if (tgt.what !== 'ship') m.atShip = false;
  }

  function stepPharaoh(state, w, m, dt, events) {
    var PH = MON.pharaoh;
    if (m.state === 'dormant') return;
    if (m.state === 'rising') {
      m.riseT -= dt;
      if (m.riseT <= 0) {
        m.state = 'hunt';
        m.x = m.stepOut.x; m.z = m.stepOut.z; // climbs out beside the sarcophagus
        events.push({ type: 'pharaohRise', monster: m.id, x: m.x, z: m.z });
      }
      return;
    }
    stepMummy(state, w, m, dt, events, PH, true);
  }
  function wakePharaoh(state, events) {
    state.monsters.forEach(function (m) {
      if (m.type !== 'pharaoh' || m.state !== 'dormant') return;
      m.state = 'rising'; m.riseT = MON.pharaoh.riseSeconds;
      events.push({ type: 'pharaohStir', monster: m.id, x: m.x, z: m.z });
    });
  }

  // Scarabs keep out of the light. A lantern in hand lights a wide circle; hanging
  // from the belt (both hands full) it lights much less; a torch lights most.
  function lightRadius(state, p) {
    var SC = MON.scarabs, held = heldItem(state, p);
    if (held && held.def === 'torch') return SC.lightRadius.torch;
    if (!p.lanternOn) return 0;
    return p.twoHanded !== null ? SC.lightRadius.belt : SC.lightRadius.lantern;
  }
  function stepJars(state, w, events) {
    var SC = MON.scarabs;
    w.jars.forEach(function (j, i) {
      if (state.jars[i].cracked) return;
      var p = goblins(state).filter(function (g) { return Math.hypot(g.x - j.x, g.z - j.z) < SC.crackRange && Math.abs(g.y - j.y) < 1.5; })[0];
      if (!p) return;
      state.jars[i].cracked = true;
      addMonster(state, 'scarabs', j.x, j.y, j.z, { life: SC.lifeSeconds, chew: 0, chewing: false });
      events.push({ type: 'jarCrack', jar: i, x: j.x, z: j.z });
    });
  }
  function stepScarabs(state, w, m, dt, events) {
    var SC = MON.scarabs;
    m.life -= dt; m.moving = false; m.wasChewing = m.chewing; m.chewing = false;
    if (m.life <= 0) { m.dead = true; events.push({ type: 'scarabsGone', monster: m.id }); return; }
    var t = nearestGoblin(state, m.x, m.z);
    if (!t) return;
    var d = Math.hypot(t.x - m.x, t.z - m.z), lr = lightRadius(state, t);
    if (d > lr + 0.25) { setGoal(w, m, t.x, t.z, 0.3, 'any'); walkToGoal(w, m, SC.speed, dt); }
    else if (d < lr && d > 1e-3) { // back away from the light
      var nx = m.x + (m.x - t.x) / d * SC.speed * dt, nz = m.z + (m.z - t.z) / d * SC.speed * dt, c = cellAt(w, nx, nz);
      if (c >= 0 && isFloorKind(w.kind[c]) && Math.abs(w.floor[c] - m.y) < 0.6) { m.x = nx; m.z = nz; m.moving = true; }
    }
    if (d < SC.chewRange && Math.hypot(t.vx, t.vz) < SC.stillSpeed && Math.abs(t.y - m.y) < 1.2) {
      if (!m.wasChewing) events.push({ type: 'nibble', monster: m.id, player: t.id, x: m.x, z: m.z }); // they've found your feet
      m.chewing = true;
      m.chew += SC.chewPerSecond * dt;
      if (m.chew >= 3) { var bite = Math.floor(m.chew); m.chew -= bite; events.push({ type: 'chew', monster: m.id, x: m.x, z: m.z }); hurt(state, w, t, bite, 'scarabs', events); }
    }
  }

  function stepJackal(state, w, m, dt, events) {
    var J = MON.jackal;
    m.glow = false;
    goblins(state).forEach(function (p) {
      var d = Math.hypot(p.x - m.x, p.z - m.z);
      if (Math.abs(p.y - m.y) > 1.5 || d > J.glowRange || p.load <= J.maxLoad) return;
      m.glow = true;
      if (!m.warned) { m.warned = true; events.push({ type: 'jackalGlow', monster: m.id, x: m.x, z: m.z }); }
      if (d < J.biteRange && m.cd <= 0) {
        m.cd = J.biteCooldown;
        events.push({ type: 'jackalBite', monster: m.id, x: m.x, z: m.z });
        hurt(state, w, p, J.bite, 'jackal', events);
      }
    });
    if (!m.glow) m.warned = false;
  }

  // Sand traps: a pressure plate, a click, then sand pours in until the room is full.
  function stepTraps(state, w, dt, events) {
    var HZ = w.tomb.hazards;
    w.traps.forEach(function (tp, ti) {
      var ts = state.traps[ti];
      if (!ts.triggered) {
        var on = goblins(state).some(function (p) { return p.grounded && Math.hypot(p.x - tp.x, p.z - tp.z) < 0.55 && Math.abs(p.y - tp.y) < 0.4; });
        if (on) { ts.triggered = true; ts.t = 0; events.push({ type: 'trapClick', trap: ti, x: tp.x, z: tp.z }); }
        return;
      }
      if (ts.level >= ts.max) return;
      ts.t += dt;
      if (ts.t < HZ.trapDelay) return;
      if (!ts.pouring) { ts.pouring = true; events.push({ type: 'sandPour', trap: ti, x: tp.x, z: tp.z }); }
      ts.level = Math.min(ts.max, ts.max * (ts.t - HZ.trapDelay) / HZ.trapFillSeconds);
      var rm = w.rooms[tp.room];
      for (var yy = rm.y; yy < rm.y + rm.h; yy++) for (var xx = rm.x; xx < rm.x + rm.w; xx++) w.sand[yy * w.W + xx] = ts.level;
      state.items.forEach(function (it) { // loot left lying in there disappears under the sand
        if (it.gone || it.holder !== null || it.flying) return;
        var c = cellAt(w, it.x, it.z);
        if (c >= 0 && w.room[c] === tp.room && it.y < w.floor[c] + ts.level - 0.15) it.gone = true;
      });
    });
  }
  // A buried goblin can struggle free: slowly by hand, much faster with a spade.
  function stepBuried(state, w, pl, inp, dt, events) {
    var R = D.death;
    pl.vx = pl.vz = 0;
    pl.sandHurt = (pl.sandHurt || 0) + 8 * dt;
    if (pl.sandHurt >= 4) { var dmg = Math.floor(pl.sandHurt); pl.sandHurt -= dmg; hurt(state, w, pl, dmg, 'sand', events); }
    if (pl.dead) return;
    var trying = Math.abs(inp.fwd) + Math.abs(inp.strafe) > 0 || inp.jump || inp.useItem;
    var spade = carried(state, pl).some(function (it) { return it.def === 'spade'; });
    if (trying) pl.digT += dt * (spade ? 3.5 : 1);
    if (pl.digT < 4) return;
    // out through the nearest doorway into the corridor
    var c = cellAt(w, pl.x, pl.z), rm = w.rooms[w.room[c]], best = null, bd = Infinity;
    for (var yy = rm.y; yy < rm.y + rm.h; yy++) {
      for (var xx = rm.x; xx < rm.x + rm.w; xx++) {
        for (var k = 0; k < 4; k++) {
          var ox = xx + DIRS[k][0], oy = yy + DIRS[k][1], oc = oy * w.W + ox;
          if (w.room[oc] === rm.id || !isFloorKind(w.kind[oc]) || w.sand[oc] > 0) continue;
          var d = Math.hypot((ox + 0.5) * w.cs - pl.x, (oy + 0.5) * w.cs - pl.z);
          if (d < bd) { bd = d; best = oc; }
        }
      }
    }
    if (best !== null) { pl.x = (best % w.W + 0.5) * w.cs; pl.z = (((best / w.W) | 0) + 0.5) * w.cs; pl.y = w.floor[best]; pl.warp++; }
    pl.buried = false; pl.digT = 0;
    events.push({ type: 'dugOut', player: pl.id, spade: spade });
  }

  // ---- the danger budget: Rangers are paid for; the Knight rides out at 3 a.m.
  // What the danger budget can buy here: the tomb's natives, then wanderers at home,
  // then wanderers far from home (fewer, dearer, and only later in the night).
  function spawnTable(w, clock) {
    var out = (w.tomb.natives || []).filter(function (n) { return !n.fromHour || clock >= n.fromHour; }), away = [];
    Object.keys(D.wanderers).forEach(function (type) {
      var wd = D.wanderers[type];
      if (wd.cost === undefined) return; // placed with the tomb, not bought (bats)
      if (wd.home.indexOf(w.tombId) >= 0) out.push({ type: type, cost: wd.cost, max: wd.maxHome });
      else if (clock >= wd.awayFrom) away.push({ type: type, cost: wd.costAway, max: wd.maxAway });
    });
    return out.concat(away);
  }
  function stepSpawner(state, w, dt, events) {
    if (state.phase !== 'night') return;
    state.spawnT -= dt;
    if (state.spawnT > 0) return;
    var om = state.omen ? D.omens.list[state.omen] : null;
    state.spawnT = om && om.spawnEvery || 1;
    var DG = D.danger, night = state.campaign.night || 1;
    var budget = (DG.base + DG.perHour * (state.clock - D.night.startHour) + (state.clock >= 24 ? DG.midnight : 0)) *
      Math.min(DG.maxPerNight, 1 + DG.perNight * (night - 1)) * (om && om.danger || 1) *
      (state.campaign.lessons && !(state.campaign.history || []).some(function (h) { return h.tomb; }) ? D.lessons.danger : 1); // the lesson night is gentler
    var table = spawnTable(w, state.clock);
    var count = {}, spent = 0;
    state.monsters.forEach(function (m) { count[m.type] = (count[m.type] || 0) + 1; });
    table.forEach(function (e) { spent += (count[e.type] || 0) * e.cost; });
    for (var ti = 0; ti < table.length; ti++) {
      var e = table[ti];
      if ((count[e.type] || 0) >= e.max + (om && om.extraMax || 0) || spent + e.cost > budget) continue;
      if (e.crewOnly && Object.keys(state.players).length < 2) continue; // the Bard needs a crew to fool
      var spot = e.type === 'hands' ? handsSpot(state, w) : e.outside ? outsideSpot(state, w, MON[e.type].radius) : e.at === 'treasure' ? treasureSpot(state, w) : e.type === 'ranger' ? rangerSpot(state, w) : mummySpot(state, w, MON[e.type].height || 0.4);
      if (!spot) continue;
      if (e.type === 'mummy') addMonster(state, 'mummy', spot.x, spot.y, spot.z, { state: 'idle', groanT: 2 + state.rng() * 5, dir: state.rng() * 6.28 });
      else if (e.type === 'onryo') addMonster(state, 'onryo', spot.x, spot.y, spot.z, { state: 'wander', wailT: 5, pauseT: 0, dir: state.rng() * 6.28 });
      else if (e.type === 'gashadokuro') addMonster(state, 'gashadokuro', spot.x, 0, spot.z, { state: 'wander', rattleT: 0, searchT: 0, heard: null, wp: null, dir: state.rng() * 6.28 });
      else if (e.type === 'myconid') addMonster(state, 'myconid', spot.x, spot.y, spot.z, { state: 'wander', puffT: 2, pauseT: 0, dir: state.rng() * 6.28 });
      else if (e.type === 'captain') addMonster(state, 'captain', spot.x, spot.y, spot.z, { state: 'wander', bellT: 4, pauseT: 0, dir: state.rng() * 6.28 });
      else if (e.type === 'crabs') addMonster(state, 'crabs', spot.x, spot.y, spot.z, { state: 'wander', carry: null, scatterT: 0, nipT: 0, hp: MON.crabs.hp, pauseT: 0, dir: 0 });
      else if (e.type === 'cube') addMonster(state, 'cube', spot.x, spot.y, spot.z, { state: 'wander', hp: MON.cube.hp, squelchT: 2 + state.rng() * 3, holding: null, pauseT: 0, dir: 0 });
      else if (e.type === 'bard') addMonster(state, 'bard', spot.x, spot.y, spot.z, { state: 'lurk', speakT: MON.bard.speakEvery[0], lute: false, fleeT: 0, pauseT: 0, dir: state.rng() * 6.28 });
      else if (e.type === 'hands') addMonster(state, 'hands', spot.x, spot.y, spot.z, { state: 'wait', holding: null, holdT: 0, squeezeT: 0, dir: 0 });
      else if (e.type === 'thief') addMonster(state, 'thief', spot.x, spot.y, spot.z, { state: 'wander', carry: null, scatterT: 0, nipT: 0, hp: MON.thief.hp, pauseT: 0, dir: 0 });
      else if (e.type === 'soldier') addMonster(state, 'soldier', spot.x, spot.y, spot.z, { state: 'still', grindT: 0, dir: Math.floor(state.rng() * 4) * Math.PI / 2 });
      else if (e.type === 'ghoul') addMonster(state, 'ghoul', spot.x, spot.y, spot.z, { state: 'wander', pauseT: 0, shriekT: 4, dir: state.rng() * 6.28 });
      else addMonster(state, 'ranger', spot.x, spot.y, spot.z, { state: 'wander', shootCd: 2, stabCd: 0, pauseT: 0, dir: state.rng() * 6.28 });
      events.push({ type: 'spawn', kind: e.type, first: !count[e.type] });
      break; // one a second
    }
    if (state.clock >= MON.giant.fromHour && !state.giantOut && !w.tomb.noOpenGround) {
      var gs = null;
      for (var ga = 0; ga < 20 && !gs; ga++) {
        var gk = knightSpot(state, w, state.rng, 20);
        if (gk && knightFree(w, gk.x, gk.z, MON.giant.radius) && goblins(state).every(function (p) { return Math.hypot(p.x - gk.x, p.z - gk.z) > 25; })) gs = gk;
      }
      state.giantOut = true; // one try a night: some tombs have no room outside for it
      if (gs) {
        addMonster(state, 'giant', gs.x, 0, gs.z, { state: 'wander', wp: null, stepT: 0, dir: state.rng() * 6.28 });
        events.push({ type: 'giantSpawn' });
      }
    }
    if (state.clock >= MON.knight.fromHour && !state.knightOut && !w.tomb.noOpenGround) {
      var far = null;
      for (var a = 0; a < 20 && !far; a++) {
        var k = knightSpot(state, w, state.rng, 20);
        if (k && goblins(state).every(function (p) { return Math.hypot(p.x - k.x, p.z - k.z) > 25; })) far = k;
      }
      if (far) {
        state.knightOut = true;
        addMonster(state, 'knight', far.x, 0, far.z, { state: 'patrol', speed: 0, hitCd: 0, overshoot: 0, snortT: 1, dir: state.rng() * 6.28 });
        events.push({ type: 'knightSpawn' });
      }
    }
  }
  function mummySpot(state, w, height) {
    var g = monsterGrid(w);
    for (var a = 0; a < 80; a++) {
      var rm = w.rooms[Math.floor(state.rng() * w.rooms.length)];
      if (rm.type === 'entrance' || rm.type === 'treasure' || rm.type === 'chasm' || rm.id === w.tunnelRoom) continue;
      var x = (rm.x + 0.5 + state.rng() * (rm.w - 1)) * w.cs, z = (rm.y + 0.5 + state.rng() * (rm.h - 1)) * w.cs, c = cellAt(w, x, z);
      if (g.block[c] || !monsterCell(w, c, height, 'inside')) continue;
      if (goblins(state).some(function (p) { return Math.hypot(p.x - x, p.z - z) < 12; })) continue;
      return { x: x, y: w.floor[c], z: z };
    }
    return null;
  }
  function rangerSpot(state, w) {
    var R = MON.ranger, g = monsterGrid(w), maxD = Math.max(1, w.rooms.reduce(function (a, r) { return Math.max(a, r.dist); }, 0));
    for (var a = 0; a < 80; a++) {
      var rm = w.rooms[Math.floor(state.rng() * w.rooms.length)];
      if (rm.type === 'entrance' || rm.type === 'chasm' || rm.id === w.tunnelRoom || rm.dist < maxD * 0.35) continue;
      var x = (rm.x + 0.5 + state.rng() * (rm.w - 1)) * w.cs, z = (rm.y + 0.5 + state.rng() * (rm.h - 1)) * w.cs, c = cellAt(w, x, z);
      if (g.block[c] || !monsterCell(w, c, R.height, 'inside')) continue;
      if (goblins(state).some(function (p) { return Math.hypot(p.x - x, p.z - z) < 16; })) continue;
      return { x: x, y: w.floor[c], z: z };
    }
    return null;
  }

  function stepMonsters(state, w, dt, events) {
    if (w.warren || state.phase === 'landing' || state.phase === 'over') return;
    stepSpawner(state, w, dt, events);
    stepJars(state, w, events);
    stepTraps(state, w, dt, events);
    function heard(e) { return e.radius > 0 && e.x !== undefined && e.monster === undefined; }
    // noises made during the monsters' own step (shrieks, cave-ins) are heard next frame
    var noises = events.filter(heard).concat(state.lateNoises || []), mark = events.length;
    stepCaveins(state, w, dt, events, noises);
    state.monsters.forEach(function (m) {
      if (m.dead) return;
      var before = events.length, ox = m.x, oz = m.z;
      stepMonster(m);
      holdBack(m, ox, oz);
      cueMonster(m, before);
    });
    // Whatever a monster just did, it can't walk aboard the Gutbucket with the gangway up.
    function holdBack(m, ox, oz) {
      if (m.x === ox && m.z === oz) return;
      if (gangwayUp(state, w) && !inShipRect(w, ox, oz) && inShipRect(w, m.x, m.z)) { m.x = ox; m.z = oz; m.moving = false; }
    }
    // A monster that comes to the Gutbucket after a goblin (or its cursed loot) and sees the gangway's up
    // gives up, and wanders off: back toward the tomb, or away across the open ground.
    function shunShip(m) {
      if (m.shunT > 0) { m.shunT -= dt; return true; }
      if (!gangwayUp(state, w) || NO_SHUN[m.type]) return false;
      var s = w.ship, gx = s.gangway.x, gz = s.z1 + 1.4, GW = D.gangway;
      if (Math.hypot(m.x - gx, m.z - gz) > GW.shunRange) return false;
      if (!(m.hunting || m.atShip || m.cursing || m.state === 'hunt' || m.state === 'search')) return false;
      if (!lineOfSight(w, m.x, m.z, gx, s.z1 + 0.3)) return false;
      m.shunT = GW.shunSeconds; m.lastSeen = null; m.spotted = false; m.searching = false; m.searchT = 0;
      m.heard = null; m.atShip = false; m.cursing = false; m.wp = null; m.state = 'wander';
      events.push({ type: 'giveUp', monster: m.id, kind: m.type, x: m.x, z: m.z });
      return true;
    }
    function walkAway(m) {
      var spec = MON[m.type], s = w.ship;
      m.moving = false; m.state = 'wander';
      if (m.type === 'giant' || m.type === 'gashadokuro') { // out on the open ground: straight away from the ship
        var a = Math.atan2(m.x - s.x, m.z - s.z);
        outsideStep(w, m, m.x + Math.sin(a) * 10, m.z + Math.cos(a) * 10, spec.speed, spec.radius, dt);
        return;
      }
      setGoal(w, m, w.entrance.x, w.entrance.z, spec.height || 1, m.mode || 'any'); // back to the tomb
      walkToGoal(w, m, spec.wanderSpeed || spec.speed * 0.6 || 1.2, dt);
    }
    // Warning sounds, the same for every monster: when it starts hunting, and when it's about to reach you.
    function cueMonster(m, before) {
      var CU = D.cues, was = !!m.hunting;
      m.hunting = !m.dead && (!!m.spotted || !!m.cursing || m.state === 'hunt' || m.state === 'charge' || m.state === 'swirl');
      if (m.hunting && !was && CU.noAlert.indexOf(m.type) < 0
        && !events.slice(before).some(function (e) { return e.monster === m.id && e.type === 'spotted'; })) {
        events.push({ type: 'alert', monster: m.id, kind: m.type, x: m.x, z: m.z });
      }
      var R = CU.closeRange[m.type];
      m.warnT = Math.max(0, (m.warnT || 0) - dt);
      if (!R || !m.hunting || m.warnT > 0) return;
      var near = nearestGoblin(state, m.x, m.z);
      if (near && Math.hypot(near.x - m.x, near.z - m.z) < R && Math.abs(near.y - m.y) < 2) {
        m.warnT = CU.closeEvery;
        events.push({ type: 'closing', monster: m.id, kind: m.type, player: near.id, x: m.x, z: m.z });
      }
    }
    function stepMonster(m) {
      m.stunT = Math.max(0, m.stunT - dt); m.blindT = Math.max(0, m.blindT - dt); m.cd = Math.max(0, m.cd - dt);
      if (shunShip(m)) { walkAway(m); return; }
      if (m.type === 'mimic') stepMimic(state, w, m, dt, events);
      else if (m.type === 'ranger') stepRanger(state, w, m, dt, events, noises);
      else if (m.type === 'knight') stepKnight(state, w, m, dt, events);
      else if (m.type === 'mummy') stepMummy(state, w, m, dt, events, MON.mummy, false);
      else if (m.type === 'pharaoh') stepPharaoh(state, w, m, dt, events);
      else if (m.type === 'scarabs') stepScarabs(state, w, m, dt, events);
      else if (m.type === 'jackal') stepJackal(state, w, m, dt, events);
      else if (m.type === 'cube') stepCube(state, w, m, dt, events, noises);
      else if (m.type === 'bats') stepBats(state, w, m, dt, events, noises);
      else if (m.type === 'captain') stepCaptain(state, w, m, dt, events);
      else if (m.type === 'myconid') stepMyconid(state, w, m, dt, events);
      else if (m.type === 'chochin') stepChochin(state, w, m, dt, events);
      else if (m.type === 'onryo') stepOnryo(state, w, m, dt, events);
      else if (m.type === 'gashadokuro') stepGashadokuro(state, w, m, dt, events, noises);
      else if (m.type === 'crabs' || m.type === 'thief') stepCrabs(state, w, m, dt, events); // the Bone-Thief keeps the crabs' rule
      else if (m.type === 'hands') stepHands(state, w, m, dt, events);
      else if (m.type === 'bard') stepBard(state, w, m, dt, events);
      else if (m.type === 'ghoul') stepGhoul(state, w, m, dt, events);
      else if (m.type === 'soldier') stepSoldier(state, w, m, dt, events);
      else if (m.type === 'giant') stepGiant(state, w, m, dt, events);
    }
    state.lateNoises = events.slice(mark).filter(heard);
  }

  // ---- Yomi Shrine: the watching lanterns, the Onryo, the Gashadokuro

  // A Chochin-obake hangs still and looks about. If it sees you, it shrieks, and the Onryo
  // (and anything else in earshot) comes to where you were.
  function stepChochin(state, w, m, dt, events) {
    var CH = MON.chochin;
    if (m.blindT > 0) return;
    m.dir += m.sweep * CH.turnSpeed * dt; // a slow look round
    var turn = Math.sin(state.t * 0.23 + m.id) > 0.97;
    if (turn && !m.turning) m.sweep = -m.sweep;
    m.turning = turn;
    var seen = null;
    goblins(state).forEach(function (p) { if (!seen && canSee(state, w, m, p, CH.sight)) seen = p; });
    if (!seen || m.cd > 0) { m.state = seen ? 'glare' : 'watch'; return; }
    m.state = 'glare'; m.cd = CH.cooldown;
    m.dir = Math.atan2(seen.x - m.x, seen.z - m.z);
    events.push({ type: 'lanternShriek', loud: CH.shriekLoud, radius: CH.shriekLoud * D.noise.baseRadius * 1.4, x: m.x, z: m.z, player: seen.id });
    events.push({ type: 'spotted', monster: m.id, kind: 'chochin', player: seen.id, x: m.x, z: m.z });
    state.monsters.forEach(function (o) { // she knows where you were
      if (o.type !== 'onryo' || o.dead) return;
      o.lastSeen = { x: seen.x, z: seen.z }; o.searching = false; o.searchT = 0; o.spotted = true;
    });
  }

  // The Onryo walks the shrine. She hunts by sight: quicker than a walking goblin, slower
  // than a sprinting one, and she searches a long time where she lost you.
  // A step across open ground for a big outside monster, sliding round props and the ship.
  function outsideStep(w, m, tx, tz, speed, radius, dt) {
    var want = Math.atan2(tx - m.x, tz - m.z), moved = false;
    [0, 0.7, -0.7, 1.4, -1.4].some(function (off) {
      var a = want + off, nx = m.x + Math.sin(a) * speed * dt, nz = m.z + Math.cos(a) * speed * dt;
      if (!knightFree(w, nx, nz, radius)) return false;
      m.x = nx; m.z = nz; m.dir = turnToward(m.dir, a, 2.5 * dt); moved = true; return true;
    });
    m.moving = moved;
    return moved;
  }
  // A goblin looking at a Terracotta Soldier: facing it, in line of sight, and near enough to make it out
  // (within its own light, or close by in the dark).
  function watching(state, w, p, m) {
    var SW = MON.soldier.watch, dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz);
    if (p.dead || Math.abs(m.y - p.y) > 3 || d > (lit(state, p, w) ? SW.lit : SW.dark)) return false;
    if (d > 0.6) {
      var fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      if ((dx * fx + dz * fz) / d < Math.cos(SW.fov * Math.PI / 360)) return false;
    }
    return lineOfSight(w, p.x, p.z, m.x, m.z);
  }
  // The Terracotta Soldier: a statue while anyone's looking at it. Otherwise it comes for the nearest
  // goblin it can sense, grinding as it goes, and strikes.
  function stepSoldier(state, w, m, dt, events) {
    var SO = MON.soldier;
    m.moving = false;
    m.watched = m.blindT > 0 || state.phase !== 'night' || goblins(state).some(function (p) { return watching(state, w, p, m); });
    if (m.watched) { if (m.state === 'hunt') m.state = 'frozen'; return; }
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (!near || nd > SO.senseRange || Math.abs(near.y - m.y) > 4) { m.state = 'still'; return; }
    if (nd < SO.hitRange && m.cd <= 0) {
      m.cd = SO.hitCooldown;
      m.dir = Math.atan2(near.x - m.x, near.z - m.z);
      events.push({ type: 'soldierStrike', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, near, SO.hit, 'soldier', events);
      return;
    }
    m.state = 'hunt';
    setGoal(w, m, near.x, near.z, SO.height, 'any');
    walkToGoal(w, m, SO.speed, dt);
    m.dir = Math.atan2(near.x - m.x, near.z - m.z); // always facing you when you turn round
    if (m.moving) { m.grindT -= dt; if (m.grindT <= 0) { m.grindT = SO.grindEvery; events.push({ type: 'soldierGrind', monster: m.id, x: m.x, z: m.z }); } }
  }
  // The Ghoul: a sight hunter that runs. Faster than a walk, slower than a sprint.
  function stepGhoul(state, w, m, dt, events) {
    var GH = MON.ghoul;
    m.moving = false;
    m.shriekT -= dt;
    if (m.shriekT <= 0) { m.shriekT = GH.shriekEvery[0] + m.rng() * (GH.shriekEvery[1] - GH.shriekEvery[0]); events.push({ type: 'ghoulShriek', monster: m.id, x: m.x, z: m.z }); }
    if (m.blindT > 0 || m.stunT > 0) return;
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (near && nd < GH.hitRange && Math.abs(near.y - m.y) < 1.5 && m.cd <= 0) {
      m.cd = GH.hitCooldown;
      events.push({ type: 'ghoulBite', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, near, GH.hit, 'ghoul', events);
      return;
    }
    var tr = trackBySight(state, w, m, GH.sight, dt, events);
    if (tr) {
      m.state = tr.what === 'goblin' ? 'hunt' : 'search';
      if (tr.what === 'search') return;
      setGoal(w, m, tr.x, tr.z, GH.height, 'any');
      if (walkToGoal(w, m, GH.speed, dt) && tr.what === 'lastSeen') m.searching = true;
      return;
    }
    m.state = 'wander';
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    if (!m.flow || walkToGoal(w, m, GH.wanderSpeed, dt)) {
      var rm = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      setGoal(w, m, (rm.cx + 0.5) * w.cs, (rm.cy + 0.5) * w.cs, GH.height, 'inside');
      m.pauseT = m.rng() < 0.5 ? 1 + m.rng() * 3 : 0;
    }
  }
  // The Giant: out on the open ground, looking for goblins that aren't inside or aboard. If it reaches
  // one, it picks it up. Its footsteps shake the ground for a long way.
  function stepGiant(state, w, m, dt, events) {
    var G = MON.giant;
    m.moving = false;
    if (m.cd <= 0) goblins(state).forEach(function (p) {
      if (m.cd > 0 || p.inside || p.onDeck || Math.abs(p.y - m.y) > 3 || Math.hypot(p.x - m.x, p.z - m.z) > G.grabRange) return;
      m.cd = 3;
      events.push({ type: 'giantGrab', monster: m.id, player: p.id, x: m.x, z: m.z });
      hurt(state, w, p, p.hp, 'giant', events);
    });
    if (m.blindT > 0) return;
    var tr = trackBySight(state, w, m, G.sight, dt, events), tx, tz, speed = G.speed;
    if (tr && tr.what === 'search') { m.state = 'search'; m.dir += dt * 0.7; return; }
    if (tr) { m.state = 'hunt'; tx = tr.x; tz = tr.z; speed = G.huntSpeed; }
    else {
      m.state = 'wander';
      if (!m.wp || Math.hypot(m.wp.x - m.x, m.wp.z - m.z) < 3) m.wp = knightSpot(state, w, m.rng, 10);
      if (!m.wp) return;
      tx = m.wp.x; tz = m.wp.z;
    }
    if (!outsideStep(w, m, tx, tz, speed, G.radius, dt)) { m.wp = null; if (tr && tr.what === 'lastSeen') m.searching = true; } // can't get closer: look about instead
    if (m.moving) {
      m.stepT -= dt;
      if (m.stepT <= 0) { m.stepT = G.stepEvery * (m.state === 'hunt' ? 0.6 : 1); events.push({ type: 'giantStep', monster: m.id, x: m.x, z: m.z, loud: G.stepLoud }); }
    }
  }

  function stepOnryo(state, w, m, dt, events) {
    var ON = MON.onryo;
    m.moving = false;
    m.wailT -= dt;
    if (m.wailT <= 0) { m.wailT = ON.wailEvery[0] + m.rng() * (ON.wailEvery[1] - ON.wailEvery[0]); events.push({ type: 'onryoWail', monster: m.id, x: m.x, z: m.z }); }
    if (m.blindT > 0) return;
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (near && nd < ON.touchRange && Math.abs(near.y - m.y) < 1.5 && m.cd <= 0) {
      m.cd = ON.touchCooldown;
      events.push({ type: 'onryoTouch', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, near, ON.touch, 'onryo', events);
      return;
    }
    var tr = trackBySight(state, w, m, ON.sight, dt, events);
    if (tr) {
      m.state = tr.what === 'goblin' ? 'hunt' : 'search';
      if (tr.what === 'search') return;
      setGoal(w, m, tr.x, tr.z, ON.height, 'any');
      if (walkToGoal(w, m, ON.speed, dt) && tr.what === 'lastSeen') m.searching = true;
      return;
    }
    m.state = 'wander';
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    if (!m.flow || walkToGoal(w, m, ON.wanderSpeed, dt)) {
      var rm = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      setGoal(w, m, (rm.cx + 0.5) * w.cs, (rm.cy + 0.5) * w.cs, ON.height, 'inside');
      m.pauseT = m.rng() < 0.5 ? 2 + m.rng() * 4 : 0;
    }
  }

  // The Gashadokuro stalks the bamboo from 1 a.m. It hunts by sound and can't fit indoors.
  function outsideSpot(state, w, rad) {
    for (var a = 0; a < 30; a++) {
      var k = knightSpot(state, w, state.rng, 20);
      if (k && knightFree(w, k.x, k.z, rad || MON.knight.radius) && goblins(state).every(function (p) { return Math.hypot(p.x - k.x, p.z - k.z) > 25; })) return { x: k.x, y: 0, z: k.z };
    }
    return null;
  }
  function stepGashadokuro(state, w, m, dt, events, noises) {
    var G = MON.gashadokuro;
    m.moving = false; m.cd = Math.max(0, m.cd);
    noises.forEach(function (e) {
      var c = cellAt(w, e.x, e.z);
      if (c < 0 || w.kind[c] !== OUTSIDE) return; // it hears what's out in the open
      if (Math.hypot(e.x - m.x, e.z - m.z) <= e.radius * G.hearing) { m.heard = { x: e.x, z: e.z }; m.state = 'hunt'; m.searchT = 0; }
    });
    goblins(state).forEach(function (p) {
      if (p.inside || p.onDeck || m.cd > 0 || Math.hypot(p.x - m.x, p.z - m.z) > G.hitRange) return;
      m.cd = G.hitCooldown;
      events.push({ type: 'gashaHit', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, p, G.hit, 'gashadokuro', events);
    });
    if (m.blindT > 0) return;
    var tx, tz, speed = G.speed;
    if (m.state === 'hunt' && m.heard) {
      tx = m.heard.x; tz = m.heard.z; speed = G.huntSpeed;
      if (Math.hypot(tx - m.x, tz - m.z) < 2.5) { m.state = 'search'; m.searchT = 0; }
    } else if (m.state === 'search') {
      m.searchT += dt; m.dir += dt * 0.8;
      if (m.searchT > G.searchSeconds) { m.state = 'wander'; m.heard = null; }
      return;
    } else {
      if (!m.wp || Math.hypot(m.wp.x - m.x, m.wp.z - m.z) < 3) m.wp = knightSpot(state, w, m.rng, 8);
      if (!m.wp) return;
      tx = m.wp.x; tz = m.wp.z;
    }
    var want = Math.atan2(tx - m.x, tz - m.z), moved = false;
    [0, 0.7, -0.7, 1.4, -1.4].some(function (off) {
      var a = want + off, nx = m.x + Math.sin(a) * speed * dt, nz = m.z + Math.cos(a) * speed * dt;
      if (!knightFree(w, nx, nz, G.radius)) return false;
      m.x = nx; m.z = nz; m.dir = turnToward(m.dir, a, 3 * dt); moved = true; return true;
    });
    if (!moved) { m.wp = null; if (m.state === 'hunt') { m.state = 'search'; m.searchT = 0; } } // blocked (the hull): search here
    m.moving = moved;
    if (moved) { m.rattleT -= dt; if (m.rattleT <= 0) { m.rattleT = G.rattleEvery; events.push({ type: 'rattle', monster: m.id, x: m.x, z: m.z }); } }
  }

  // ---- Mushroom Warren: glowcaps, spore clouds, Spore Phantoms, the Myconid

  function addCloud(state, x, y, z, r, seconds, events, source) {
    state.clouds.push({ x: x, y: y, z: z, r: r, t: seconds, life: seconds });
    events.push({ type: 'puff', source: source, x: x, z: z });
  }
  function stepCaves(state, w, dt, events) {
    var HZ = w.tomb.hazards;
    if (!HZ || !HZ.glowcaps || state.phase === 'landing') return;
    // glowcaps flare when trodden on: light and a soft chime the whole cave can hear
    w.glowcaps.forEach(function (g, i) {
      var gs = state.glow[i];
      gs.cd = Math.max(0, gs.cd - dt);
      if (gs.cd > 0) return;
      goblins(state).forEach(function (p) {
        if (gs.cd > 0 || !p.grounded || Math.abs(p.y - g.y) > 0.5 || Math.hypot(p.x - g.x, p.z - g.z) > 0.55) return;
        gs.cd = HZ.glowCooldown;
        events.push({ type: 'glowPulse', glow: i, player: p.id, loud: HZ.glowPulseLoud, radius: HZ.glowPulseLoud * D.noise.baseRadius, x: g.x, z: g.z });
      });
    });
    // puffballs: every so often, and at once if stepped on
    w.puffballs.forEach(function (pb, i) {
      var ps = state.puffs[i];
      ps.t -= dt;
      var trod = goblins(state).some(function (p) { return p.grounded && Math.abs(p.y - pb.y) < 0.5 && Math.hypot(p.x - pb.x, p.z - pb.z) < 0.6; });
      if (ps.t > 0 && !(trod && ps.t < HZ.puffEvery[0] - 2)) return;
      ps.t = HZ.puffEvery[0] + (hashString(state.t + ':' + i) % 1000) / 1000 * (HZ.puffEvery[1] - HZ.puffEvery[0]);
      addCloud(state, pb.x, pb.y, pb.z, HZ.cloudRadius, HZ.cloudSeconds, events, 'puffball');
    });
    state.clouds = state.clouds.filter(function (c) { c.t -= dt; return c.t > 0; });
    // breathing it in: crouching holds your breath
    goblins(state).forEach(function (p) {
      var inCloud = state.clouds.some(function (c) { return Math.abs(p.y - c.y) < 2 && Math.hypot(p.x - c.x, p.z - c.z) < c.r * Math.min(1, c.t / 1.5 + 0.3); });
      p.holdingBreath = inCloud && p.crouching;
      if (inCloud && !p.crouching) {
        if (p.spored <= 0) { p.phantomT = 2; events.push({ type: 'spored', player: p.id }); }
        p.spored = HZ.sporeSeconds;
      }
    });
    for (var pid in state.players) {
      var pl = state.players[pid];
      if (pl.spored > 0) { pl.spored = Math.max(0, pl.spored - dt); if (pl.spored === 0) events.push({ type: 'sporesWearOff', player: pl.id }); }
      stepPhantoms(state, w, pl, dt, events);
    }
  }

  // Spore Phantoms: seen only by a goblin who breathed spores. They look like real monsters and
  // walk straight at you, but they're silent, harmless, and gone when they get close.
  function stepPhantoms(state, w, pl, dt, events) {
    var PH = MON.phantoms, mine = state.phantoms.filter(function (f) { return f.player === pl.id; });
    mine.forEach(function (f) {
      f.t -= dt;
      var dx = pl.x - f.x, dz = pl.z - f.z, d = Math.hypot(dx, dz);
      if (f.t <= 0 || d < PH.vanishRange || pl.spored <= 0 || pl.dead) {
        f.gone = true;
        events.push({ type: 'phantomGone', player: pl.id, phantom: f.id, close: d < PH.vanishRange });
        return;
      }
      f.dir = Math.atan2(dx, dz); f.moving = true;
      var nx = f.x + dx / d * PH.speed * dt, nz = f.z + dz / d * PH.speed * dt, c = cellAt(w, nx, nz);
      if (c >= 0 && isFloorKind(w.kind[c])) { f.x = nx; f.z = nz; f.y += (floorAt(w, c, nx, nz) - f.y) * Math.min(1, 8 * dt); }
    });
    state.phantoms = state.phantoms.filter(function (f) { return !f.gone; });
    if (pl.spored <= 0 || pl.dead) return;
    pl.phantomT -= dt;
    if (pl.phantomT > 0 || mine.filter(function (f) { return !f.gone; }).length >= PH.max) return;
    var r = makeRng(state.seedBase + ':phantom:' + state.phantomId);
    pl.phantomT = PH.every[0] + r() * (PH.every[1] - PH.every[0]);
    // somewhere down a line of sight, a little way off
    for (var a = 0; a < 12; a++) {
      var ang = r() * Math.PI * 2, want = PH.from + r() * (PH.near - PH.from), x = pl.x, z = pl.z, ok = 0;
      for (var dd = 0.5; dd <= want; dd += 0.5) {
        var cx = pl.x + Math.sin(ang) * dd, cz = pl.z + Math.cos(ang) * dd, c2 = cellAt(w, cx, cz);
        if (c2 < 0 || !isFloorKind(w.kind[c2]) || Math.abs(w.floor[c2] - pl.y) > 1) break;
        x = cx; z = cz; ok = dd;
      }
      if (ok < PH.from - 1) continue;
      var f2 = { id: state.phantomId++, player: pl.id, kind: PH.kinds[Math.floor(r() * PH.kinds.length)], x: x, y: w.floor[cellAt(w, x, z)], z: z, dir: 0, t: PH.life, moving: false };
      state.phantoms.push(f2);
      events.push({ type: 'phantom', player: pl.id, phantom: f2.id, kind: f2.kind });
      return;
    }
  }

  // The Myconid: a big walking mushroom. It hunts by sight, and while it hunts it puffs spores
  // ahead of it. Lose it behind a cap, or dazzle it with flash-powder.
  function stepMyconid(state, w, m, dt, events) {
    var MY = MON.myconid, HZ = w.tomb.hazards;
    m.moving = false;
    if (m.blindT > 0) return;
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (near && nd < MY.hitRange && Math.abs(near.y - m.y) < 1.5 && m.cd <= 0) {
      m.cd = MY.hitCooldown;
      events.push({ type: 'myconidHit', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, near, MY.hit, 'myconid', events);
      return;
    }
    var tr = trackBySight(state, w, m, MY.sight, dt, events);
    if (tr) {
      m.state = tr.what === 'goblin' ? 'hunt' : 'search';
      if (tr.what === 'goblin' && HZ) {
        m.puffT -= dt;
        if (m.puffT <= 0) { // a cloud of spores, a couple of meters ahead of it
          m.puffT = MY.puffEvery;
          var px = m.x + Math.sin(m.dir) * 2, pz = m.z + Math.cos(m.dir) * 2, pc = cellAt(w, px, pz);
          if (pc < 0 || !isFloorKind(w.kind[pc])) { px = m.x; pz = m.z; }
          addCloud(state, px, m.y, pz, HZ.cloudRadius * 1.2, HZ.cloudSeconds, events, 'myconid');
        }
      }
      if (tr.what === 'search') return;
      setGoal(w, m, tr.x, tr.z, MY.height, 'any');
      if (walkToGoal(w, m, MY.speed, dt) && tr.what === 'lastSeen') m.searching = true;
      return;
    }
    m.state = 'wander';
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    if (!m.flow || walkToGoal(w, m, MY.speed * 0.6, dt)) {
      var rm = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      setGoal(w, m, (rm.cx + 0.5) * w.cs, (rm.cy + 0.5) * w.cs, MY.height, 'inside');
      m.pauseT = m.rng() < 0.6 ? 3 + m.rng() * 4 : 0;
    }
  }

  // ---- Sunken Galleon: the tide, the Drowned Captain, the Crab Gang

  // The sea comes back in over the night. Loot left lying under it is gone for good.
  function stepTide(state, w, dt, events) {
    var TD = w.tomb.tide;
    if (!TD || state.phase === 'landing') return;
    var pace = state.omen && D.omens.list[state.omen] && D.omens.list[state.omen].floodPace || 1;
    w.tide = tideAt(TD, state.clock, pace);
    if (TD.steps) { // the sunken cathedral's bell: a warning before every rise
      var rung = state.floodBells || 0;
      while (rung < TD.steps && state.clock >= TD.firstHour + rung * TD.every * pace - TD.warnHours) { rung++; events.push({ type: 'floodBell', step: rung, of: TD.steps }); }
      state.floodBells = rung;
    } else {
      var deepest = w.rooms.reduce(function (mn, rm) { return Math.min(mn, rm.level); }, 0);
      if (!state.tideWarned && w.tide > deepest + 0.3) { state.tideWarned = true; events.push({ type: 'tideRising', level: w.tide }); }
    }
    state.items.forEach(function (it) {
      if (it.gone || it.holder !== null || it.flying || it.inCube != null) return;
      var c = cellAt(w, it.x, it.z);
      if (c < 0 || (w.kind[c] !== INSIDE && !w.tomb.pit) || it.y > w.tide - 0.25) return;
      it.gone = true; it.drowned = true;
      state.monsters.forEach(function (m) { if (m.carry === it.id) m.carry = null; });
      events.push({ type: 'itemDrowned', item: it.id, def: it.def, x: it.x, z: it.z });
    });
  }
  function treasureSpot(state, w) {
    var rm = w.rooms[w.treasureRoom], g = monsterGrid(w);
    for (var yy = rm.y; yy < rm.y + rm.h; yy++) for (var xx = rm.x; xx < rm.x + rm.w; xx++) {
      var c = yy * w.W + xx;
      if (!g.block[c] && monsterCell(w, c, 1.9, 'inside')) return { x: (xx + 0.5) * w.cs, y: w.floor[c], z: (yy + 0.5) * w.cs };
    }
    return mummySpot(state, w, 1.9);
  }

  // The Drowned Captain: slow and relentless. He walks the decks, rings a drowned bell now and
  // then, hunts by sight, searches long when he loses you, and follows you anywhere, the beach included.
  function stepCaptain(state, w, m, dt, events) {
    var CP = MON.captain;
    m.moving = false;
    m.bellT -= dt;
    if (m.bellT <= 0) { m.bellT = CP.bellEvery[0] + m.rng() * (CP.bellEvery[1] - CP.bellEvery[0]); events.push({ type: 'captainBell', monster: m.id, x: m.x, z: m.z }); }
    if (m.blindT > 0) return;
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (near && nd < CP.hitRange && Math.abs(near.y - m.y) < 1.5 && m.cd <= 0) {
      m.cd = CP.hitCooldown;
      events.push({ type: 'captainHit', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, near, CP.hit, 'captain', events);
      return;
    }
    var tr = trackBySight(state, w, m, CP.sight, dt, events);
    if (tr) {
      m.state = tr.what === 'goblin' ? 'hunt' : 'search';
      if (tr.what === 'search') return;
      setGoal(w, m, tr.x, tr.z, CP.height, 'any');
      if (walkToGoal(w, m, CP.speed, dt) && tr.what === 'lastSeen') m.searching = true;
      return;
    }
    m.state = 'wander'; // pacing his ship
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    if (!m.flow || walkToGoal(w, m, CP.speed * 0.7, dt)) {
      var rm = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      setGoal(w, m, (rm.cx + 0.5) * w.cs, (rm.cy + 0.5) * w.cs, CP.height, 'inside');
      m.pauseT = m.rng() < 0.5 ? 2 + m.rng() * 3 : 0;
    }
  }

  // The Crab Gang: finds loot left lying about, grabs it and scuttles off to drop it in the
  // water. Get close and they let go and scatter. They nip anyone standing among them.
  function crabsDrop(state, w, m, events) {
    if (m.carry === null || m.carry === undefined) return;
    var it = state.items[m.carry];
    m.carry = null;
    if (!it || it.gone || it.holder !== null) return;
    var c = cellAt(w, m.x, m.z);
    it.x = m.x; it.z = m.z; it.y = c >= 0 ? floorAt(w, c, m.x, m.z) : m.y; it.crabbed = null;
    events.push({ type: 'crabsDrop', monster: m.id, item: it.id, x: m.x, z: m.z });
  }
  // The nearest spot the sea has reached (or, before it has, the lowest spot it can find).
  // The Bard: lurks, plucks its lute, then speaks in the voice of a fallen goblin who lent it (bardOk), to
  // draw the living close. The clip itself is the clients' business (each keeps a few of every crewmate
  // who opted in); the sim only says whose voice and where. Close enough, it strikes and slips away.
  function stepBard(state, w, m, dt, events) {
    var BA = MON.bard;
    m.moving = false;
    if (m.blindT > 0) return;
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (near && nd < BA.strikeRange && Math.abs(near.y - m.y) < 1.5 && m.cd <= 0 && !(m.fleeT > 0)) {
      m.cd = BA.hitCooldown; m.fleeT = BA.fleeSeconds;
      m.dir = Math.atan2(near.x - m.x, near.z - m.z);
      events.push({ type: 'bardStrike', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, near, BA.hit, 'bard', events);
      // somewhere else to lurk, away from the goblin it hit
      var away = w.rooms.filter(function (rm) { return Math.hypot((rm.cx + 0.5) * w.cs - near.x, (rm.cy + 0.5) * w.cs - near.z) > 14; });
      var to = away.length ? away[Math.floor(m.rng() * away.length)] : w.rooms[0];
      setGoal(w, m, (to.cx + 0.5) * w.cs, (to.cy + 0.5) * w.cs, BA.height, 'inside');
      return;
    }
    if (m.fleeT > 0) { m.fleeT -= dt; m.state = 'flee'; walkToGoal(w, m, BA.speed, dt); return; }
    // the performance: a note on the lute, then a borrowed voice
    m.speakT -= dt;
    if (!m.lute && m.speakT <= BA.luteLead) { m.lute = true; events.push({ type: 'bardLute', monster: m.id, x: m.x, z: m.z }); }
    if (m.speakT <= 0) {
      m.speakT = BA.speakEvery[0] + m.rng() * (BA.speakEvery[1] - BA.speakEvery[0]); m.lute = false;
      var voices = Object.keys(state.players).filter(function (id) { var p = state.players[id]; return p.dead && p.bardOk; }).sort();
      if (voices.length) {
        m.state = 'speak';
        events.push({ type: 'bardSpeak', monster: m.id, voice: voices[Math.floor(m.rng() * voices.length)], clip: Math.floor(m.rng() * 1000), x: m.x, z: m.z });
      }
      return;
    }
    // otherwise it drifts about the rooms, taking its time
    m.state = 'lurk';
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    if (!m.flow || walkToGoal(w, m, BA.wanderSpeed, dt)) {
      var rm2 = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      setGoal(w, m, (rm2.cx + 0.5) * w.cs, (rm2.cy + 0.5) * w.cs, BA.height, 'inside');
      m.pauseT = 3 + m.rng() * 6;
    }
  }
  // Somewhere the flood is deep enough for the Drowned Hands, away from the crew.
  function handsSpot(state, w) {
    for (var a = 0; a < 300; a++) {
      var c = Math.floor(state.rng() * w.W * w.H);
      if (!isFloorKind(w.kind[c]) || w.tide - w.floor[c] < MON.hands.minDepth + 0.25) continue;
      var x = (c % w.W + 0.5) * w.cs, z = (((c / w.W) | 0) + 0.5) * w.cs;
      if (goblins(state).some(function (p) { return Math.hypot(p.x - x, p.z - z) < 6; })) continue;
      return { x: x, y: w.floor[c], z: z };
    }
    return null;
  }
  // The Drowned Hands: they drift under the water toward a goblin wading nearby, grip it fast and
  // squeeze for a few seconds, then sink back. They can't leave water deep enough to hide them.
  function stepHands(state, w, m, dt, events) {
    var HA = MON.hands;
    m.moving = false;
    var c = cellAt(w, m.x, m.z);
    m.sunk = c < 0 || w.tide - w.floor[c] < HA.minDepth;
    if (m.holding !== null && m.holding !== undefined) {
      var p = state.players[m.holding];
      if (!p || p.dead || p.heldBy !== m.id) m.holding = null;
      else {
        m.holdT -= dt; m.squeezeT -= dt;
        if (m.squeezeT <= 0) { m.squeezeT = 0.5; hurt(state, w, p, HA.squeeze * 0.5, 'hands', events); }
        if (m.holdT <= 0 || p.dead) { p.heldBy = null; m.holding = null; m.cd = HA.cooldown; events.push({ type: 'handsLetGo', monster: m.id, player: p.id, x: m.x, z: m.z }); }
        return;
      }
    }
    m.state = m.sunk ? 'sunk' : 'wait';
    if (m.sunk || m.blindT > 0) return;
    var best = null, bd = HA.senseRange; // the nearest goblin wading close by
    goblins(state).forEach(function (p2) {
      if (p2.onDeck || p2.y > w.tide - 0.15 || (p2.heldBy !== null && p2.heldBy !== undefined)) return;
      var d = Math.hypot(p2.x - m.x, p2.z - m.z);
      if (d < bd && Math.abs(p2.y - m.y) < 2) { bd = d; best = p2; }
    });
    if (!best) return;
    m.state = 'reach';
    if (bd < HA.grabRange && m.cd <= 0) {
      m.holding = best.id; m.holdT = HA.holdSeconds; m.squeezeT = 0.3; best.heldBy = m.id;
      events.push({ type: 'handsGrab', monster: m.id, player: best.id, x: m.x, z: m.z });
      return;
    }
    var ox = m.x, oz = m.z;
    setGoal(w, m, best.x, best.z, HA.height, 'any');
    walkToGoal(w, m, HA.speed, dt);
    var nc = cellAt(w, m.x, m.z);
    if (nc < 0 || w.tide - w.floor[nc] < HA.minDepth) { m.x = ox; m.z = oz; m.moving = false; } // not out of the water
  }
  // Where the Bone-Thief takes what it steals: into the flood if there is one, else off to a far room.
  function thiefSpot(state, w, m) {
    var ws = waterSpot(w, m);
    if (w.floor[ws] < w.tide - 0.1) return ws;
    var far = w.rooms.filter(function (rm) { return rm.type !== 'entrance' && Math.hypot((rm.cx + 0.5) * w.cs - m.x, (rm.cy + 0.5) * w.cs - m.z) > 12; });
    for (var tries = 0; tries < 6 && far.length; tries++) { // one it can get to (not behind a shut rune door)
      var rm = far.splice(Math.floor(m.rng() * far.length), 1)[0], goal = rm.cy * w.W + rm.cx;
      if (flowField(w, goal, 0.3, 'inside')[cellAt(w, m.x, m.z)] > 0) return goal;
    }
    return ws;
  }
  function waterSpot(w, m) {
    var g = monsterGrid(w), start = cellAt(w, m.x, m.z), seen = new Uint8Array(g.N), q = [start], low = start;
    seen[start] = 1;
    for (var i = 0; i < q.length; i++) {
      var c = q[i];
      if (w.floor[c] < w.tide - 0.1) return c;
      if (w.floor[c] < w.floor[low]) low = c;
      var cx = c % w.W, cy = (c / w.W) | 0;
      for (var k = 0; k < 4; k++) {
        var n = (cy + DIRS[k][1]) * w.W + cx + DIRS[k][0];
        if (seen[n] || !monsterCell(w, n, 0.3, 'inside') || !monsterEdge(w, g, c, n)) continue;
        seen[n] = 1; q.push(n);
      }
    }
    return low;
  }
  function stepCrabs(state, w, m, dt, events) {
    var CR = MON[m.type];
    m.moving = false;
    m.nipT -= dt;
    var near = nearestGoblin(state, m.x, m.z), nd = near ? Math.hypot(near.x - m.x, near.z - m.z) : Infinity;
    if (CR.nip > 0 && near && nd < 0.7 && Math.abs(near.y - m.y) < 1 && m.nipT <= 0) {
      m.nipT = CR.nipEvery;
      events.push({ type: 'nip', monster: m.id, x: m.x, z: m.z });
      hurt(state, w, near, CR.nip, 'crabs', events);
    }
    if (m.scatterT > 0) { // scuttling off, away from the goblin
      m.scatterT -= dt;
      if (near && nd > 0.01) {
        var ax = m.x + (m.x - near.x) / nd * CR.speed * dt, az = m.z + (m.z - near.z) / nd * CR.speed * dt, ac = cellAt(w, ax, az);
        if (ac >= 0 && w.kind[ac] === INSIDE && Math.abs(w.floor[ac] - m.y) < 0.6) { m.x = ax; m.z = az; m.moving = true; }
      }
      return;
    }
    if (m.carry !== null) {
      var it = state.items[m.carry];
      if (!it || it.gone || it.holder !== null) { m.carry = null; return; }
      if (near && nd < CR.scareRange) { crabsDrop(state, w, m, events); m.scatterT = CR.scatterSeconds; events.push({ type: 'crabsScatter', monster: m.id, x: m.x, z: m.z }); return; }
      var there = walkToGoal(w, m, CR.carrySpeed, dt);
      it.x = m.x; it.z = m.z; it.y = m.y + 0.12;
      if (there) { crabsDrop(state, w, m, events); m.pauseT = 3; }
      return;
    }
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    // loot lying about, not in a shut chest, not aboard the Gutbucket, not too big to carry
    var best = null, bd = CR.senseRange;
    state.items.forEach(function (it2) {
      if (!it2.handled || it2.gone || it2.holder !== null || it2.flying || it2.inCube != null || it2.inCart || it2.tool) return;
      if (it2.chest >= 0 && !state.chests[it2.chest].open) return;
      if (D.items[it2.def].weight === 'twoHanded' || Math.abs(it2.y - m.y) > 1.5 || onDeckXZ(w, it2.x, it2.z)) return;
      if (w.kind[cellAt(w, it2.x, it2.z)] !== INSIDE || it2.y < w.tide) return;
      var d = Math.hypot(it2.x - m.x, it2.z - m.z);
      if (d < bd) { bd = d; best = it2; }
    });
    if (best) {
      if (bd < CR.grabRange) {
        m.carry = best.id; best.chest = -1;
        var wc2 = m.type === 'thief' ? thiefSpot(state, w, m) : waterSpot(w, m);
        setGoal(w, m, (wc2 % w.W + 0.5) * w.cs, (((wc2 / w.W) | 0) + 0.5) * w.cs, 0.3, 'inside');
        events.push({ type: 'crabsGrab', monster: m.id, item: best.id, def: best.def, x: m.x, z: m.z });
        return;
      }
      setGoal(w, m, best.x, best.z, 0.3, 'inside');
      if (walkToGoal(w, m, CR.speed, dt)) { m.x += (best.x - m.x) * Math.min(1, dt * 4); m.z += (best.z - m.z) * Math.min(1, dt * 4); }
      return;
    }
    if (!m.flow || walkToGoal(w, m, CR.speed * 0.5, dt)) { // pottering about
      var rm = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      setGoal(w, m, (rm.x + 0.5 + m.rng() * (rm.w - 1)) * w.cs, (rm.y + 0.5 + m.rng() * (rm.h - 1)) * w.cs, 0.3, 'inside');
      m.pauseT = m.rng() * 4;
    }
  }

  // ---- Dwarf Ossuary: the Gelatinous Cube, bats, cave-ins, the mine cart

  // The Cube drifts between rooms, and comes for footsteps it can feel. Loose loot it
  // rolls over ends up floating inside it; a goblin it reaches is engulfed.
  function stepCube(state, w, m, dt, events, noises) {
    var CU = MON.cube;
    m.moving = false;
    m.squelchT -= dt;
    if (m.squelchT <= 0) { m.squelchT = 2.5 + m.rng() * 2; events.push({ type: 'squelch', monster: m.id, x: m.x, z: m.z }); }
    // swallow loot lying in its way
    state.items.forEach(function (it) {
      if (it.gone || it.holder !== null || it.flying || it.inCube != null || it.chest >= 0 || it.inCart) return;
      if (Math.hypot(it.x - m.x, it.z - m.z) > CU.swallowRange || Math.abs(it.y - m.y) > 1.2) return;
      it.inCube = m.id;
      it.cubeOff = [(m.rng() - 0.5) * 0.9, 0.35 + m.rng() * 1.1, (m.rng() - 0.5) * 0.9];
      events.push({ type: 'slurp', monster: m.id, item: it.id, x: m.x, z: m.z });
    });
    if (m.holding !== null) { // busy digesting
      var h = state.players[m.holding];
      if (!h || h.dead || h.engulfed !== m.id) m.holding = null;
      return;
    }
    if (m.stunT > 0) return;
    var prey = null, pd = Infinity;
    goblins(state).forEach(function (p) {
      var d = Math.hypot(p.x - m.x, p.z - m.z);
      if (Math.abs(p.y - m.y) > 1.5 || p.onDeck) return;
      var moving = Math.hypot(p.vx, p.vz) > 0.3;
      var feels = d < 1.0 || (moving && d < (p.crouching ? CU.feelCrouched : CU.feelRange));
      if (feels && d < pd) { pd = d; prey = p; }
    });
    if (prey && pd < CU.engulfRange) {
      prey.engulfed = m.id; prey.struggle = 0; prey.digestHurt = 0;
      m.holding = prey.id;
      events.push({ type: 'engulf', monster: m.id, player: prey.id, x: m.x, z: m.z });
      return;
    }
    if (prey) {
      m.state = 'hunt';
      setGoal(w, m, prey.x, prey.z, CU.height, 'inside');
      walkToGoal(w, m, CU.huntSpeed, dt);
      if (pd < 2.5) { m.x += (prey.x - m.x) / pd * CU.huntSpeed * dt * 0.5; m.z += (prey.z - m.z) / pd * CU.huntSpeed * dt * 0.5; } // closes the last bit off the grid
      return;
    }
    noises.forEach(function (e) {
      if (Math.hypot(e.x - m.x, e.z - m.z) <= e.radius * CU.hearing) { m.state = 'drift'; setGoal(w, m, e.x, e.z, CU.height, 'inside'); }
    });
    if (m.state === 'hunt') m.state = 'wander', m.flow = null;
    if (m.pauseT > 0) { m.pauseT -= dt; return; }
    if (!m.flow || walkToGoal(w, m, CU.wanderSpeed, dt)) {
      m.state = 'wander';
      var rm = w.rooms[Math.floor(m.rng() * w.rooms.length)];
      if (rm.type !== 'chasm') setGoal(w, m, (rm.x + 0.5 + m.rng() * (rm.w - 1)) * w.cs, (rm.y + 0.5 + m.rng() * (rm.h - 1)) * w.cs, CU.height, 'inside');
      m.pauseT = m.rng() < 0.5 ? 2 + m.rng() * 4 : 0;
    }
  }
  function stepEngulfed(state, w, pl, inp, dt, events) {
    var CU = MON.cube, m = state.monsters[pl.engulfed];
    if (!m || m.dead) { pl.engulfed = null; return; }
    pl.vx = pl.vz = 0;
    pl.x += (m.x - pl.x) * Math.min(1, 4 * dt); pl.z += (m.z - pl.z) * Math.min(1, 4 * dt); pl.y = m.y + 0.25; pl.grounded = true;
    pl.crouching = false; pl.focus = null;
    pl.digestHurt += CU.digest * dt;
    if (pl.digestHurt >= 4) { var dmg = Math.floor(pl.digestHurt); pl.digestHurt -= dmg; hurt(state, w, pl, dmg, 'cube', events); }
    if (pl.dead) { pl.engulfed = null; m.holding = null; return; }
    if (Math.abs(inp.fwd) + Math.abs(inp.strafe) > 0 || inp.jump) pl.struggle += dt;
    if (pl.struggle < CU.struggleSeconds) return;
    // out the way the goblin is facing, if there's floor there; otherwise straight back
    var fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw), out = null;
    [[fx, fz], [-fx, -fz], [fz, -fx], [-fz, fx]].some(function (dv) {
      var x = m.x + dv[0] * 1.35, z = m.z + dv[1] * 1.35, c = cellAt(w, x, z);
      if (c < 0 || !isFloorKind(w.kind[c]) || Math.abs(floorAt(w, c, x, z) - m.y) > 0.6) return false;
      if (blockedAt(w, pl, x, z, D.player.crouchHeight) === 'wall') return false;
      out = { x: x, z: z, y: floorAt(w, c, x, z) }; return true;
    });
    if (out) { pl.x = out.x; pl.z = out.z; pl.y = out.y; }
    pl.warp++;
    pl.engulfed = null; pl.struggle = 0; m.holding = null; m.stunT = CU.spitStun;
    events.push({ type: 'spatOut', player: pl.id, monster: m.id, x: m.x, z: m.z });
  }
  function killCube(state, w, m, events) {
    m.dead = true;
    for (var pid in state.players) if (state.players[pid].engulfed === m.id) state.players[pid].engulfed = null;
    var k = 0;
    state.items.forEach(function (it) {
      if (it.inCube !== m.id || it.gone) return;
      it.inCube = null; it.x = m.x + ((k % 3) - 1) * 0.5; it.z = m.z + (((k / 3) | 0) - 0.5) * 0.5; it.y = m.y; k++;
    });
    events.push({ type: 'cubeDead', monster: m.id, x: m.x, z: m.z });
  }

  // Bats roost high up. Light or footsteps nearby wake them; they fly at whoever woke
  // them, shrieking (every monster hears it), then off to another roost. Anyone standing
  // when they pass gets swirled and has their lantern put out. Crouch and they fly over.
  function wakeBats(state, w, m, target, events) {
    var B = MON.bats;
    m.state = target ? 'chase' : 'leave'; m.chase = target ? target.id : null; m.chaseT = 5; m.shriekT = 0;
    var choices = w.roosts.map(function (r, i) { return i; }).filter(function (i) { return i !== m.roost; });
    m.roost = choices.length ? choices[Math.floor(m.rng() * choices.length)] : m.roost;
    m.flow = null;
    events.push({ type: 'batsWake', monster: m.id, x: m.x, z: m.z });
  }
  function stepBats(state, w, m, dt, events, noises) {
    var B = MON.bats, ro = w.roosts[m.roost];
    m.moving = false;
    if (m.state === 'roost') {
      m.restT -= dt;
      if (m.restT > 0) return;
      var waker = null;
      goblins(state).forEach(function (p) {
        var lit = p.lanternOn || lightRadius(state, p) > 0;
        if (!waker && Math.abs(p.y - ro.floor) < 2.5 && Math.hypot(p.x - m.x, p.z - m.z) < (lit ? B.wakeLit : B.wakeDark)) waker = p;
      });
      if (!waker) noises.forEach(function (e) {
        if (!waker && e.swarm === undefined && (e.loud || 0) >= B.wakeLoud && Math.hypot(e.x - m.x, e.z - m.z) <= e.radius * B.hearing) {
          waker = e.player ? state.players[e.player] : null; if (!waker) waker = nearestGoblin(state, e.x, e.z) || { id: null };
        }
      });
      if (waker) wakeBats(state, w, m, waker.id ? waker : null, events);
      return;
    }
    // in flight: shriek as they go
    m.shriekT -= dt;
    if (m.shriekT <= 0) {
      m.shriekT = B.shriekEvery;
      events.push({ type: 'shriek', swarm: m.id, loud: B.shriekLoud, radius: B.shriekLoud * D.noise.baseRadius, x: m.x, z: m.z });
    }
    var target = m.chase ? state.players[m.chase] : null;
    if (m.state === 'swirl') {
      m.swirlT -= dt;
      if (target) { var a = m.swirlT * 7; m.x = target.x + Math.cos(a) * 0.6; m.z = target.z + Math.sin(a) * 0.6; m.y = target.y + 1.1; }
      if (m.swirlT <= 0 || !target || target.dead) { m.state = 'leave'; m.flow = null; }
      m.moving = true;
      return;
    }
    if (m.state === 'chase') {
      m.chaseT -= dt;
      if (!target || target.dead || target.aboard || m.chaseT <= 0) { m.state = 'leave'; m.flow = null; }
      else {
        var d = Math.hypot(target.x - m.x, target.z - m.z);
        if (d < B.passRange) {
          if (target.crouching) { m.state = 'leave'; m.flow = null; events.push({ type: 'batsPass', monster: m.id, player: target.id }); }
          else {
            m.state = 'swirl'; m.swirlT = B.swirlSeconds;
            if (target.lanternOn) { target.lanternOn = false; events.push({ type: 'snuffed', player: target.id, x: target.x, z: target.z }); }
            events.push({ type: 'swirl', monster: m.id, player: target.id, x: target.x, z: target.z });
          }
          return;
        }
        setGoal(w, m, target.x, target.z, 0.3, 'fly');
        if (walkToGoal(w, m, B.flySpeed, dt)) { var dd = Math.max(d, 1e-3); m.x += (target.x - m.x) / dd * B.flySpeed * dt; m.z += (target.z - m.z) / dd * B.flySpeed * dt; }
        batHeight(w, m, target.y + 1.3, dt);
        return;
      }
    }
    // leaving for the next roost
    setGoal(w, m, ro.x, ro.z, 0.3, 'fly');
    var there = walkToGoal(w, m, B.flySpeed, dt);
    var c = cellAt(w, m.x, m.z);
    batHeight(w, m, c >= 0 && w.kind[c] === INSIDE ? w.ceil[c] - 0.5 : m.y, dt);
    if (there || Math.hypot(ro.x - m.x, ro.z - m.z) < 0.4) {
      m.x = ro.x; m.z = ro.z; m.y = ro.y; m.state = 'roost'; m.restT = B.restSeconds; m.chase = null;
      events.push({ type: 'batsRoost', monster: m.id });
    }
  }
  function batHeight(w, m, want, dt) {
    var c = cellAt(w, m.x, m.z);
    if (c >= 0 && w.kind[c] === INSIDE) want = Math.min(want, w.ceil[c] - 0.3);
    m.y += (want - m.y) * Math.min(1, 5 * dt);
  }

  // Weak ceilings take strain from noise underneath. Past the limit they groan
  // (dust trickles) and, a moment later, come down.
  function stepCaveins(state, w, dt, events, noises) {
    var HZ = w.tomb.hazards;
    w.caveins.forEach(function (cv, i) {
      var cs2 = state.caveins[i];
      if (cs2.fallen) return;
      if (cs2.rumbleT > 0) {
        cs2.rumbleT -= dt;
        if (cs2.rumbleT > 0) return;
        cs2.fallen = true;
        cv.cells.forEach(function (c) { w.sand[c] += HZ.rubble; w.surf[c] = SURF.gravel; });
        goblins(state).forEach(function (p) {
          if (cv.cells.indexOf(cellAt(w, p.x, p.z)) >= 0 && p.y < cv.top) hurt(state, w, p, HZ.caveinHit, 'cavein', events);
        });
        state.items.forEach(function (it) {
          if (!it.gone && it.holder === null && !it.flying && it.inCube == null && cv.cells.indexOf(cellAt(w, it.x, it.z)) >= 0) it.y += HZ.rubble;
        });
        state.monsters.forEach(function (m) { if (!m.dead && m.mode !== 'fly' && cv.cells.indexOf(cellAt(w, m.x, m.z)) >= 0) m.y += HZ.rubble; });
        events.push({ type: 'cavein', cavein: i, x: cv.x, z: cv.z, loud: 1.2, radius: 1.2 * D.noise.baseRadius });
        return;
      }
      cs2.strain = Math.max(0, cs2.strain - HZ.caveinDecay * dt);
      noises.forEach(function (e) {
        var d = Math.hypot(e.x - cv.x, e.z - cv.z);
        if (d < HZ.caveinRange && e.type !== 'cavein') cs2.strain += (e.loud || 0.5) * (1 - d / HZ.caveinRange);
      });
      if (cs2.strain >= HZ.caveinStrain) { cs2.rumbleT = HZ.caveinDelay; events.push({ type: 'rumble', cavein: i, x: cv.x, z: cv.z }); }
    });
  }

  // The mine cart runs the rail end to end. Push it (E) and it rolls away from you,
  // carrying whatever sits in it, rattling loud enough for the whole mine to hear.
  // Is a circle of radius rad at (px, pz) touching the cart (0.84 m wide, 1.3 m long)?
  function inCart(cart, px, pz, rad) {
    var dx = px - cart.x, dz = pz - cart.z, s = Math.sin(cart.rot), c = Math.cos(cart.rot);
    var along = dx * s + dz * c, across = dx * c - dz * s;
    var ex = Math.max(0, Math.abs(across) - 0.42), ez = Math.max(0, Math.abs(along) - 0.65);
    return ex * ex + ez * ez < rad * rad;
  }
  function cartPose(w, cart) {
    var pts = w.rail.pts, s = Math.max(0, Math.min(w.rail.len, cart.s)), i = 1;
    while (i < pts.length - 1 && pts[i].s < s) i++;
    var a = pts[i - 1], b = pts[i], seg = Math.max(1e-6, b.s - a.s), t = Math.max(0, Math.min(1, (s - a.s) / seg));
    cart.x = a.x + (b.x - a.x) * t; cart.z = a.z + (b.z - a.z) * t;
    var c = cellAt(w, cart.x, cart.z);
    cart.y = a.y + (b.y - a.y) * t + (c >= 0 ? w.sand[c] : 0);
    cart.rot = Math.atan2(b.x - a.x, b.z - a.z);
    return cart;
  }
  // The push handle: the end of the cart nearest the goblin.
  function cartHandle(cart, pl) {
    var ex = Math.sin(cart.rot) * 0.68, ez = Math.cos(cart.rot) * 0.68;
    var sgn = Math.hypot(cart.x + ex - pl.x, cart.z + ez - pl.z) < Math.hypot(cart.x - ex - pl.x, cart.z - ez - pl.z) ? 1 : -1;
    return { x: cart.x + ex * sgn, y: cart.y + 0.75, z: cart.z + ez * sgn };
  }
  function pushCart(state, w, pl, events) {
    var cart = w.rail.cart, ahead = cartPose(w, { s: cart.s + 1 }), back = cartPose(w, { s: cart.s - 1 });
    var dir = Math.hypot(ahead.x - pl.x, ahead.z - pl.z) >= Math.hypot(back.x - pl.x, back.z - pl.z) ? 1 : -1;
    if ((dir > 0 && cart.s >= w.rail.len - 0.05) || (dir < 0 && cart.s <= 0.05)) dir = -dir; // at the end of the line: back the other way
    cart.dir = dir; cart.moving = true; cart.v = 0.8;
    events.push({ type: 'cartPush', player: pl.id, first: !state.cartPushed, x: cart.x, z: cart.z });
    state.cartPushed = true;
  }
  function stepCarts(state, w, dt, events) {
    if (!w.rail || !w.rail.cart) return;
    var HZ = w.tomb.hazards, cart = w.rail.cart;
    cart.hitCd = Math.max(0, cart.hitCd - dt);
    // loot left in the bed rides along
    state.items.forEach(function (it) {
      if (it.gone || it.holder !== null || it.flying || it.inCube != null) return;
      if (!it.inCart) {
        if (cart.moving || Math.hypot(it.x - cart.x, it.z - cart.z) > 0.5 || it.y > cart.y + 1.0) return;
        it.inCart = true;
        var ca = Math.cos(cart.rot), sa = Math.sin(cart.rot), dx = it.x - cart.x, dz = it.z - cart.z;
        it.cartOff = [dx * ca - dz * sa, dx * sa + dz * ca];
      }
    });
    if (!cart.moving) {
      state.items.forEach(function (it) { if (it.inCart && !it.gone && it.holder === null) it.y = cart.y + 0.38; });
      return;
    }
    var prevS = cart.s;
    cart.v = Math.min(HZ.cartSpeed, cart.v + 2.5 * dt);
    cart.s += cart.dir * cart.v * dt;
    var stop = cart.s <= 0 || cart.s >= w.rail.len;
    cartPose(w, cart);
    goblins(state).forEach(function (p) {
      if (Math.abs(p.y - cart.y) > 1 || !inCart(cart, p.x, p.z, D.player.radius)) return;
      var fx = Math.sin(cart.rot) * cart.dir, fz = Math.cos(cart.rot) * cart.dir;
      if ((p.x - cart.x) * fx + (p.z - cart.z) * fz < 0) return; // only what's ahead of it
      if (cart.v < 1.6) { // still slow: it just shoves you off the rails
        var sx = -fz, sz = fx, sd = (p.x - cart.x) * sx + (p.z - cart.z) * sz >= 0 ? 1 : -1;
        var nx = p.x + sx * sd * 0.15, nz = p.z + sz * sd * 0.15;
        w.rail.cart = null; var free = !blockedAt(w, p, nx, nz, D.player.crouchHeight); w.rail.cart = cart; // walls only, not the cart itself
        if (free) { p.x = nx; p.z = nz; p.warp = (p.warp || 0) + 1; return; }
      } else if (cart.hitCd <= 0) { cart.hitCd = 1.2; events.push({ type: 'cartHit', player: p.id, x: cart.x, z: cart.z }); hurt(state, w, p, HZ.cartHit, 'cart', events); }
      cart.s = prevS; cartPose(w, cart); stop = true; // and it stops dead
    });
    var ca2 = Math.cos(cart.rot), sa2 = Math.sin(cart.rot);
    state.items.forEach(function (it) {
      if (!it.inCart || it.gone || it.holder !== null) return;
      it.x = cart.x + it.cartOff[0] * ca2 + it.cartOff[1] * sa2; it.z = cart.z - it.cartOff[0] * sa2 + it.cartOff[1] * ca2; it.y = cart.y + 0.38;
    });
    cart.rumbleT -= dt;
    if (cart.rumbleT <= 0) { cart.rumbleT = HZ.cartRumbleEvery; events.push({ type: 'cartRumble', loud: HZ.cartLoud, radius: HZ.cartLoud * D.noise.baseRadius * 1.1, x: cart.x, z: cart.z }); }
    if (stop) {
      cart.moving = false; cart.v = 0; cart.s = Math.max(0, Math.min(w.rail.len, cart.s)); cartPose(w, cart);
      events.push({ type: 'cartStop', loud: 0.8, radius: 0.8 * D.noise.baseRadius, x: cart.x, z: cart.z });
    }
  }

  // Club and flash-powder against monsters.
  function clubHit(state, w, pl, events) {
    var fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
    state.monsters.forEach(function (m) {
      if (m.dead) return;
      var dx = m.x - pl.x, dz = m.z - pl.z, d = Math.hypot(dx, dz);
      if (d > 1.6 || d < 1e-3 || (dx * fx + dz * fz) / d < 0.5 || Math.abs(m.y - pl.y) > 1.2) return;
      if (m.type === 'mimic') {
        m.hp -= 1; m.stunT = MON.mimic.stunSeconds;
        wakeMimic(state, w, m, events, 'club');
        events.push({ type: 'mimicHit', monster: m.id, x: m.x, z: m.z, hp: m.hp });
        if (m.hp <= 0) killMimic(state, w, m, events);
      } else if (m.type === 'cube') {
        m.hp -= 1; m.stunT = 0.6;
        events.push({ type: 'cubeHit', monster: m.id, x: m.x, z: m.z, hp: m.hp });
        if (m.hp <= 0) killCube(state, w, m, events);
      } else if (m.type === 'crabs' || m.type === 'thief') {
        m.hp -= 1; crabsDrop(state, w, m, events); m.scatterT = MON[m.type].scatterSeconds;
        events.push({ type: 'crabsHit', monster: m.id, x: m.x, z: m.z });
        if (m.hp <= 0) { m.dead = true; events.push({ type: 'crabsDead', monster: m.id, x: m.x, z: m.z }); }
      } else if (m.type === 'bats') return;
      else events.push({ type: 'clang', monster: m.id, x: m.x, z: m.z });
    });
  }
  function flashMonsters(state, w, x, z, seconds, events) {
    state.monsters.forEach(function (m) {
      if (m.dead || m.type === 'ranger' || m.type === 'jackal' || m.type === 'cube' || Math.hypot(m.x - x, m.z - z) > MON.flashRange) return; // the Ranger is blind already; the Jackal is stone; the Cube has no eyes
      if (m.type === 'bats') { if (m.state === 'roost') wakeBats(state, w, m, null, events); return; }
      if (m.type === 'crabs' || m.type === 'thief') { crabsDrop(state, w, m, events); m.scatterT = MON[m.type].scatterSeconds; return; }
      if (m.type === 'mimic' && m.state !== 'awake') return;
      if (m.type === 'pharaoh' && m.state === 'dormant') return;
      if (m.type === 'scarabs') { m.dead = true; events.push({ type: 'scarabsGone', monster: m.id, flash: true }); return; }
      var secs = m.type === 'mummy' ? MON.mummy.flashStun : m.type === 'pharaoh' ? MON.pharaoh.flashStun : m.type === 'captain' ? MON.captain.flashStun : m.type === 'myconid' ? MON.myconid.flashStun : m.type === 'onryo' ? MON.onryo.flashStun : m.type === 'ghoul' ? MON.ghoul.flashStun : seconds;
      m.blindT = secs; m.stunT = m.type === 'mimic' ? secs : m.stunT;
      events.push({ type: 'blinded', monster: m.id, x: m.x, z: m.z });
    });
  }

  // ---------- the night ----------

  function liftOff(state, w, reason, events) {
    if (state.phase !== 'night') return;
    state.phase = 'liftoff'; state.phaseT = 0;
    var stowed = state.stowed.slice(), lost = [], leftBehind = [];
    var s = w.ship;
    var kit = [];
    function take(it, into) {
      if (it.tool) { if (into !== lost) kit.push({ def: it.def, burn: it.burn }); it.gone = true; return; }
      into.push({ def: it.def, value: it.value }); it.gone = true;
    }
    var deaths = [], crewSize = Object.keys(state.players).length, living = 0;
    var onShip = function (p) { return p.x > s.x0 && p.x < s.x1 && p.z > s.z0 && p.z < s.z1 && p.y > s.deck - 0.3; };
    for (var pid in state.players) {
      var pl = state.players[pid];
      pl.aboard = !pl.dead && pl.onDeck;
      if (!pl.dead) living++;
      carried(state, pl).forEach(function (it) { release(state, pl, it); take(it, pl.aboard ? stowed : lost); });
      if (pl.dead) { deaths.push({ player: pid, cause: pl.cause, bodyAboard: onShip(pl) }); lost = lost.concat(pl.deathLoot || []); }
      else if (!pl.aboard) { pl.leftBehind = true; leftBehind.push(pid); }
    }
    var leftCount = 0, leftValue = 0;
    state.items.forEach(function (it) {
      if (it.gone) return;
      if (it.lostWith) { it.gone = true; return; } // dropped by a goblin that died: counted as lost
      if (!it.flying && it.x > s.x0 && it.x < s.x1 && it.z > s.z0 && it.z < s.z1 && it.y > s.deck - 0.2) take(it, stowed);
      else if (!it.tool) { leftCount++; leftValue += it.value; }
    });
    // A crew wipe (co-op): nobody left to guard the hold, so everything aboard is lost too.
    var wiped = crewSize > 1 && living === 0;
    if (wiped) { lost = lost.concat(stowed); stowed = []; }
    state.result = { reason: reason, wiped: wiped, tomb: w.tombId, night: state.campaign.night, stowed: stowed, lost: lost,
      leftBehind: leftBehind, deaths: deaths, leftInTomb: { count: leftCount, value: leftValue }, kit: kit, campaign: state.campaign };
    events.push({ type: 'liftoff', reason: reason, leftBehind: leftBehind, deaths: deaths.length });
  }

  function stepNight(state, w, dt, events) {
    var NT = D.night;
    state.phaseT += dt;
    if (state.phase === 'landing') {
      var k = Math.min(1, state.phaseT / NT.landingSeconds);
      w.ship.lift = NT.liftHeight * (1 - k) * (1 - k);
      if (k >= 1) {
        w.ship.lift = 0; state.phase = state.warren ? 'visit' : 'night'; state.phaseT = 0;
        events.push({ type: 'landed', frenzy: state.frenzy, warren: state.warren });
      }
    } else if (state.phase === 'night') {
      state.clock += dt * (NT.endHour - NT.startHour) / NT.realSeconds;
      var hr = Math.floor(state.clock);
      if (hr !== state.lastHour) { state.lastHour = hr; events.push({ type: 'hour', hour: hr }); }
      if (!state.bellRung && state.clock >= NT.bellHour) { state.bellRung = true; events.push({ type: 'bell' }); }
      if (state.clock >= NT.endHour) { state.clock = NT.endHour; liftOff(state, w, 'dawn', events); }
      if (state.panicT > 0) {
        state.panicT -= dt;
        if (state.panicT <= 0) { events.push({ type: 'panic' }); liftOff(state, w, 'death', events); }
      }
    } else if (state.phase === 'liftoff') {
      var k2 = Math.min(1, state.phaseT / NT.liftOffSeconds);
      w.ship.lift = state.sky ? 0 : NT.liftHeight * k2 * k2; // from the sky it just sails off
      if (k2 >= 1) { state.phase = 'over'; events.push({ type: 'nightOver', result: state.result }); }
    } else if (state.phase === 'pit' && state.phaseT >= 3.5) {
      state.phase = 'over';
      events.push({ type: 'nightOver', result: state.result });
    }
  }

  // Leaving the warren. On Cut night Craig takes his Cut on the way out; a crew that
  // can't pay goes over the rail instead.
  function departWarren(state, w, events) {
    if (state.phase !== 'visit') return;
    var c = visitCampaign(state), terms = state.terms;
    if (terms.cutNight) {
      var r = payCut(c);
      c = r.campaign;
      if (!r.paid) {
        state.campaign = c;
        state.phase = 'pit'; state.phaseT = 0;
        state.result = { pit: true, campaign: c, short: r.short };
        for (var pid in state.players) {
          var pl = state.players[pid];
          pl.pitFrom = { x: pl.x, y: pl.y, z: pl.z };
          carried(state, pl).forEach(function (it) { release(state, pl, it); });
        }
        events.push({ type: 'pit', due: r.due, short: r.short });
        return;
      }
      if (!r.already) events.push({ type: 'cutPaid', due: r.due, left: r.left, bare: r.bare });
    }
    for (var id2 in state.players) {
      var p2 = state.players[id2];
      p2.aboard = p2.onDeck && !p2.dead;
      carried(state, p2).forEach(function (it) { release(state, p2, it); it.x = p2.x; it.z = p2.z; it.y = w.ship.deck; });
    }
    c = visitCampaign(Object.assign({}, state, { campaign: c }));
    c.pendingThrone = false;
    c.night += 1; c.where = 'sky'; c.visit = null; // the day's spent; back up into the sky
    state.campaign = c;
    state.phase = 'liftoff'; state.phaseT = 0;
    state.result = { warren: true, campaign: c };
    events.push({ type: 'liftoff', reason: 'helm', leftBehind: [], warren: true });
  }

  // Leaving the sky for the day's destination: Craig (on Cut day, whatever the chart says)
  // or a tomb, paying the fare. The hold goes back below.
  function departSky(state, w, events) {
    if (state.phase !== 'sky') return;
    for (var pid in state.players) {
      var pl = state.players[pid];
      pl.aboard = true;
      carried(state, pl).forEach(function (it) { release(state, pl, it); it.x = pl.x; it.z = pl.z; it.y = w.ship.deck; });
    }
    var c = visitCampaign(state), forced = cycleDay(c) === D.economy.cycle;
    var dest = D.travel.filter(function (d) { return d.id === c.destination; })[0] || D.travel[1];
    if (forced || dest.craig) { c.where = 'craig'; if (forced) c.destination = c.lastTomb || 'barrow'; }
    else {
      if (c.gold < fareOf(c, dest)) dest = D.travel.filter(function (d) { return d.cost === 0 && !d.craig; })[0];
      c.gold -= fareOf(c, dest); c.destination = dest.id; c.lastTomb = dest.id; c.where = 'tomb';
    }
    c.omen = c.where === 'tomb' ? omenOf(c, c.destination) : null;
    state.campaign = c;
    state.phase = 'liftoff'; state.phaseT = 0;
    state.result = { sky: true, campaign: c, to: c.where === 'craig' ? 'craig' : c.destination };
    events.push({ type: 'liftoff', reason: 'helm', leftBehind: [], sky: true, to: state.result.to, forced: forced });
  }

  // Thrown over the rail: a short arc into the middle of the pit, then the drop.
  function stepPitFall(state, w, pl) {
    var t = state.phaseT, from = pl.pitFrom;
    if (!from) return;
    var k = Math.min(1, t / 1.2), mid = { x: w.pit.x, z: w.pit.z };
    pl.x = from.x + (mid.x - from.x) * k; pl.z = from.z + (mid.z - from.z) * k;
    if (t < 1.2) pl.y = from.y + Math.sin(k * Math.PI) * 2.5;
    else pl.y = Math.max(w.pit.floor, from.y - (t - 1.2) * (t - 1.2) * 6);
    pl.vx = pl.vz = 0;
  }

  // Advances the game by dt seconds. inputs maps player id -> input. Returns events.
  function step(state, w, inputs, dt) {
    var events = [];
    if (state.phase === 'over') return events;
    state.t += dt;
    stepNight(state, w, dt, events);
    for (var pid in state.players) stepPlayer(state, w, state.players[pid], inputs[pid] || NO_INPUT, dt, events);
    stepGear(state, w, inputs, dt, events);
    stepDoors(state, w, dt, events);
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      if (!it.gone && it.burn > 0) {
        it.burn -= dt;
        if (it.burn <= 0) {
          it.burn = 0; it.gone = true;
          var owner = it.holder !== null ? state.players[it.holder] : null;
          if (owner) release(state, owner, it);
          events.push({ type: 'torchOut', item: it.id, player: owner ? owner.id : null });
          continue;
        }
      }
      if (it.flying && !it.gone) stepItem(state, w, it, dt, events);
      else if (it.inCube != null && !it.gone) { var cm = state.monsters[it.inCube]; it.x = cm.x + it.cubeOff[0]; it.y = cm.y + it.cubeOff[1]; it.z = cm.z + it.cubeOff[2]; it.rot += dt * 0.3; }
      else if (it.holder !== null) { var h = state.players[it.holder]; it.x = h.x; it.y = h.y; it.z = h.z; }
    }
    stepCarts(state, w, dt, events);
    stepTide(state, w, dt, events);
    stepCaves(state, w, dt, events);
    stepMonsters(state, w, dt, events);
    return events;
  }

  // ---------- co-op: more goblins, snapshots, prediction ----------

  // A goblin joining the crew (the host's is p1). Mid-night joiners appear on deck.
  function addPlayer(state, w, id) {
    if (state.players[id]) return state.players[id];
    var pl = createPlayer(w, id, (parseInt(String(id).slice(1), 10) || 1) - 1);
    if (state.phase !== 'landing') pl.y = w.ship.deck + w.ship.lift;
    state.players[id] = pl;
    return pl;
  }
  // A goblin leaving: whatever it carried drops where it stood.
  function removePlayer(state, w, id) {
    var pl = state.players[id];
    if (!pl) return;
    if (pl.carrying !== null) setBodyDown(state, w, pl, []);
    carried(state, pl).forEach(function (it) { release(state, pl, it); it.x = pl.x; it.y = pl.y; it.z = pl.z; it.vx = it.vy = it.vz = 0; it.flying = false; });
    delete state.players[id];
    var alive = false; for (var q in state.players) if (!state.players[q].dead) alive = true;
    if (!alive && state.phase === 'night' && !(state.panicT > 0) && Object.keys(state.players).length) state.panicT = D.death.panicSeconds;
  }

  // What a client needs to draw the night: everything in the state that isn't a random stream,
  // a pathfinding cache or a noise queue, plus the parts of the world that change.
  // Left out of snapshots: random streams, pathfinding caches, and timers only the host's sim reads. They change
  // every tick, so sending them made most of each update. (A client's own goblin keeps its own: PLAYER_PRIVATE.)
  var SKIP_STATE = { rng: 1, lateNoises: 1, seedBase: 1, t: 1, spawnT: 1 }, SKIP_MON = { rng: 1, flow: 1, goalCell: 1, doorKey: 1,
    shootCd: 1, stabCd: 1, restT: 1, shriekT: 1, wailT: 1, groanT: 1, bellT: 1, puffT: 1, squelchT: 1, grindT: 1, speakT: 1, cd: 1, hitCd: 1,
    searchT: 1, shunT: 1, closeT: 1, nipT: 1, lifeT: 1, blindT: 1, curseBlockT: 1 };
  var POS_KEYS = ['x', 'y', 'z', 'dir'], VEL_KEYS = ['vx', 'vy', 'vz'], MON_UP = ['pauseT', 'stunT', 'scatterT'];
  function roundTo(o, keys, k) { keys.forEach(function (f) { if (typeof o[f] === 'number') o[f] = Math.round(o[f] * k) / k; }); }
  var PLAYER_PRIVATE = ['staminaDelay', 'stride', 'grumbleT', 'voiceT', 'phantomT', 'drownHurt', 'sandHurt', 'digestHurt'];
  function packBits(a) { var out = '', run = 0, cur = 0; for (var i = 0; i < a.length; i++) { if (a[i] === cur) run++; else { out += run + ','; cur = a[i]; run = 1; } } return out + run; }
  function unpackBits(str, a) { var runs = str.split(','), i = 0, v = 0; runs.forEach(function (r) { var n = +r; for (var k = 0; k < n && i < a.length; k++) a[i++] = v; v = v ? 0 : 1; }); }
  function snapshot(state, w) {
    var snap = {};
    for (var k in state) if (!SKIP_STATE[k]) snap[k] = state[k];
    if (state.campaign) { snap.campaign = {}; for (var ck in state.campaign) if (ck !== 'history') snap.campaign[ck] = state.campaign[ck]; }
    snap.explored = packBits(state.explored);
    snap.players = {};
    for (var pid in state.players) {
      var sp = state.players[pid], po = {}; for (var pk in sp) if (PLAYER_PRIVATE.indexOf(pk) < 0) po[pk] = sp[pk];
      roundTo(po, POS_KEYS, 100); roundTo(po, VEL_KEYS, 10); // a centimetre is plenty to draw by; speeds only swing the legs
      snap.players[pid] = po;
    }
    snap.monsters = state.monsters.map(function (m) {
      var o = {}; for (var mk in m) if (!SKIP_MON[mk] && typeof m[mk] !== 'function') o[mk] = m[mk];
      roundTo(o, POS_KEYS, 100);
      MON_UP.forEach(function (f) { if (o[f] > 0) o[f] = Math.ceil(o[f]); }); // the client only asks whether these are running
      return o;
    });
    var sand = [];
    for (var c = 0; c < w.sand.length; c++) { var sv = Math.round(w.sand[c] * 1000) / 1000; if (sv) sand.push(c, sv); }
    snap.world = { lift: w.ship.lift, tide: w.tide, sand: sand, doors: w.doors.map(function (d) { return [d.open ? 1 : 0, Math.ceil(d.timer || 0)]; }), // the timer to the second: it ticks
      loose: w.chests.map(function (ch) { return ch.loose ? 1 : 0; }), cart: w.rail && w.rail.cart ? w.rail.cart : null, gangway: w.ship.gangwayUp ? 1 : 0, barrel: w.ship.hasBarrel ? 1 : 0 };
    return snap;
  }
  // Snapshots on the wire, smaller: numbers rounded to a millimetre (packSnap), and after the first, only
  // what changed since the last one (diffSnap; patchSnap rebuilds it). The crew's channel is reliable and
  // in order, so each difference builds on the one before; the host still sends a whole one now and then.
  function packSnap(v) {
    if (typeof v === 'number') return v === Math.round(v) ? v : Math.round(v * 1000) / 1000;
    if (!v || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return Array.prototype.slice.call(v);
    if (Array.isArray(v)) return v.map(packSnap);
    var o = {};
    for (var k in v) { var x = v[k]; if (x !== undefined && typeof x !== 'function') o[k] = packSnap(x); }
    return o;
  }
  function sameSnap(a, b) { return a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b)); }
  // The change from a to b (packed snapshots), or undefined if nothing changed. Arrays and objects are
  // compared a level or two down, so one goblin moving resends that goblin's changed fields, not everything.
  function diffSnap(a, b, depth) {
    depth = depth || 0;
    if (depth > 0 && sameSnap(a, b)) return undefined;
    if (depth >= 3 || !a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return { $v: b };
    if (Array.isArray(b)) {
      var ch = {}, any = a.length !== b.length;
      for (var i = 0; i < b.length; i++) { var di = i < a.length ? diffSnap(a[i], b[i], depth + 1) : { $v: b[i] }; if (di !== undefined) { ch[i] = di; any = true; } }
      return any ? { $n: b.length, $c: ch } : undefined;
    }
    var out = {}, del = [], changed = false;
    for (var k in b) { var d = diffSnap(a[k], b[k], depth + 1); if (d !== undefined) { out[k] = d; changed = true; } }
    for (k in a) if (!(k in b)) { del.push(k); changed = true; }
    if (!changed) return undefined;
    var r = { $o: out }; if (del.length) r.$d = del;
    return r;
  }
  function patchSnap(a, d) {
    if (d === undefined) return a;
    if ('$v' in d) return d.$v;
    var i, k;
    if ('$n' in d) { var arr = (a || []).slice(0, d.$n); for (i in d.$c) arr[+i] = patchSnap(arr[+i], d.$c[i]); arr.length = d.$n; return arr; }
    var o = {}; for (k in a) o[k] = a[k];
    for (k in d.$o) o[k] = patchSnap(o[k], d.$o[k]);
    (d.$d || []).forEach(function (k2) { delete o[k2]; });
    return o;
  }
  function applySnapshot(state, w, snap) {
    if (snap.campaign && !snap.campaign.history) snap.campaign.history = state.campaign && state.campaign.history || [];
    var before = state.players || {};
    for (var k in snap) if (k !== 'world' && k !== 'explored') state[k] = snap[k];
    for (var pid2 in state.players) { var was = before[pid2], now = state.players[pid2]; PLAYER_PRIVATE.forEach(function (f) { now[f] = was && was[f] !== undefined ? was[f] : 0; }); } // the host keeps these to itself
    if (!state.explored || state.explored.length !== w.W * w.H) state.explored = new Uint8Array(w.W * w.H);
    unpackBits(snap.explored, state.explored);
    var ws = snap.world;
    w.ship.lift = ws.lift; w.tide = ws.tide; w.ship.gangwayUp = !!ws.gangway; w.ship.hasBarrel = !!ws.barrel;
    w.sand.fill(0);
    for (var i = 0; i < ws.sand.length; i += 2) w.sand[ws.sand[i]] = ws.sand[i + 1];
    ws.doors.forEach(function (d, di) { if (w.doors[di]) { w.doors[di].open = !!d[0]; w.doors[di].timer = d[1]; } });
    ws.loose.forEach(function (l, ci) { if (w.chests[ci]) w.chests[ci].loose = !!l; });
    if (w.rail && ws.cart) w.rail.cart = ws.cart;
    (state.caveins || []).forEach(function (cs, ci) { if (cs.fallen) w.caveins[ci].cells.forEach(function (cc) { w.surf[cc] = SURF.gravel; }); });
  }
  // Client-side prediction: move one goblin by one input, movement only (the host decides
  // everything else). Returns the events it made (footsteps, landings) for the client's own ears.
  var PREDICT_KEEP = ['helmHold', 'translating', 'translateT', 'grumbleT', 'shellTalk', 'signalT'];
  var MOVE_ONLY = { scry: false, use: false, useHeld: false, useItem: false, drop: false, toss: false, lantern: false, signal: false, shell: false, slot: -1, slotDelta: 0, voice: 0 };
  function predict(state, w, id, inp, dt) {
    var pl = state.players[id], events = [];
    if (!pl || pl.dead || state.phase === 'over') return events;
    var mv = {};
    for (var k in inp) mv[k] = inp[k];
    for (k in MOVE_ONLY) mv[k] = MOVE_ONLY[k];
    var kept = {};
    PREDICT_KEEP.forEach(function (k2) { kept[k2] = pl[k2]; });
    stepPlayer(state, w, pl, mv, dt, events);
    PREDICT_KEEP.forEach(function (k2) { pl[k2] = kept[k2]; }); // the host's to say: the helm and rune charge bars, the shell
    return events;
  }

  // Co-op: each goblin's own client decides where it walks, except while the sim itself is moving it
  // (riding the ship, in a Cube, buried, thrown in the pit, dead). pl.warp counts the sim's teleports.
  function hostDriven(state, pl) {
    return !pl || pl.dead || pl.engulfed !== null || pl.buried || state.phase === 'landing' || state.phase === 'pit' ||
      ((state.phase === 'liftoff' || state.phase === 'over') && pl.aboard);
  }
  var MOVE_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz'];
  function moveOf(pl) { return MOVE_FIELDS.map(function (k) { return Math.round(pl[k] * 1000) / 1000; }).concat([pl.grounded ? 1 : 0]); }
  function setMove(pl, a) { MOVE_FIELDS.forEach(function (k, i) { pl[k] = a[i]; }); pl.grounded = !!a[6]; }
  // The host puts a crew goblin where its own client says, but does the landing itself, so a fall
  // still hurts (and a chasm still kills) however the client's messages bunch up on the way.
  function takeMove(pl, at) {
    if (pl.grounded && !at[6]) pl.fallFrom = Math.max(pl.y, at[1]); // took off: the fall is measured from here
    if (!pl.grounded && at[6]) { at = at.slice(); at[1] += 0.02; at[4] = Math.min(pl.vy, -1); at[6] = 0; } // came down: land it here, next step
    setMove(pl, at);
  }

  GOB.Sim = {
    hostDriven: hostDriven, moveOf: moveOf, setMove: setMove, takeMove: takeMove,
    addPlayer: addPlayer, removePlayer: removePlayer, snapshot: snapshot, applySnapshot: applySnapshot, predict: predict,
    packSnap: packSnap, diffSnap: diffSnap, patchSnap: patchSnap,
    KIND: { SOLID: SOLID, INSIDE: INSIDE, OUTSIDE: OUTSIDE, FIELDWALL: FIELDWALL },
    TAG: { ROOM: TAG_ROOM, CORRIDOR: TAG_CORRIDOR, TUNNEL: TAG_TUNNEL },
    SURFACES: SURFACES, DIRS: DIRS,
    hashString: hashString, makeRng: makeRng,
    createWorld: createWorld, createState: createState, step: step,
    newCampaign: newCampaign, nightSeed: nightSeed, endNight: endNight,
    isFrenzy: isFrenzy, throneTerms: throneTerms, offerFor: offerFor, sell: sell, sellOne: sellOne, payCut: payCut,
    leaveThrone: leaveThrone, visitCampaign: visitCampaign, replacementFee: replacementFee, cutDue: cutDue,
    lineOfSight: lineOfSight, flowField: flowField, cycleDay: cycleDay, placeOf: placeOf, tideAt: tideAt, canSee: canSee, coverOf: coverOf, spawnTable: spawnTable, cartHandle: cartHandle, planked: planked, deckSpots: deckSpots,
    cellAt: cellAt, footprint: footprint, cutLeft: cutLeft, surfaceAt: surfaceAt, heldItem: heldItem, carried: carried,
    watching: watching, omenOf: omenOf, fareOf: fareOf, hasUpgrade: hasUpgrade, cleanLook: cleanLook
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GOB;
})(typeof window !== 'undefined' ? window : globalThis);

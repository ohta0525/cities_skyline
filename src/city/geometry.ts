/** 2D（xz 平面）の幾何計算。道路は 2 次ベジェ曲線で表す */
export interface P2 {
  x: number;
  z: number;
}

export interface Curve {
  p0: P2;
  /** 制御点。直線なら p0 と p2 の中点 */
  c: P2;
  p2: P2;
}

export const lerp2 = (a: P2, b: P2, t: number): P2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const dist2 = (a: P2, b: P2): number => Math.hypot(a.x - b.x, a.z - b.z);

export function straight(p0: P2, p2: P2): Curve {
  return { p0, c: lerp2(p0, p2, 0.5), p2 };
}

export function pointAt(cv: Curve, t: number): P2 {
  const u = 1 - t;
  return {
    x: u * u * cv.p0.x + 2 * u * t * cv.c.x + t * t * cv.p2.x,
    z: u * u * cv.p0.z + 2 * u * t * cv.c.z + t * t * cv.p2.z,
  };
}

/** 進行方向の単位ベクトル */
export function tangentAt(cv: Curve, t: number): P2 {
  let x = 2 * (1 - t) * (cv.c.x - cv.p0.x) + 2 * t * (cv.p2.x - cv.c.x);
  let z = 2 * (1 - t) * (cv.c.z - cv.p0.z) + 2 * t * (cv.p2.z - cv.c.z);
  const l = Math.hypot(x, z);
  if (l < 1e-9) {
    x = cv.p2.x - cv.p0.x; z = cv.p2.z - cv.p0.z;
    const l2 = Math.hypot(x, z) || 1;
    return { x: x / l2, z: z / l2 };
  }
  return { x: x / l, z: z / l };
}

/** 左手側の法線（進行方向に対して左） */
export const leftNormal = (t: P2): P2 => ({ x: t.z, z: -t.x });

/** t で 2 つに分ける（ド・カステリョ） */
export function splitCurve(cv: Curve, t: number): [Curve, Curve] {
  const q0 = lerp2(cv.p0, cv.c, t);
  const q1 = lerp2(cv.c, cv.p2, t);
  const r = lerp2(q0, q1, t);
  return [{ p0: cv.p0, c: q0, p2: r }, { p0: r, c: q1, p2: cv.p2 }];
}

/** 曲線の一部 [t0, t1] */
export function subCurve(cv: Curve, t0: number, t1: number): Curve {
  if (t0 <= 0) return t1 >= 1 ? cv : splitCurve(cv, t1)[0];
  const right = splitCurve(cv, t0)[1];
  if (t1 >= 1) return right;
  return splitCurve(right, (t1 - t0) / (1 - t0))[0];
}

/** 弧長の表。samples+1 点の累積距離 */
export function arcTable(cv: Curve, samples = 32): Float64Array {
  const out = new Float64Array(samples + 1);
  let prev = cv.p0;
  for (let i = 1; i <= samples; i++) {
    const p = pointAt(cv, i / samples);
    out[i] = out[i - 1] + dist2(prev, p);
    prev = p;
  }
  return out;
}

export function curveLength(cv: Curve): number {
  const a = arcTable(cv);
  return a[a.length - 1];
}

/** 弧長 s に対応する t */
export function tAtLength(table: Float64Array, s: number): number {
  const n = table.length - 1;
  if (s <= 0) return 0;
  if (s >= table[n]) return 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (table[m] < s) lo = m; else hi = m;
  }
  const f = (s - table[lo]) / (table[hi] - table[lo] || 1);
  return (lo + f) / n;
}

/** 折れ線（t と点の組） */
export function polyline(cv: Curve, step = 4): { t: number; p: P2 }[] {
  const len = curveLength(cv);
  const n = Math.max(2, Math.ceil(len / step));
  const out: { t: number; p: P2 }[] = [];
  for (let i = 0; i <= n; i++) out.push({ t: i / n, p: pointAt(cv, i / n) });
  return out;
}

/** 曲線上で点に最も近い位置 */
export function closestOnCurve(cv: Curve, q: P2): { t: number; p: P2; d: number } {
  const pl = polyline(cv, 2);
  let best = { t: 0, p: pl[0].p, d: Infinity };
  for (let i = 0; i < pl.length - 1; i++) {
    const a = pl[i].p, b = pl[i + 1].p;
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    const f = Math.min(1, Math.max(0, ((q.x - a.x) * abx + (q.z - a.z) * abz) / l2));
    const p = { x: a.x + abx * f, z: a.z + abz * f };
    const d = dist2(p, q);
    if (d < best.d) best = { t: pl[i].t + (pl[i + 1].t - pl[i].t) * f, p, d };
  }
  return best;
}

/** 線分どうしの交点。交わらなければ null。u, v は各線分上の割合 */
export function segIntersect(a: P2, b: P2, c: P2, d: P2): { u: number; v: number; p: P2 } | null {
  const rx = b.x - a.x, rz = b.z - a.z;
  const sx = d.x - c.x, sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c.x - a.x, qz = c.z - a.z;
  const u = (qx * sz - qz * sx) / den;
  const v = (qx * rz - qz * rx) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v, p: { x: a.x + rx * u, z: a.z + rz * u } };
}

/** 2 本の曲線の交点（t の組） */
export function curveIntersections(a: Curve, b: Curve): { ta: number; tb: number; p: P2 }[] {
  const pa = polyline(a, 3), pb = polyline(b, 3);
  const out: { ta: number; tb: number; p: P2 }[] = [];
  for (let i = 0; i < pa.length - 1; i++) {
    for (let j = 0; j < pb.length - 1; j++) {
      const hit = segIntersect(pa[i].p, pa[i + 1].p, pb[j].p, pb[j + 1].p);
      if (!hit) continue;
      const ta = pa[i].t + (pa[i + 1].t - pa[i].t) * hit.u;
      const tb = pb[j].t + (pb[j + 1].t - pb[j].t) * hit.v;
      // 折れ線の継ぎ目で同じ交点が 2 回出ることがある
      if (out.some((o) => dist2(o.p, hit.p) < 1)) continue;
      out.push({ ta, tb, p: hit.p });
    }
  }
  return out.sort((x, y) => x.ta - y.ta);
}

export function bbox(cv: Curve, pad = 0): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const xs = [cv.p0.x, cv.c.x, cv.p2.x], zs = [cv.p0.z, cv.c.z, cv.p2.z];
  return {
    minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad,
    minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad,
  };
}

/** 2 つの向きのなす角（0〜π） */
export function angleBetween(a: P2, b: P2): number {
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z)));
}

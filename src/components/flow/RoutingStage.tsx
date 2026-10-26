import * as React from 'react';

import prettyBytes from '../../misc/pretty-bytes';
import s from './RoutingStage.module.scss';

const { forwardRef, useEffect, useImperativeHandle, useRef } = React;

// the routing stage, after yetone/magpie's: agents on the left, the Clash
// core in the middle, the outbound proxies on the right; wires under,
// packets flying over — a new connection flies out and holds at its node
// while it lives, and flies home when it closes
const NS = 'http://www.w3.org/2000/svg';
const MAX_SRC = 4;
const MAX_DST = 8;
const PALETTE = ['#8b5cf6', '#22c55e', '#0d9488', '#0891b2', '#ca8a04', '#db2777', '#2563eb', '#65a30d'];
const MS_IN = 420;
const MS_OUT = 460;
const MS_BACK = 380;

export type StageOpen = { id: string; src: string; node: string };
export type StageEvents = { opened: StageOpen[]; closed: string[] };
export type NodeSpeed = [string, number];

export type RoutingHandle = {
  push: (ev: StageEvents) => void;
  speeds: (byNode: NodeSpeed[], active: number) => void;
};

const hueOf = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

const still = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Seat = {
  root: HTMLDivElement;
  sub: HTMLElement;
  wire: SVGPathElement;
};

type Leg = 'in' | 'out' | 'held' | 'back1' | 'back2';

type Flight = {
  id: string;
  src: string;
  dst: string;
  dot: SVGCircleElement;
  leg: Leg;
  closePending: boolean;
};

type Trip = {
  fl: Flight;
  p: SVGPathElement;
  rev: boolean;
  t0: number;
  ms: number;
};

// path length cache, keyed by the d it was measured for (magpie's measure)
const measured = new WeakMap<SVGPathElement, { d: string; L: number }>();
function lenOf(p: SVGPathElement): number {
  const d = p.getAttribute('d');
  if (!d) return 0;
  let m = measured.get(p);
  if (!m || m.d !== d) measured.set(p, (m = { d, L: p.getTotalLength() || 0 }));
  return m.L;
}

function pointAt(p: SVGPathElement, s: number) {
  const L = lenOf(p);
  if (!L) return null;
  return p.getPointAtLength(Math.max(0, Math.min(L, s)));
}

export const RoutingStage = forwardRef<RoutingHandle, { backend?: string }>(function RoutingStage(
  { backend },
  ref,
) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wiresRef = useRef<SVGSVGElement | null>(null);
  const skyRef = useRef<SVGSVGElement | null>(null);
  const srcsRef = useRef<HTMLDivElement | null>(null);
  const hubRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const srcSeats = useRef(new Map<string, Seat>());
  const dstSeats = useRef(new Map<string, Seat>());
  const flights = useRef(new Map<string, Flight>());
  const trips = useRef<Trip[]>([]);
  const raf = useRef(0);

  function wire(cls: string, color: string) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('class', cls);
    p.style.setProperty('--agent', color);
    wiresRef.current?.appendChild(p);
    return p;
  }

  function makeSeat(map: Map<string, Seat>, key: string, nodeCls: string, wireCls: string) {
    const root = document.createElement('div');
    root.className = nodeCls;
    root.dataset.key = key;
    root.style.setProperty('--agent', hueOf(key));
    const wireEl = wire(wireCls, hueOf(key));
    const name = document.createElement('b');
    name.className = s.nodeName;
    name.textContent = key;
    name.title = key;
    const sub = document.createElement('small');
    sub.className = s.nodeSub;
    root.append(name, sub);
    const st: Seat = { root, sub, wire: wireEl };
    map.set(key, st);
    return st;
  }

  // seat keeps the columns to the seats still wanted, stable places,
  // newcomers in free ones; the evicted take their flights with them
  function seat(map: Map<string, Seat>, want: string[], max: number) {
    const cur = [...map.keys()];
    const keep = cur.filter((k) => want.includes(k));
    for (const k of want) if (!keep.includes(k)) keep.push(k);
    const finalKeys = keep.slice(0, max);
    for (const k of cur) {
      if (finalKeys.includes(k)) continue;
      const st = map.get(k)!;
      st.wire.remove();
      st.root.remove();
      map.delete(k);
      for (const [id, fl] of flights.current) {
        if (fl.src === k || fl.dst === k) {
          fl.dot.remove();
          flights.current.delete(id);
        }
      }
    }
    const col = map === srcSeats.current ? srcsRef.current : listRef.current;
    col?.replaceChildren(...finalKeys.map((k) => map.get(k)!.root));
  }

  // pose puts the packet e of the way along the wire its leg rides; the
  // dst wire is drawn hub → node, so forward legs read it as-is
  function pose(fl: Flight, e: number) {
    const dstSeat = dstSeats.current.get(fl.dst);
    const srcSeat = srcSeats.current.get(fl.src);
    let p: SVGPathElement | undefined;
    let rev = false;
    if (fl.leg === 'in' && srcSeat) p = srcSeat.wire;
    else if ((fl.leg === 'out' || fl.leg === 'held') && dstSeat) p = dstSeat.wire;
    else if (fl.leg === 'back1' && dstSeat) {
      p = dstSeat.wire;
      rev = true;
    } else if (fl.leg === 'back2' && srcSeat) {
      p = srcSeat.wire;
      rev = true;
    }
    if (!p) return;
    const L = lenOf(p);
    if (!L) return;
    const pt = pointAt(p, (rev ? 1 - e : e) * L);
    if (!pt) return;
    fl.dot.setAttribute('cx', pt.x.toFixed(1));
    fl.dot.setAttribute('cy', pt.y.toFixed(1));
    fl.dot.removeAttribute('visibility');
  }

  function updateWires() {
    const litSrc = new Map<string, number>();
    const litDst = new Map<string, number>();
    for (const fl of flights.current.values()) {
      litSrc.set(fl.src, (litSrc.get(fl.src) || 0) + 1);
      litDst.set(fl.dst, (litDst.get(fl.dst) || 0) + 1);
    }
    for (const [k, st] of srcSeats.current) st.wire.classList.toggle(s.live, (litSrc.get(k) || 0) > 0);
    for (const [k, st] of dstSeats.current) {
      st.wire.classList.toggle(s.live, (litDst.get(k) || 0) > 0);
      st.root.classList.toggle(s.on, (litDst.get(k) || 0) > 0);
    }
  }

  function drop(fl: Flight) {
    fl.dot.classList.add(s.gone);
    setTimeout(() => fl.dot.remove(), 300);
    flights.current.delete(fl.id);
    updateWires();
  }

  function startLeg(fl: Flight, leg: Leg) {
    fl.leg = leg;
    const dstSeat = dstSeats.current.get(fl.dst);
    const srcSeat = srcSeats.current.get(fl.src);
    let p: SVGPathElement | undefined;
    let ms = MS_IN;
    if (leg === 'in' && srcSeat) {
      p = srcSeat.wire;
      ms = MS_IN;
    } else if (leg === 'out' && dstSeat) {
      p = dstSeat.wire;
      ms = MS_OUT;
    } else if (leg === 'back1' && dstSeat) {
      p = dstSeat.wire;
      ms = MS_BACK;
    } else if (leg === 'back2' && srcSeat) {
      p = srcSeat.wire;
      ms = MS_IN;
    }
    fl.dot.classList.toggle(s.held, leg === 'held');
    fl.dot.classList.toggle(s.back, leg === 'back1' || leg === 'back2');
    if (leg === 'held') {
      // it waits at the node while the connection lives
      pose(fl, 1);
      updateWires();
      if (fl.closePending) startLeg(fl, 'back1');
      return;
    }
    if (!p) {
      // its seat went away: the packet has nowhere to be
      drop(fl);
      return;
    }
    trips.current.push({ fl, p, rev: false, t0: performance.now(), ms: still() ? 0 : ms });
    kick();
  }

  function finish(tr: Trip) {
    const { fl } = tr;
    if (fl.leg === 'in') startLeg(fl, 'out');
    else if (fl.leg === 'out') startLeg(fl, 'held');
    else if (fl.leg === 'back1') startLeg(fl, 'back2');
    else if (fl.leg === 'back2') drop(fl);
  }

  function frame(ts: number) {
    raf.current = 0;
    const going: Trip[] = [];
    for (const tr of trips.current) {
      const k = tr.ms ? Math.min(1, Math.max(0, (ts - tr.t0) / tr.ms)) : 1;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      pose(tr.fl, e);
      if (k >= 1) finish(tr);
      else going.push(tr);
    }
    trips.current = going;
    if (trips.current.length) raf.current = requestAnimationFrame(frame);
  }

  function kick() {
    if (!raf.current && trips.current.length) raf.current = requestAnimationFrame(frame);
  }

  // layout draws the wires between the seats and the hub, reading every
  // box once; a ResizeObserver calls it again when the stage is resized
  function layout() {
    const stage = stageRef.current;
    if (!stage || !wiresRef.current) return;
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    wiresRef.current.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    const h = hubRef.current!.getBoundingClientRect();
    const hl = h.left - r.left;
    const hr = h.right - r.left;
    const hy = (h.top + h.bottom) / 2 - r.top;
    for (const st of srcSeats.current.values()) {
      const b = st.root.getBoundingClientRect();
      if (!b.width) continue;
      const cy = (b.top + b.bottom) / 2 - r.top;
      const x1 = b.right - r.left + 3;
      const x2 = hl - 2;
      const mx = (x1 + x2) / 2;
      st.wire.setAttribute('d', `M${x1} ${cy} C${mx} ${cy} ${mx} ${hy} ${x2} ${hy}`);
    }
    for (const st of dstSeats.current.values()) {
      const b = st.root.getBoundingClientRect();
      if (!b.width) continue;
      const cy = (b.top + b.bottom) / 2 - r.top;
      const x1 = hr + 2;
      const x2 = b.left - r.left - 3;
      const mx = (x1 + x2) / 2;
      st.wire.setAttribute('d', `M${x1} ${hy} C${mx} ${hy} ${mx} ${cy} ${x2} ${cy}`);
    }
    // held packets stay at their wire's end as the stage is laid out again
    for (const fl of flights.current.values()) if (fl.leg === 'held') pose(fl, 1);
  }

  useImperativeHandle(ref, () => ({
    push(ev) {
      for (const o of ev.opened) {
        if (flights.current.has(o.id)) continue;
        if (!srcSeats.current.has(o.src)) makeSeat(srcSeats.current, o.src, s.srcNode, s.wire);
        if (!dstSeats.current.has(o.node)) makeSeat(dstSeats.current, o.node, s.dstNode, s.wire);
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', '4');
        c.setAttribute('class', s.pkt);
        c.style.setProperty('--agent', hueOf(o.src));
        c.setAttribute('visibility', 'hidden');
        skyRef.current?.appendChild(c);
        const fl: Flight = { id: o.id, src: o.src, dst: o.node, dot: c, leg: 'in', closePending: false };
        flights.current.set(o.id, fl);
        startLeg(fl, 'in');
      }
      for (const id of ev.closed) {
        const fl = flights.current.get(id);
        if (!fl) continue;
        if (fl.leg === 'held') startLeg(fl, 'back1');
        else fl.closePending = true;
      }
      seat(srcSeats.current, [...srcSeats.current.keys()], MAX_SRC);
      seat(dstSeats.current, [...dstSeats.current.keys()], MAX_DST);
      layout();
      updateWires();
      kick();
    },
    speeds(byNode, active) {
      const map = new Map(byNode);
      for (const [k, st] of dstSeats.current) {
        const v = map.get(k) || 0;
        st.sub.textContent = v > 0 ? `↓${prettyBytes(v)}/s` : '';
      }
      const count = hubRef.current?.querySelector('[data-hub-count]');
      if (count) count.textContent = String(active);
    },
  }));

  useEffect(() => {
    const stage = stageRef.current!;
    const flightsMap = flights.current;
    const seatsSrc = srcSeats.current;
    const seatsDst = dstSeats.current;
    const ro = new ResizeObserver(() => layout());
    ro.observe(stage);
    return () => {
      ro.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
      trips.current = [];
      flightsMap.clear();
      seatsSrc.clear();
      seatsDst.clear();
    };
    // layout closes over only refs and the DOM the observer watches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const host = (() => {
    try {
      return backend ? new URL(backend).host : '';
    } catch {
      return '';
    }
  })();

  return (
    <div className={s.stage} ref={stageRef}>
      <svg className={s.wires} ref={wiresRef} aria-hidden="true" />
      <div className={s.srcs} ref={srcsRef} />
      <div className={s.hub} ref={hubRef}>
        <img className={s.hubLogo} src="yacd-128.png" alt="" />
        <b className={s.hubName}>Clash</b>
        <small className={s.hubHost}>{host}</small>
        <i className={s.hubChip}>
          <span data-hub-count>0</span> conns
        </i>
      </div>
      <div className={s.list} ref={listRef}>
        <div className={s.idle}>No request yet</div>
      </div>
      <svg className={s.sky} ref={skyRef} aria-hidden="true" />
    </div>
  );
});

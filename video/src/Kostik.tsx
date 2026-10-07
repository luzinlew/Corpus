import React from 'react';
import {useCurrentFrame} from 'remotion';
import {C, SANS, lerp, useSpring} from './kit';

/* Kostik, the app's skull mascot (same drawing as kostik() in src/corpus.html), animated:
   blinks, floats, looks around, changes mood */
const SKULL = 'M60 8C92 8 108 30 106 56c-1 14-6 22-12 26v10c0 8-6 12-14 12H40c-8 0-14-4-14-12V82c-6-4-11-12-12-26C12 30 28 8 60 8z';
const INK = '#2B2622';

export type Mood = 'hi' | 'joy' | 'oops' | 'cap' | 'wink';

export const Kostik: React.FC<{size: number; mood?: Mood; look?: [number, number]; blinkSeed?: number; float?: boolean; tilt?: number}> = ({size, mood = 'hi', look = [0, 0], blinkSeed = 0, float = true, tilt = 0}) => {
  const f = useCurrentFrame();
  const cyc = (f + blinkSeed) % 96;
  const blink = cyc > 88 ? Math.abs(Math.sin(((cyc - 88) / 8) * Math.PI)) : 0;
  const sy = 1 - 0.88 * blink;
  const fy = float ? Math.sin(f / 22) * 5 : 0;
  const fr = float ? Math.sin(f / 30) * 2 : 0;
  const [lx, ly] = look;
  const eye = (cx: number, wink = false) =>
    wink ? <path d={`M${cx - 11} 58c4-7 18-7 22 0`} fill="none" stroke={INK} strokeWidth={6} strokeLinecap="round" />
      : (
        <g transform={`translate(${cx + lx} ${56 + ly}) scale(1 ${sy}) translate(${-cx - lx} ${-56 - ly})`}>
          <ellipse cx={cx + lx} cy={56 + ly} rx={13} ry={15} fill={INK} />
          <circle cx={cx + 4.5 + lx * 1.2} cy={50 + ly * 1.2} r={4.5} fill="#fff" />
        </g>
      );
  let eyes: React.ReactNode;
  if (mood === 'joy' || mood === 'cap') eyes = <path d="M30 57c4-9 20-9 24 0M66 57c4-9 20-9 24 0" fill="none" stroke={INK} strokeWidth={6.5} strokeLinecap="round" />;
  else if (mood === 'oops') eyes = (<><ellipse cx={42} cy={58} rx={9} ry={10 * sy} fill={INK} /><ellipse cx={78} cy={58} rx={9} ry={10 * sy} fill={INK} /><circle cx={45} cy={54} r={3} fill="#fff" /><circle cx={81} cy={54} r={3} fill="#fff" /></>);
  else if (mood === 'wink') eyes = <>{eye(42)}{eye(78, true)}</>;
  else eyes = <>{eye(42)}{eye(78)}</>;
  const mouth = mood === 'joy' || mood === 'cap' || mood === 'wink'
    ? <path d="M42 85h36v4c0 9-7 14-18 14s-18-5-18-14z" fill="#fff" stroke={INK} strokeWidth={3.4} strokeLinejoin="round" />
    : mood === 'oops'
      ? <ellipse cx={60} cy={92} rx={7} ry={8} fill="#fff" stroke={INK} strokeWidth={3.2} />
      : <>{[43, 51.5, 60, 68.5].map((x) => <rect key={x} x={x} y={86} width={8.5} height={11} rx={2.6} fill="#fff" stroke={INK} strokeWidth={2.4} />)}</>;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" style={{overflow: 'visible', transform: `translateY(${fy}px) rotate(${fr + tilt}deg)`, filter: 'drop-shadow(0 18px 30px rgba(0,0,0,0.45)) drop-shadow(0 0 40px rgba(255,236,210,0.18))'}}>
      <path d={SKULL} fill="#F7EFE1" stroke={INK} strokeWidth={3.4} strokeLinejoin="round" />
      <path d="M30 26c10-10 30-13 44-9" fill="none" stroke="#fff" strokeWidth={5} strokeLinecap="round" opacity={0.7} />
      <circle cx={25} cy={74} r={6.5} fill="#F4A98A" opacity={0.55} />
      <circle cx={95} cy={74} r={6.5} fill="#F4A98A" opacity={0.55} />
      <path d="M60 70c-4 0-5 6 0 10 5-4 4-10 0-10z" fill={INK} />
      {eyes}
      {mouth}
      {mood === 'cap' ? (
        <g>
          <path d="M14 22L60 4l46 18-46 18z" fill={INK} />
          <path d="M34 31v12c13 9 39 9 52 0V31" fill={INK} />
          <path d="M106 22v22" stroke="#E8A13A" strokeWidth={5} strokeLinecap="round" />
          <circle cx={106} cy={46} r={4} fill="#E8A13A" />
        </g>
      ) : null}
    </svg>
  );
};

/* a glass speech bubble whose text types itself */
export const Bubble: React.FC<{text: string; at: number; x: number; y: number; width?: number; size?: number; tail?: 'left' | 'bottom' | 'right'; out?: number; bold?: string[]}> = ({text, at, x, y, width = 640, size = 44, tail = 'left', out, bold = []}) => {
  const f = useCurrentFrame();
  const s = useSpring(at, {damping: 13, stiffness: 170});
  const n = Math.floor(lerp(f, at + 4, at + 4 + text.length * 0.9, 0, text.length, (t) => t));
  const o = out != null ? lerp(f, out, out + 10, 1, 0) : 1;
  const shown = text.slice(0, n);
  const parts = shown.split(/(\s+)/).map((w, i) => (bold.includes(w.replace(/[.,!?]/g, '')) ? <b key={i} style={{color: C.violet, fontWeight: 700}}>{w}</b> : <span key={i}>{w}</span>));
  const tailStyle: React.CSSProperties = tail === 'left' ? {left: -12, top: 46} : tail === 'right' ? {right: -12, top: 46} : {left: '50%', bottom: -12, marginLeft: -12};
  return (
    <div style={{position: 'absolute', left: x, top: y, width, opacity: Math.min(1, s * 1.5) * o, transform: `scale(${0.7 + 0.3 * s})`, transformOrigin: tail === 'left' ? '0% 50%' : tail === 'right' ? '100% 50%' : '50% 100%'}}>
      <div style={{position: 'relative', padding: '30px 38px', borderRadius: 40, background: 'linear-gradient(135deg, rgba(48,40,92,0.88), rgba(28,24,56,0.88))', border: '1.5px solid rgba(255,255,255,0.16)', boxShadow: '0 30px 70px rgba(0,0,0,0.5), 0 0 50px rgba(110,92,240,0.25)', backdropFilter: 'blur(20px)'}}>
        <div style={{position: 'absolute', width: 24, height: 24, transform: 'rotate(45deg)', background: 'rgba(40,34,80,0.95)', borderLeft: tail !== 'right' ? '1.5px solid rgba(255,255,255,0.16)' : undefined, borderBottom: '1.5px solid rgba(255,255,255,0.16)', borderRight: tail === 'right' ? '1.5px solid rgba(255,255,255,0.16)' : undefined, ...tailStyle}} />
        <div style={{position: 'relative', fontFamily: SANS, fontWeight: 500, fontSize: size, lineHeight: 1.3, color: C.ink, letterSpacing: -0.6, minHeight: size * 1.3}}>
          {parts}
          <span style={{visibility: 'hidden'}}>{text.slice(n)}</span>
        </div>
      </div>
    </div>
  );
};

import React from 'react';
import {AbsoluteFill, Img, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig, Easing} from 'remotion';

/* palette: the app's dark «Свет» theme, pushed a little brighter for video */
export const C = {
  bg: '#07060F',
  ink: '#F2F0FA',
  ink2: '#B4AED3',
  violet: '#9C8CFF',
  violetDeep: '#6E5CF0',
  peach: '#FFB59A',
  pink: '#F49BC4',
  teal: '#6FD0E8',
  green: '#6FD0A2',
  red: '#F2879B',
  orange: '#F2A766',
  blue: '#8FB4F5',
};
export const SANS = "'Onest', system-ui, sans-serif";
export const SERIF = "'Source Serif 4', Georgia, serif";

export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

export const lerp = (f: number, a: number, b: number, from: number, to: number, e = ease) =>
  interpolate(f, [a, b], [from, to], {...clamp, easing: e});

export function useSpring(delay = 0, config: any = {damping: 16, stiffness: 120, mass: 0.9}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return spring({frame: frame - delay, fps, config});
}

/* ---------- background: deep night with slowly breathing aurora and drifting dust ---------- */
export const Background: React.FC<{hue?: number; intensity?: number}> = ({intensity = 1}) => {
  const f = useCurrentFrame();
  const s = (k: number, a: number) => Math.sin(f / k + a);
  const blobs = [
    {x: 20 + 8 * s(90, 0), y: 18 + 6 * s(110, 1), r: 60, c: 'rgba(110,92,240,0.55)'},
    {x: 85 + 6 * s(120, 2), y: 42 + 8 * s(95, 3), r: 55, c: 'rgba(170,70,160,0.38)'},
    {x: 12 + 7 * s(105, 4), y: 82 + 5 * s(80, 5), r: 55, c: 'rgba(30,110,150,0.40)'},
    {x: 80 + 5 * s(85, 6), y: 95 + 4 * s(130, 7), r: 50, c: 'rgba(255,150,120,0.22)'},
  ];
  return (
    <AbsoluteFill style={{background: C.bg}}>
      <AbsoluteFill
        style={{
          opacity: intensity,
          background: blobs.map((b) => `radial-gradient(circle ${b.r}vmax at ${b.x}% ${b.y}%, ${b.c}, transparent 70%)`).join(','),
        }}
      />
      <Dust />
      <AbsoluteFill style={{background: 'radial-gradient(ellipse 85% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.65))'}} />
    </AbsoluteFill>
  );
};

const Dust: React.FC = () => {
  const f = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const dots = new Array(70).fill(0).map((_, i) => {
    const z = random('z' + i);
    const x = random('x' + i) * width;
    const y0 = random('y' + i) * height;
    const y = ((y0 - f * (0.25 + z * 0.9)) % height + height) % height;
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(f / (12 + z * 20) + i));
    const r = 1 + z * 2.6;
    return <div key={i} style={{position: 'absolute', left: x, top: y, width: r, height: r, borderRadius: r, background: '#fff', opacity: (0.12 + z * 0.45) * tw, boxShadow: `0 0 ${6 + z * 10}px rgba(190,170,255,${0.5 * z})`}} />;
  });
  return <AbsoluteFill>{dots}</AbsoluteFill>;
};

/* ---------- a scene: enters from a soft zoom-blur, leaves into one ---------- */
export const Scene: React.FC<{dur: number; children: React.ReactNode; inFrames?: number; outFrames?: number}> = ({dur, children, inFrames = 14, outFrames = 12}) => {
  const f = useCurrentFrame();
  const a = lerp(f, 0, inFrames, 0, 1);
  const b = lerp(f, dur - outFrames, dur, 0, 1, Easing.in(Easing.cubic));
  const scale = 0.94 + 0.06 * a + 0.08 * b;
  const blur = 14 * (1 - a) + 18 * b;
  return <AbsoluteFill style={{opacity: a * (1 - b), transform: `scale(${scale})`, filter: blur > 0.2 ? `blur(${blur}px)` : undefined}}>{children}</AbsoluteFill>;
};

/* ---------- kinetic caption: words rise out of a blur one by one ---------- */
export type Word = string | {t: string; accent?: boolean; serif?: boolean};
export const Caption: React.FC<{words: Word[]; at?: number; size?: number; top?: number; stagger?: number; out?: number; color?: string; weight?: number; align?: 'center' | 'left'; width?: number; lineHeight?: number; left?: number}> = ({
  words, at = 0, size = 92, top = 220, stagger = 3, out, color = C.ink, weight = 700, align = 'center', width = 920, lineHeight = 1.08, left,
}) => {
  const f = useCurrentFrame();
  const o = out != null ? lerp(f, out, out + 10, 1, 0) : 1;
  const oy = out != null ? lerp(f, out, out + 10, 0, -30) : 0;
  return (
    <div style={{position: 'absolute', top, left: left ?? (1080 - width) / 2, width, textAlign: align, opacity: o, transform: `translateY(${oy}px)`}}>
      {words.map((w, i) => {
        const wd = typeof w === 'string' ? {t: w} : w;
        if (wd.t === '\n') return <br key={i} />;
        const p = lerp(f, at + i * stagger, at + i * stagger + 16, 0, 1);
        const style: React.CSSProperties = {
          display: 'inline-block', marginRight: size * 0.24, fontFamily: wd.serif ? SERIF : SANS, fontStyle: wd.serif ? 'italic' : 'normal',
          fontWeight: wd.serif ? 600 : weight, fontSize: size, lineHeight, letterSpacing: wd.serif ? 0 : -size * 0.035, color, textShadow: '0 4px 30px rgba(0,0,0,0.55)',
          opacity: p, transform: `translateY(${(1 - p) * 40}px) scale(${0.96 + 0.04 * p})`, filter: p < 1 ? `blur(${(1 - p) * 14}px)` : undefined,
        };
        if (wd.accent) Object.assign(style, {background: `linear-gradient(100deg, ${C.violet} 0%, ${C.pink} 55%, ${C.peach} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', paddingBottom: 6, textShadow: 'none'});
        return <span key={i} style={style}>{wd.t}</span>;
      })}
    </div>
  );
};

/* small label above a caption */
export const Eyebrow: React.FC<{text: string; at?: number; top: number; out?: number}> = ({text, at = 0, top, out}) => {
  const f = useCurrentFrame();
  const p = lerp(f, at, at + 14, 0, 1);
  const o = out != null ? lerp(f, out, out + 10, 1, 0) : 1;
  return (
    <div style={{position: 'absolute', top, width: 1080, textAlign: 'center', opacity: p * o}}>
      <span style={{fontFamily: SANS, fontWeight: 600, fontSize: 30, letterSpacing: 6, textTransform: 'uppercase', color: C.violet, padding: '12px 26px', borderRadius: 40, border: '1.5px solid rgba(156,140,255,0.35)', background: 'rgba(110,92,240,0.12)', boxShadow: '0 0 40px rgba(110,92,240,0.25)'}}>{text}</span>
    </div>
  );
};

/* ---------- glass device showing a real screen of the app ---------- */
export type ScreenLayer = {src: string; from?: number; fade?: number; wipe?: boolean};
export const Device: React.FC<{
  screens: ScreenLayer[]; width?: number; x?: number; y?: number; rx?: number; ry?: number; rz?: number; scale?: number;
  zoom?: {at: number; to: number; scale: number; cx: number; cy: number; dur?: number}[]; glow?: number; children?: React.ReactNode; shine?: number; opacity?: number;
}> = ({screens, width = 640, x = 540, y = 1100, rx = 0, ry = 0, rz = 0, scale = 1, zoom = [], glow = 1, children, shine, opacity = 1}) => {
  const f = useCurrentFrame();
  const h = width * (844 / 390);
  /* camera inside the screen: zoom into a point (cx, cy in screen css px 390x844) */
  const k = width / 390;
  /* scale about the point, then slide it toward the middle without uncovering the screen's edges */
  let zs = 1, zx = 195, zy = 422, dx = 0, dy = 0;
  for (const z of zoom) {
    const d = z.dur ?? 24;
    const p = lerp(f, z.at, z.at + d, 0, 1, easeInOut);
    const q = lerp(f, z.to, z.to + d, 0, 1, easeInOut);
    const m = p * (1 - q);
    if (m > 0) {
      zs = 1 + (z.scale - 1) * m;
      zx = z.cx; zy = z.cy;
      dx = Math.max(-(390 - zx) * (zs - 1), Math.min(zx * (zs - 1), (195 - zx) * m));
      dy = Math.max(-(844 - zy) * (zs - 1), Math.min(zy * (zs - 1), (422 - zy) * m));
    }
  }
  const sh = shine != null ? lerp(f, shine, shine + 40, -60, 160, easeInOut) : -100;
  return (
    <div style={{position: 'absolute', left: x - width / 2, top: y - h / 2, width, height: h, perspective: 2400, opacity}}>
      <div style={{position: 'absolute', inset: 0, transformStyle: 'preserve-3d', transform: `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${scale})`}}>
        <div style={{position: 'absolute', inset: -60 * k, borderRadius: 80 * k, background: 'radial-gradient(closest-side, rgba(124,100,255,0.55), transparent)', filter: `blur(${40 * k}px)`, opacity: 0.8 * glow}} />
        <div style={{position: 'absolute', inset: 0, borderRadius: 46 * k, overflow: 'hidden', background: '#120f24', boxShadow: `0 ${40 * k}px ${90 * k}px rgba(0,0,0,0.6), 0 0 0 ${1.5 * k}px rgba(255,255,255,0.16), inset 0 0 0 ${1 * k}px rgba(255,255,255,0.10)`}}>
          <div style={{position: 'absolute', inset: 0, transform: `translate(${dx * k}px, ${dy * k}px) scale(${zs})`, transformOrigin: `${zx * k}px ${zy * k}px`}}>
            {screens.map((s, i) => {
              const st = s.from ?? 0;
              const fd = s.fade ?? 10;
              const p = i === 0 ? 1 : lerp(f, st, st + (s.wipe ? 34 : fd), 0, 1, s.wipe ? easeInOut : ease);
              if (p <= 0) return null;
              const style: React.CSSProperties = {position: 'absolute', inset: 0, width: '100%', height: '100%'};
              if (s.wipe) style.clipPath = `inset(0 0 ${100 - p * 100}% 0)`;
              else style.opacity = p;
              return (
                <React.Fragment key={i}>
                  <Img src={staticFile('shots/' + s.src + '.png')} style={style} />
                  {s.wipe && p > 0 && p < 1 ? <ScanLine y={p * h} width={width} k={k} /> : null}
                </React.Fragment>
              );
            })}
            {children}
          </div>
          <div style={{position: 'absolute', inset: 0, background: `linear-gradient(115deg, transparent ${sh - 18}%, rgba(255,255,255,0.16) ${sh}%, transparent ${sh + 18}%)`, pointerEvents: 'none'}} />
        </div>
      </div>
    </div>
  );
};

const ScanLine: React.FC<{y: number; width: number; k: number}> = ({y, width, k}) => (
  <>
    <div style={{position: 'absolute', left: 0, top: y - 120 * k, width, height: 120 * k, background: 'linear-gradient(to bottom, transparent, rgba(156,140,255,0.28))'}} />
    <div style={{position: 'absolute', left: 0, top: y - 2 * k, width, height: 4 * k, background: '#E4DEFF', boxShadow: `0 0 ${18 * k}px ${6 * k}px rgba(156,140,255,0.9), 0 0 ${60 * k}px ${16 * k}px rgba(110,92,240,0.6)`}} />
  </>
);

/* touch indicator: a soft dot that presses and sends out a ring. x, y in screen css px */
export const Tap: React.FC<{at: number; x: number; y: number; k: number; hold?: number}> = ({at, x, y, k, hold = 8}) => {
  const f = useCurrentFrame();
  const t = f - at;
  if (t < -8 || t > 34 + hold) return null;
  const inP = lerp(t, -8, 0, 0, 1);
  const outP = lerp(t, hold, hold + 10, 1, 0);
  const press = t >= 0 && t < hold ? 0.82 : 1;
  const ring = lerp(t, 0, 26, 0, 1);
  return (
    <div style={{position: 'absolute', left: x * k, top: y * k, width: 0, height: 0}}>
      <div style={{position: 'absolute', left: -26 * k * ring - 4 * k, top: -26 * k * ring - 4 * k, width: (52 * ring + 8) * k, height: (52 * ring + 8) * k, borderRadius: '50%', border: `${2 * k}px solid rgba(255,255,255,${0.9 * (1 - ring)})`, opacity: t >= 0 ? 1 : 0}} />
      <div style={{position: 'absolute', left: -14 * k, top: -14 * k, width: 28 * k, height: 28 * k, borderRadius: '50%', background: 'rgba(255,255,255,0.85)', boxShadow: `0 0 ${20 * k}px rgba(200,190,255,0.9)`, opacity: inP * outP, transform: `scale(${press})`}} />
    </div>
  );
};

/* a swipe gesture across the screen */
export const Swipe: React.FC<{at: number; from: [number, number]; to: [number, number]; k: number; dur?: number}> = ({at, from, to, k, dur = 16}) => {
  const f = useCurrentFrame();
  const t = f - at;
  if (t < -6 || t > dur + 12) return null;
  const p = lerp(t, 0, dur, 0, 1, easeInOut);
  const o = lerp(t, -6, 0, 0, 1) * lerp(t, dur, dur + 12, 1, 0);
  const x = from[0] + (to[0] - from[0]) * p, y = from[1] + (to[1] - from[1]) * p;
  return (
    <>
      <div style={{position: 'absolute', left: Math.min(from[0], x) * k, top: (y - 7) * k, width: Math.abs(x - from[0]) * k, height: 14 * k, borderRadius: 14 * k, background: `linear-gradient(${to[0] > from[0] ? 90 : 270}deg, transparent, rgba(255,255,255,0.5))`, opacity: o}} />
      <div style={{position: 'absolute', left: (x - 15) * k, top: (y - 15) * k, width: 30 * k, height: 30 * k, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', boxShadow: `0 0 ${22 * k}px rgba(200,190,255,1)`, opacity: o}} />
    </>
  );
};

/* glass pill with an icon */
export const Chip: React.FC<{text: string; icon?: React.ReactNode; at: number; x: number; y: number; out?: number; size?: number; tone?: string}> = ({text, icon, at, x, y, out, size = 34, tone = C.violet}) => {
  const s = useSpring(at, {damping: 14, stiffness: 160});
  const f = useCurrentFrame();
  const o = out != null ? lerp(f, out, out + 10, 1, 0) : 1;
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%,-50%) scale(${0.6 + 0.4 * s})`, opacity: Math.min(1, s * 1.4) * o, display: 'flex', alignItems: 'center', gap: 14, padding: `${size * 0.48}px ${size * 0.8}px`, borderRadius: 100, whiteSpace: 'nowrap',
      background: 'linear-gradient(135deg, rgba(40,34,78,0.82), rgba(24,20,48,0.82))', border: '1.5px solid rgba(255,255,255,0.14)', boxShadow: `0 20px 50px rgba(0,0,0,0.45), 0 0 34px ${tone}44`, backdropFilter: 'blur(18px)',
      fontFamily: SANS, fontWeight: 600, fontSize: size, color: C.ink, letterSpacing: -0.5}}>
      {icon ? <span style={{color: tone, display: 'flex'}}>{icon}</span> : null}
      {text}
    </div>
  );
};

/* icons: lucide-style strokes, like the app's own */
export const Icon: React.FC<{d: string | string[]; size?: number; sw?: number; color?: string}> = ({d, size = 36, sw = 2.2, color = 'currentColor'}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {(Array.isArray(d) ? d : [d]).map((p, i) => <path key={i} d={p} />)}
  </svg>
);
export const I = {
  scan: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M7 12h10'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  spark: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z'],
  cal: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  qr: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3h-3z', 'M20 14v.01', 'M14 20h.01', 'M17 20h4', 'M20 17v3'],
  volume: ['M11 5L6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'],
  hand: ['M18 11V6a2 2 0 0 0-4 0v5', 'M14 10V4a2 2 0 0 0-4 0v6', 'M10 10.5V6a2 2 0 0 0-4 0v8', 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'],
  palette: ['M12 22a10 10 0 1 1 10-10c0 2.5-2 3-3.5 3H16a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 22z', 'M7.5 10.5h.01', 'M12 7.5h.01', 'M16.5 10.5h.01'],
  import: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  brain: ['M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z', 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z', 'M12 5v13'],
  bulb: ['M9 18h6', 'M10 22h4', 'M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z'],
  globe: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M2 12h20', 'M12 2a15 15 0 0 1 0 20', 'M12 2a15 15 0 0 0 0 20'],
};

export const Shot: React.FC<{src: string; style?: React.CSSProperties}> = ({src, style}) => <Img src={staticFile('shots/' + src + '.png')} style={style} />;

/* ---------- tablet and laptop around a wide screenshot ---------- */
export const Tablet: React.FC<{src: string | ScreenLayer[]; width: number; x: number; y: number; ry?: number; rx?: number; rz?: number; scale?: number; opacity?: number; aspect?: number}> = ({src, width, x, y, ry = 0, rx = 0, rz = 0, scale = 1, opacity = 1, aspect = 820 / 1180}) => {
  const f = useCurrentFrame();
  const h = width * aspect, b = width * 0.028;
  const layers = typeof src === 'string' ? [{src}] : src;
  return (
    <div style={{position: 'absolute', left: x - width / 2 - b, top: y - h / 2 - b, width: width + 2 * b, height: h + 2 * b, perspective: 2400, opacity}}>
      <div style={{position: 'absolute', inset: 0, transform: `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${scale})`, borderRadius: b * 2.2, background: 'linear-gradient(145deg,#2c2a38,#121118)', boxShadow: `0 40px 90px rgba(0,0,0,0.6), 0 0 0 1.5px rgba(255,255,255,0.14), 0 0 80px rgba(110,92,240,0.25)`}}>
        <div style={{position: 'absolute', left: b, top: b, width, height: h, borderRadius: b * 1.1, overflow: 'hidden', background: '#120f24'}}>
          {layers.map((l, i) => {
            const p = i === 0 ? 1 : lerp(f, l.from ?? 0, (l.from ?? 0) + (l.fade ?? 10), 0, 1);
            return p > 0 ? <Img key={i} src={staticFile('shots/' + l.src + '.png')} style={{position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: p}} /> : null;
          })}
        </div>
      </div>
    </div>
  );
};

export const Laptop: React.FC<{src: string; width: number; x: number; y: number; rx?: number; scale?: number; opacity?: number}> = ({src, width, x, y, rx = 0, scale = 1, opacity = 1}) => {
  const h = width * (900 / 1440), b = width * 0.022;
  return (
    <div style={{position: 'absolute', left: x - width / 2 - b, top: y - h / 2 - b, width: width + 2 * b, height: h + 2 * b + width * 0.05, perspective: 2400, opacity, transform: `scale(${scale})`}}>
      <div style={{position: 'absolute', left: 0, top: 0, width: width + 2 * b, height: h + 2 * b, transform: `rotateX(${rx}deg)`, transformOrigin: '50% 100%', borderRadius: `${b * 1.6}px ${b * 1.6}px ${b * 0.4}px ${b * 0.4}px`, background: '#0d0c12', boxShadow: '0 0 0 1.5px rgba(255,255,255,0.14), 0 0 90px rgba(110,92,240,0.22)'}}>
        <Img src={staticFile('shots/' + src + '.png')} style={{position: 'absolute', left: b, top: b, width, height: h, borderRadius: b * 0.5}} />
      </div>
      <div style={{position: 'absolute', left: -width * 0.07, top: h + 2 * b - 2, width: width * 1.14 + 2 * b, height: width * 0.03, borderRadius: `0 0 ${width * 0.03}px ${width * 0.03}px`, background: 'linear-gradient(#cfcbe0,#77738c)', boxShadow: '0 30px 60px rgba(0,0,0,0.6)'}}>
        <div style={{position: 'absolute', left: '50%', top: 0, width: width * 0.16, height: width * 0.012, marginLeft: -width * 0.08, borderRadius: `0 0 ${width * 0.01}px ${width * 0.01}px`, background: '#9894ac'}} />
      </div>
    </div>
  );
};

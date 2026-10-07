import React from 'react';
import {AbsoluteFill, Series, random, useCurrentFrame} from 'remotion';
import {Background, C, Caption, Chip, Device, Eyebrow, I, Icon, SANS, SERIF, Scene, Swipe, Tap, clamp, ease, easeInOut, lerp, useSpring} from './kit';
import {Bubble, Kostik} from './Kostik';

const OVERLAP = 10;
const TAGLINE = ['Õpi', 'kõike,', 'mida', 'saab', {t: 'pildistada', accent: true}];
export const SCENES: [React.FC<{dur: number}>, number][] = [];
const add = (c: React.FC<{dur: number}>, d: number) => SCENES.push([c, d]);
export const promoLength = () => SCENES.reduce((s, [, d]) => s + d, 0) - OVERLAP * (SCENES.length - 1);

/* ============ 1. hook: a storm of Latin terms, then the question ============ */
const TERMS = ['Os frontale', 'Maxilla', 'Mandibula', 'Os temporale', 'Processus mastoideus', 'Os zygomaticum', 'Sutura coronalis', 'Os occipitale', 'Foramen magnum', 'Os sphenoidale', 'Os ethmoidale', 'Arcus zygomaticus',
  'Porus acusticus', 'Os parietale', 'Fossa temporalis', 'Os nasale', 'Os lacrimale', 'Vomer', 'Condylus occipitalis', 'Sella turcica', 'Os palatinum', 'Processus styloideus', 'Concha nasalis', 'Lamina cribrosa'];

const TermStorm: React.FC<{fadeAt?: number}> = ({fadeAt = 999}) => {
  const f = useCurrentFrame();
  const fade = lerp(f, fadeAt, fadeAt + 20, 1, 0.25);
  return (
    <AbsoluteFill style={{perspective: 900, opacity: fade}}>
      {TERMS.map((t, i) => {
        const ph = random('ph' + i);
        const z = ((ph + f / 150) % 1);               // 0 far → 1 near
        const ang = random('a' + i) * Math.PI * 2;
        const rad = 300 + random('r' + i) * 380;
        const x = 540 + Math.cos(ang) * rad * (0.4 + z * 1.6);
        const y = 960 + Math.sin(ang) * rad * (0.6 + z * 1.9);
        const size = 26 + z * z * 120;
        const o = lerp(z, 0, 0.15, 0, 1) * lerp(z, 0.75, 1, 1, 0);
        const blur = z < 0.3 ? (0.3 - z) * 14 : z > 0.7 ? (z - 0.7) * 30 : 0;
        return <div key={i} style={{position: 'absolute', left: x, top: y, transform: 'translate(-50%,-50%)', fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: size, whiteSpace: 'nowrap', color: i % 3 ? '#D9D2FF' : C.peach, opacity: o * 0.8, filter: `blur(${blur}px)`, textShadow: '0 0 30px rgba(156,140,255,0.5)'}}>{t}</div>;
      })}
    </AbsoluteFill>
  );
};

add(({dur}) => {
  const f = useCurrentFrame();
  const kk = useSpring(78, {damping: 12, stiffness: 120});
  return (
    <Scene dur={dur} inFrames={6}>
      <Background intensity={lerp(f, 0, 40, 0.3, 1)} />
      <TermStorm fadeAt={52} />
      <AbsoluteFill style={{background: 'radial-gradient(ellipse 60% 22% at 50% 46%, rgba(7,6,15,0.92), rgba(7,6,15,0.5) 60%, transparent)'}} />
      <Caption at={6} top={760} size={104} out={50} words={['Sadu', {t: 'termineid…', accent: true}]} />
      <Caption at={58} top={700} size={112} words={['Kontrolltöö', {t: '\n'}, 'nädala', {t: 'pärast?', accent: true}]} />
      <div style={{position: 'absolute', left: 540 - 130, top: 1920 - 300 * kk, transform: `rotate(${(1 - kk) * 20}deg)`}}><Kostik size={260} mood="oops" look={[0, -3]} /></div>
    </Scene>
  );
}, 130);

/* ============ 2. Kostik says hi, the logo lands ============ */
const Logo: React.FC<{at: number; y: number; size?: number}> = ({at, y, size = 150}) => {
  const s = useSpring(at, {damping: 15, stiffness: 110});
  const f = useCurrentFrame();
  const glow = 0.5 + 0.5 * Math.sin(f / 14);
  return (
    <div style={{position: 'absolute', top: y, width: 1080, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: size * 0.22, opacity: Math.min(1, s * 1.3), transform: `scale(${0.85 + 0.15 * s})`, filter: s < 0.98 ? `blur(${(1 - s) * 10}px)` : undefined}}>
      <div style={{width: size * 0.62, height: size * 0.4, borderRadius: size * 0.12, background: C.ink, boxShadow: `inset ${-size * 0.22}px 0 0 ${C.violet}, 0 0 ${40 + 30 * glow}px rgba(156,140,255,0.55)`}} />
      <div style={{fontFamily: SANS, fontWeight: 700, fontSize: size, letterSpacing: -size * 0.04, color: C.ink, textShadow: `0 0 ${30 + 30 * glow}px rgba(156,140,255,0.45)`}}>Corpus</div>
    </div>
  );
};

add(({dur}) => {
  const f = useCurrentFrame();
  const up = useSpring(0, {damping: 11, stiffness: 110});
  const move = lerp(f, 34, 60, 0, 1, easeInOut);
  const size = 380 - 120 * move;
  const y = 980 - 340 * up * (1 - move) - 600 * up * move + 340 * (1 - up);
  return (
    <Scene dur={dur}>
      <Background />
      <div style={{position: 'absolute', left: 540 - size / 2, top: y - size / 2}}><Kostik size={size} mood={f < 26 ? 'hi' : 'joy'} look={[lerp(f, 6, 22, -4, 3), 0]} tilt={Math.sin(f / 4) * 6 * lerp(f, 8, 30, 1, 0)} /></div>
      <Logo at={50} y={880} />
      <Caption at={66} top={1090} size={52} weight={500} color={C.ink2} words={TAGLINE} />
    </Scene>
  );
}, 125);

/* ============ 3. photo → cards: automatic frames ============ */
add(({dur}) => {
  const f = useCurrentFrame();
  const enter = useSpring(4, {damping: 18, stiffness: 80});
  const W = 600, k = W / 390;
  return (
    <Scene dur={dur}>
      <Background />
      <Eyebrow text="Foto → kaardid" at={2} top={150} out={dur - 22} />
      <Caption at={6} top={232} size={88} out={150} words={['Pildista', {t: 'atlast', accent: true}]} />
      <Caption at={160} top={232} size={88} words={['Iga', 'nimetus', '→', {t: 'kaart', accent: true}]} />
      <Device width={W} y={1190} ry={-34 * (1 - enter) + 6 * Math.sin(f / 60)} rx={8 * (1 - enter) + 2} scale={0.9 + 0.1 * enter} shine={110}
        screens={[{src: 'auto_empty'}, {src: 'auto_done', from: 74, wipe: true}, {src: 'auto_sel', from: 132, fade: 14}]}
        zoom={[{at: 176, to: 400, scale: 1.45, cx: 250, cy: 560, dur: 30}]}>
        <Tap at={62} x={310} y={723} k={k} />
      </Device>
      <Chip at={118} x={300} y={1790} out={dur - 20} text="Loetakse otse seadmes" icon={<Icon d={I.scan} size={38} />} size={34} />
      <Chip at={210} x={760} y={1760} out={dur - 20} text="7 800 ladina sõna" icon={<Icon d={I.lock} size={34} />} size={32} tone={C.peach} />
    </Scene>
  );
}, 300);

/* ============ 4. studying: reveal, the ring of grades, four modes ============ */
const MiniDevice: React.FC<{src: string; at: number; x: number; ry: number; label: string; tone: string; rz?: number; y?: number}> = ({src, at, x, ry, label, tone, rz = 0, y = 1110}) => {
  const s = useSpring(at, {damping: 15, stiffness: 90});
  const f = useCurrentFrame();
  return (
    <>
      <Device width={238} x={540 + (x - 540) * s} y={y + (1 - s) * 200 + Math.sin(f / 25 + x) * 8} ry={ry * s} rz={rz * s} scale={0.6 + 0.4 * s} opacity={Math.min(1, s * 1.5)} glow={0.55} screens={[{src}]} />
      <Chip at={at + 14} x={x} y={1450} text={label} size={28} tone={tone} />
    </>
  );
};

add(({dur}) => {
  const f = useCurrentFrame();
  const W = 600, k = W / 390;
  const fan = lerp(f, 150, 175, 0, 1, easeInOut);
  return (
    <Scene dur={dur}>
      <Background />
      <Eyebrow text="Õppimine" at={2} top={150} out={dur - 22} />
      <Caption at={6} top={232} size={88} out={140} words={['Meenuta', 'ja', {t: 'hinda', accent: true}]} />
      <Caption at={150} top={232} size={88} words={['Neli', 'viisi', {t: 'õppida', accent: true}]} />
      <Device width={W} y={1190} ry={-8 + 4 * Math.sin(f / 50)} rx={3} scale={1 - 0.25 * fan} opacity={1 - fan} shine={20}
        screens={[{src: 'study_q'}, {src: 'study_a', from: 50, fade: 8}]} zoom={[{at: 70, to: 140, scale: 1.25, cx: 195, cy: 640, dur: 20}]}>
        <Tap at={42} x={195} y={675} k={k} />
        <Swipe at={100} from={[200, 676]} to={[330, 676]} k={k} />
      </Device>
      {f > 100 && f < 150 ? <Chip at={112} x={540} y={1790} out={140} text="→ Hea   ← Uuesti   ↑ Lihtne   ↓ Raske" size={30} tone={C.green} /> : null}
      {fan > 0 ? (
        <>
          <MiniDevice src="study_q" at={152} x={150} ry={22} rz={-3} y={1130} label="Peida kõik" tone={C.violet} />
          <MiniDevice src="choice_q" at={158} x={410} ry={8} rz={-1} label="Valik" tone={C.blue} />
          <MiniDevice src="type_a" at={164} x={670} ry={-8} rz={1} label="Kirjuta" tone={C.pink} />
          <MiniDevice src="find_q" at={170} x={930} ry={-22} rz={3} y={1130} label="Leia pildilt" tone={C.orange} />
        </>
      ) : null}
      <Chip at={214} x={540} y={1760} out={dur - 18} text="Kordused planeeruvad ise · FSRS" icon={<Icon d={I.brain} size={36} />} size={33} />
    </Scene>
  );
}, 290);

/* ============ 5. Claude: a mnemonic and a chat about the card ============ */
const Sparkles: React.FC<{at: number; x: number; y: number}> = ({at, x, y}) => {
  const f = useCurrentFrame();
  return (
    <>
      {new Array(14).fill(0).map((_, i) => {
        const t = f - at - i * 2;
        if (t < 0 || t > 40) return null;
        const a = random('sa' + i) * Math.PI * 2, d = 40 + t * (4 + random('sd' + i) * 5);
        const s = 10 + random('ss' + i) * 18;
        return <div key={i} style={{position: 'absolute', left: x + Math.cos(a) * d, top: y + Math.sin(a) * d, opacity: lerp(t, 25, 40, 1, 0), transform: `translate(-50%,-50%) rotate(${t * 6}deg)`}}><Icon d={I.spark[0]} size={s} color={i % 2 ? C.peach : C.violet} sw={2.5} /></div>;
      })}
    </>
  );
};

add(({dur}) => {
  const f = useCurrentFrame();
  const W = 560, k = W / 390;
  const second = useSpring(96, {damping: 16, stiffness: 90});
  return (
    <Scene dur={dur}>
      <Background />
      <Eyebrow text="Claude" at={2} top={150} out={dur - 22} />
      <Caption at={6} top={232} size={88} out={78} words={['Raske', {t: 'termin?', accent: true}]} />
      <Caption at={86} top={232} size={84} words={['Claude', 'leiab', {t: 'mäluvihje', accent: true}]} />
      <Device width={W} x={540 - 170 * second} y={1180} ry={-6 + 16 * second} scale={1 - 0.12 * second} shine={50}
        screens={[{src: 'editor_sel'}, {src: 'hint_ai', from: 40, fade: 10}]} zoom={[{at: 52, to: 400, scale: 1.18, cx: 195, cy: 640, dur: 26}]}>
        <Tap at={30} x={146} y={778} k={k} />
      </Device>
      <Sparkles at={38} x={540 - 120} y={1590} />
      <Device width={430} x={540 + 210 * second} y={1250 + (1 - second) * 300} ry={-18 * second} scale={0.8 + 0.2 * second} opacity={Math.min(1, second * 1.5)} screens={[{src: 'chat_answer'}]} zoom={[{at: 120, to: 400, scale: 1.55, cx: 195, cy: 610, dur: 30}]} />
      <Chip at={130} x={540} y={1790} out={dur - 18} text="Vestlus iga kaardi kohta" icon={<Icon d={I.spark} size={34} />} size={32} tone={C.peach} />
    </Scene>
  );
}, 200);

/* ============ 6. calendar + reminder ============ */
const Push: React.FC<{at: number; y: number}> = ({at, y}) => {
  const s = useSpring(at, {damping: 14, stiffness: 120});
  return (
    <div style={{position: 'absolute', left: 90, top: y - 260 * (1 - s), width: 900, opacity: Math.min(1, s * 1.6), transform: `scale(${0.9 + 0.1 * s})`, padding: '28px 32px', borderRadius: 44, display: 'flex', gap: 26, alignItems: 'center',
      background: 'linear-gradient(135deg, rgba(64,56,110,0.78), rgba(36,30,70,0.78))', border: '1.5px solid rgba(255,255,255,0.18)', boxShadow: '0 40px 90px rgba(0,0,0,0.55), 0 0 60px rgba(110,92,240,0.3)', backdropFilter: 'blur(26px)'}}>
      <div style={{flex: 'none', width: 104, height: 104, borderRadius: 26, background: 'linear-gradient(145deg,#2A2450,#14112A)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,0.12)'}}>
        <div style={{width: 52, height: 34, borderRadius: 10, background: C.ink, boxShadow: `inset -19px 0 0 ${C.violet}`}} />
      </div>
      <div style={{flex: 1, fontFamily: SANS, color: C.ink}}>
        <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 28, color: C.ink2, fontWeight: 500, letterSpacing: 1}}><span>CORPUS</span><span>nüüd</span></div>
        <div style={{fontSize: 38, fontWeight: 700, marginTop: 4, letterSpacing: -0.5}}>Kolju kontrolltöö</div>
        <div style={{fontSize: 34, fontWeight: 400, color: '#DCD7F2', marginTop: 2}}>3 päeva pärast. Uusi kaarte jäänud: 4.</div>
      </div>
    </div>
  );
};

add(({dur}) => {
  const f = useCurrentFrame();
  const enter = useSpring(0, {damping: 18, stiffness: 80});
  return (
    <Scene dur={dur}>
      <Background />
      <Eyebrow text="Kalender" at={2} top={150} out={dur - 22} />
      <Caption at={6} top={232} size={84} words={['Märgi', {t: 'kontrolltöö', accent: true}, {t: '\n'}, '— Corpus', 'teeb', 'plaani']} />
      <Device width={580} y={1250} ry={14 * (1 - enter) - 6 + 3 * Math.sin(f / 50)} rx={4} shine={30}
        screens={[{src: 'calendar'}]} zoom={[{at: 34, to: 400, scale: 1.35, cx: 195, cy: 610, dur: 30}]} />
      <Push at={78} y={560} />
    </Scene>
  );
}, 180);

/* ============ 7. «Did you know?» — the small things ============ */
const TipCard: React.FC<{at: number; len: number; children: React.ReactNode; title: string; icon: string | string[]; tone: string}> = ({at, len, children, title, icon, tone}) => {
  const f = useCurrentFrame();
  const t = f - at;
  if (t < -2 || t > len + 12) return null;
  const a = lerp(t, 0, 14, 0, 1);
  const b = lerp(t, len - 2, len + 10, 0, 1, easeInOut);
  return (
    <AbsoluteFill style={{opacity: a * (1 - b), transform: `translateX(${(1 - a) * 160 - b * 160}px)`, filter: a < 1 || b > 0 ? `blur(${(1 - a) * 10 + b * 10}px)` : undefined}}>
      {children}
      <div style={{position: 'absolute', top: 1680, width: 1080, display: 'flex', justifyContent: 'center'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 20, fontFamily: SANS, fontWeight: 700, fontSize: 60, letterSpacing: -1.6, color: C.ink}}>
          <span style={{color: tone, display: 'flex'}}><Icon d={icon} size={62} sw={2.2} /></span>{title}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SoundBars: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <div style={{position: 'absolute', top: 760, width: 1080, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 50}}>
      <div style={{width: 260, height: 260, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle, rgba(156,140,255,0.35), rgba(110,92,240,0.08))', boxShadow: `0 0 0 ${18 + 10 * Math.sin(f / 5)}px rgba(156,140,255,0.10), 0 0 0 ${44 + 16 * Math.sin(f / 5 + 1)}px rgba(156,140,255,0.06)`, color: C.ink}}>
        <Icon d={I.volume} size={130} sw={1.8} />
      </div>
      <div style={{display: 'flex', gap: 12, alignItems: 'center', height: 120}}>
        {new Array(22).fill(0).map((_, i) => {
          const h = 16 + Math.abs(Math.sin(f / 4 + i * 0.7) * Math.sin(f / 11 + i * 0.3)) * 100;
          return <div key={i} style={{width: 12, height: h, borderRadius: 6, background: `linear-gradient(${C.violet}, ${C.peach})`, opacity: 0.85}} />;
        })}
      </div>
      <div style={{fontFamily: SERIF, fontStyle: 'italic', fontWeight: 600, fontSize: 92, color: C.ink, textShadow: '0 0 40px rgba(156,140,255,0.5)'}}>Os zygomaticum</div>
    </div>
  );
};

add(({dur}) => {
  const f = useCurrentFrame();
  const L = 50, s0 = 34;
  const kk = useSpring(6, {damping: 12, stiffness: 140});
  return (
    <Scene dur={dur}>
      <Background />
      <div style={{position: 'absolute', left: 120, top: 150, transform: `scale(${kk})`}}><Kostik size={170} mood={Math.floor(f / 50) % 2 ? 'wink' : 'joy'} /></div>
      <Caption at={8} top={190} left={330} size={100} width={700} align="left" words={['Kas', {t: 'teadsid?', accent: true}]} />
      <div style={{position: 'absolute', top: 440, width: 1080, display: 'flex', justifyContent: 'center', gap: 16}}>
        {[0, 1, 2, 3, 4].map((i) => {
          const on = f >= s0 + i * L && f < s0 + (i + 1) * L;
          return <div key={i} style={{width: on ? 46 : 14, height: 14, borderRadius: 7, background: on ? C.violet : 'rgba(255,255,255,0.2)'}} />;
        })}
      </div>
      <TipCard at={s0} len={L} title="Ladina keel valjusti" icon={I.volume} tone={C.violet}><SoundBars /></TipCard>
      <TipCard at={s0 + L} len={L} title="Libista, et hinnata" icon={I.hand} tone={C.green}>
        <Device width={520} y={1100} ry={-6} screens={[{src: 'study_a'}]}>
          <Swipe at={s0 + L + 10} from={[190, 676]} to={[340, 676]} k={520 / 390} />
        </Device>
      </TipCard>
      <TipCard at={s0 + 2 * L} len={L} title="Tume · Hele · Paber" icon={I.palette} tone={C.peach}>
        <Device width={330} x={250} y={1100} ry={24} rz={-4} glow={0.5} screens={[{src: 'home_light'}]} />
        <Device width={330} x={830} y={1100} ry={-24} rz={4} glow={0.5} screens={[{src: 'home_paper'}]} />
        <Device width={370} x={540} y={1080} glow={0.8} screens={[{src: 'home'}]} />
      </TipCard>
      <TipCard at={s0 + 3 * L} len={L} title="Eesti · Русский · English" icon={I.globe} tone={C.teal}>
        <Device width={520} y={1100} ry={6} screens={[{src: 'settings'}]} zoom={[{at: s0 + 3 * L, to: 999, scale: 1.7, cx: 195, cy: 600, dur: 20}]} />
      </TipCard>
      <TipCard at={s0 + 4 * L} len={L - 4} title="Import Ankist" icon={I.import} tone={C.blue}>
        <AnkiFly at={s0 + 4 * L} />
      </TipCard>
    </Scene>
  );
}, 300);

const AnkiFly: React.FC<{at: number}> = ({at}) => {
  const f = useCurrentFrame();
  const p = lerp(f, at + 6, at + 34, 0, 1, easeInOut);
  return (
    <>
      <Device width={420} x={680} y={1100} ry={-14} screens={[{src: 'library'}]} />
      <div style={{position: 'absolute', left: 120 + 420 * p, top: 780 + 220 * p, width: 250, height: 300, borderRadius: 30, transform: `rotate(${-12 + 12 * p}deg) scale(${1 - 0.55 * p})`, opacity: 1 - lerp(f, at + 30, at + 38, 0, 1),
        background: 'linear-gradient(145deg, #3A5BA8, #24396E)', border: '1.5px solid rgba(255,255,255,0.25)', boxShadow: '0 30px 60px rgba(0,0,0,0.5), 0 0 50px rgba(143,180,245,0.4)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, fontFamily: SANS, color: '#fff'}}>
        <Icon d={I.import} size={90} sw={1.8} />
        <div style={{fontWeight: 700, fontSize: 48}}>.apkg</div>
      </div>
    </>
  );
};

/* ============ 8. share by QR ============ */
add(({dur}) => {
  const f = useCurrentFrame();
  const r = useSpring(64, {damping: 16, stiffness: 90});
  const beam = lerp(f, 50, 80, 0, 1, easeInOut);
  return (
    <Scene dur={dur}>
      <Background />
      <Eyebrow text="Jagamine" at={2} top={150} out={dur - 22} />
      <Caption at={6} top={232} size={88} words={['Jaga', 'pakki', {t: '\n'}, {t: 'QR-koodiga', accent: true}]} />
      <Device width={480} x={330} y={1240} ry={16} shine={20} screens={[{src: 'share_qr'}]} zoom={[{at: 18, to: 400, scale: 1.25, cx: 195, cy: 515, dur: 26}]} />
      <div style={{position: 'absolute', left: 520, top: 1180, width: 180 * beam, height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${C.violet}, ${C.peach})`, boxShadow: `0 0 30px 8px rgba(156,140,255,0.6)`, opacity: 1 - lerp(f, 100, 120, 0, 1)}} />
      {new Array(8).fill(0).map((_, i) => {
        const t = ((f - 50 - i * 5) / 28);
        if (t < 0 || t > 1 || f > 120) return null;
        return <div key={i} style={{position: 'absolute', left: 520 + 200 * t, top: 1183 + Math.sin(t * 9 + i) * 26, width: 10, height: 10, borderRadius: 5, background: '#fff', boxShadow: '0 0 16px 4px rgba(200,190,255,0.9)', transform: 'translate(-50%,-50%)'}} />;
      })}
      <Device width={400} x={800} y={1290 + (1 - r) * 160} ry={-18 * r} scale={0.75 + 0.25 * r} opacity={Math.min(1, r * 1.5)} screens={[{src: 'folder'}]} />
      <Chip at={96} x={540} y={1790} out={dur - 18} text="Fotod, raamid ja nimetused tulevad kaasa" size={30} icon={<Icon d={I.qr} size={34} />} />
    </Scene>
  );
}, 160);

/* ============ 9. outro ============ */
add(({dur}) => {
  const f = useCurrentFrame();
  const up = useSpring(4, {damping: 11, stiffness: 120});
  const end = lerp(f, dur - 26, dur, 0, 1);
  return (
    <Scene dur={dur} outFrames={2}>
      <Background />
      <div style={{position: 'absolute', left: 150, top: 1100 - 520 * up}}><Kostik size={320} mood="cap" /></div>
      <Bubble at={26} x={520} y={700} width={440} size={56} tail="left" text="Õpime koos!" />
      <Logo at={40} y={1060} size={170} />
      <Caption at={58} top={1290} size={54} weight={500} color={C.ink2} words={TAGLINE} />
      <AbsoluteFill style={{background: '#000', opacity: end}} />
    </Scene>
  );
}, 160);

export const Promo: React.FC = () => (
  <AbsoluteFill style={{background: C.bg}}>
    <Series>
      {SCENES.map(([Comp, d], i) => (
        <Series.Sequence key={i} durationInFrames={d} offset={i ? -OVERLAP : 0}>
          <Comp dur={d} />
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);

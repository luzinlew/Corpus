import React from 'react';
import {Composition, continueRender, delayRender} from 'remotion';
import '@fontsource/onest/400.css';
import '@fontsource/onest/500.css';
import '@fontsource/onest/600.css';
import '@fontsource/onest/700.css';
import '@fontsource/source-serif-4/500-italic.css';
import '@fontsource/source-serif-4/600-italic.css';
import {Promo, promoLength} from './Promo';

/* wait for the web fonts before the first frame is captured */
const fontsReady = delayRender('fonts');
Promise.all([
  document.fonts.load("700 80px 'Onest'"), document.fonts.load("500 40px 'Onest'"), document.fonts.load("600 40px 'Onest'"), document.fonts.load("400 40px 'Onest'"),
  document.fonts.load("italic 600 60px 'Source Serif 4'"), document.fonts.load("italic 500 60px 'Source Serif 4'"),
]).then(() => continueRender(fontsReady), () => continueRender(fontsReady));

export const Root: React.FC = () => (
  <Composition id="CorpusPromo" component={Promo} durationInFrames={promoLength()} fps={30} width={1080} height={1920} />
);

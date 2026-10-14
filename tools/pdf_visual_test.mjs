// Offline integration test: real vendored PDF.js + production Courses helpers.
// No browser, canvas, OCR, backend or AI. Optional PDF paths print regression metrics.
// --measure skips synthetic assertions; --worker/--source support before/after runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const take = flag => { const i = args.indexOf(flag); return i < 0 ? null : args.splice(i, 2)[1]; };
const worker = take('--worker') || path.join(root, 'vendor/pdfjs/pdf.worker.min.mjs');
const sourcePath = take('--source') || path.join(root, 'src/corpus.html');
const measure = args.includes('--measure');
if (measure) args.splice(args.indexOf('--measure'), 1);
const source = fs.readFileSync(sourcePath, 'utf8');
const between = (a, b) => {
  const i = source.indexOf(a), j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i); return source.slice(i, j);
};
const context = vm.createContext({
  CN_LIM: { items: 50000, pageChars: 60000 }, CN_KNOWLEDGE_VERSION: 1,
  cnTO: async p => p,
});
vm.runInContext(between('function cnExtractDiag(', '\n/* Exam questions') + '\n' +
  between('function cnKnowledgeHash(', '\nfunction cnOutClean') + '\n' +
  'globalThis.helpers={cnPageText,cnStorePage,cnPageHasVisual,cnKnowledgeVisuals,cnKnowledgeDocClean};', context);
const h = context.helpers;
const lib = await import(pathToFileURL(path.join(root, 'vendor/pdfjs/pdf.min.mjs')));
lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve(worker)).href;
const optionsMatch = source.match(/lib\.getDocument\(\{data:buf,([^}]+)\}\)/);
assert.ok(optionsMatch, 'test uses the extraction options actually used by cnRead');
const options = vm.runInNewContext('({' + optionsMatch[1] + '})');
assert.equal(options.maxImageSize, 1, 'keep the raster decoding guard');
let peakRss = process.memoryUsage().rss;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const timer = setInterval(sample, 5);
const clone = x => JSON.parse(JSON.stringify(x));

// Small, valid PDF structure, intentionally invalid raster bytes. An unsafe
// removal of the size guard would try decoding them; the guard must skip them.
function syntheticPdf(extraPages = 0, smallRaster = false) {
  const objects = [];
  const add = s => { objects.push(s); return objects.length; };
  const stream = (dict, body) => `<< ${dict} /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>');
  for (let i = 0; i < 4; i++) add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 7 0 R >> /XObject << /Im 8 0 R /Form 9 0 R /Mask 10 0 R >> >> /Contents ${11 + i} 0 R >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add(smallRaster ? stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', 'abcdefghijkl') : stream('/Type /XObject /Subtype /Image /Width 100000 /Height 100000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', 'invalid-pixels'));
  add(stream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /Im 8 0 R >> >>', '/Im Do'));
  add(stream('/Type /XObject /Subtype /Image /Width 200 /Height 200 /ImageMask true /BitsPerComponent 1', 'invalid-mask'));
  add(stream('', 'q 50 0 0 50 0 0 cm /Im Do Q')); // image only
  add(stream('', 'BT /F1 10 Tf 5 80 Td (A title is not an image caption) Tj ET /Form Do /Im Do /Mask Do'));
  add(stream('', 'BT /F1 10 Tf 5 80 Td (Plain text) Tj ET'));
  add(stream('', 'q BI /W 2 /H 2 /CS /RGB /BPC 8 ID abcdefghijkl EI Q')); // inline image
  const kids = [3, 4, 5, 6];
  for (let i = 0; i < extraPages; i++) kids.push(add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im 8 0 R >> >> /Contents 11 0 R >>'));
  objects[1] = `<< /Type /Pages /Kids [${kids.map(id => id + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

async function inspect(data, name, testOptions = {}) {
  const started = performance.now(), beforeRss = process.memoryUsage().rss;
  const task = lib.getDocument({ data, ...options, ...testOptions, verbosity: 0 });
  const doc = await task.promise, pages = [], markers = [], paintImages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n), result = await h.cnPageText(pg, task, lib.OPS);
      const operators = await pg.getOperatorList(); // cached; inspect metadata, no rendering
      operators.fnArray.forEach((f, i) => {
        if (f === lib.OPS.markPointProps && operators.argsArray[i]?.[0] === 'CorpusSkippedImageV1') {
          const info = operators.argsArray[i][1];
          assert.deepEqual(Object.keys(info).sort(), ['height', 'reason', 'width']);
          assert.equal(info.reason, 'maxImageSize'); markers.push({ page: n, ...info });
        }
        if ([lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintImageMaskXObject].includes(f)) paintImages.push(n);
      });
      pages.push(h.cnStorePage(n, result.text, result.em, result.diag));
      pg.cleanup(); sample();
    }
  } finally { await doc.destroy(); }
  const material = { id: 'test-material' }, units = h.cnKnowledgeVisuals(material, pages);
  assert.equal(new Set(units.map(u => u.id)).size, units.length);
  assert.deepEqual(clone(units), clone(h.cnKnowledgeVisuals(material, pages)), 'stable IDs');
  for (const u of units) {
    const ref = u.sources[0];
    assert.equal(ref.materialId, material.id);
    assert.equal(ref.blockId, 'visual:page:' + ref.page);
    assert.equal(pages[ref.page - 1].diag.visual, true);
    assert.equal(u.extractionStatus, 'unresolved'); assert.equal(u.content, null);
  }
  // Production splits sidecars into <=200 units; exercise the same storage bound.
  for (let offset = 0; offset < units.length; offset += 200) {
    const chunk = units.slice(offset, offset + 200);
    const stored = clone({ kind: 'course-knowledge', version: 1, materialId: material.id, units: chunk, outlineStatus: 'incomplete', sourceProcessingStatus: 'review_required' });
    assert.deepEqual(clone(h.cnKnowledgeDocClean(stored).units), clone(chunk), 'stored KU round-trip');
  }
  sample();
  const metrics = { name, pages: pages.length, textChars: pages.reduce((n, p) => n + p.text.length, 0),
    imagePages: pages.filter(p => p.diag.visual).map(p => p.n), visualUnits: units.length,
    skippedImageOccurrences: markers.length, paintedImageOccurrences: paintImages.length,
    seconds: +( (performance.now() - started) / 1000).toFixed(3),
    rssBeforeMiB: +(beforeRss / 1048576).toFixed(1), peakRssMiB: +(peakRss / 1048576).toFixed(1),
    processMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1) };
  console.log('PDF_METRICS ' + JSON.stringify(metrics));
  return { pages, units, markers, paintImages, metrics };
}

try {
  if (!measure) {
    const result = await inspect(syntheticPdf(), 'synthetic-universal');
    assert.deepEqual(result.metrics.imagePages, [1, 2, 4], 'image-only, nested Form/mask, inline images must be detected');
    assert.equal(result.pages[0].text, '');
    assert.equal(result.pages[0].diag.operatorUnknown, undefined);
    assert.equal(result.metrics.visualUnits, 3);
    assert.equal(result.markers.filter(m => m.width === 100000).length, 3, 'huge rasters are detected before any pixel decoding');
    assert.equal(result.paintImages.length, 0, 'skipped rasters create no paint operations or bitmap dependencies');
    assert.equal(result.metrics.skippedImageOccurrences, 5);
    for (const unit of result.units) assert.deepEqual(clone(unit.visualState), { detection: 'detected', caption: 'not_assessed', lessonUse: 'not_checked' });
    assert.ok(result.metrics.peakRssMiB < 512, 'tiny PDF with huge dimensions must not allocate the raster (30 GB)');
    const errorPage = await h.cnPageText({ getTextContent: async () => ({ items: [] }), getOperatorList: async () => { throw new Error('bad stream'); } }, null, lib.OPS);
    assert.equal(errorPage.diag.operatorUnknown, true, 'failed inspection stays unknown');
    const stress = await inspect(syntheticPdf(196), 'synthetic-200-pages-huge-rasters');
    assert.equal(stress.metrics.pages, 200);
    assert.equal(stress.metrics.visualUnits, 199);
    assert.equal(stress.metrics.paintedImageOccurrences, 0);
    assert.ok(stress.metrics.peakRssMiB < 512, 'page-by-page cleanup avoids retaining decoded huge rasters');
    const normal = await inspect(syntheticPdf(0, true), 'synthetic-normal-image-operators', { maxImageSize: -1 });
    assert.equal(normal.markers.length, 0, 'ordinary rendering options must not emit skipped-image markers');
    assert.ok(normal.paintImages.length > 0, 'ordinary images still have paint operators');
    assert.deepEqual(normal.metrics.imagePages, [1, 2, 4]);
    console.log('PDF VISUAL REGRESSION TESTS PASSED');
  }
  for (const name of args) await inspect(new Uint8Array(fs.readFileSync(name)), path.basename(name));
} finally { clearInterval(timer); }

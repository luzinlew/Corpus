# Corpus image-presence patch (PDF.js 4.10.38)

`buildPaintImageXObject` previously returned before emitting any operator when
an image exceeded `maxImageSize`. Courses deliberately uses `maxImageSize: 1`
to avoid decoding large rasters during text extraction.

In the existing `ignoreErrors` branch, before returning, the worker now emits
`OPS.markPointProps` (`ve` in this pinned minified build) with the tag
`CorpusSkippedImageV1` and `{width, height, reason: "maxImageSize"}`.
Marked points are non-painting operations. No pixels, bitmap, image dependency,
caption or new network request are produced. Image masks and images inside Form
XObjects pass through this same guard. Normal rendering with no image-size limit
does not enter this branch. The original size limit and warning remain intact.

Courses recognizes the marker only as a page-level raster-presence signal.
Caption extraction is not assessed by this signal; availability for lesson
rendering is not checked. Pure vector drawings are outside this detector.
One unresolved visual KnowledgeUnit represents an image-bearing page, not each
embedded image. The tag is diagnostic metadata, never trusted evidence of facts.

On vendor upgrades, reapply this patch to the equivalent pre-decode size guard,
check the operator constant, bump the worker URL revision in `cnPdfLib`, and run
`node tools/pdf_visual_test.mjs` and `node tools/course_logic_test.cjs`.
The synthetic test uses actual PDF.js, including an image-only page and a
100000 x 100000 raster with intentionally invalid encoded pixels. It must be
detected without decoding/allocating that raster. Restoring the upstream worker
must fail the test. A 200-page fixture checks repeated inspection and cleanup;
a separate small-raster fixture checks that unrestricted image paint operators
remain available. These are operator/extraction tests, not browser rendering E2E.

Memory remains proportional to the PDF, text/operator lists and small metadata,
not the dimensions of skipped rasters. This does not impose a general memory
cap on arbitrary PDF complexity; existing file/page/time limits still apply.

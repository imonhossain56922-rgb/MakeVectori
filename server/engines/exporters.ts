import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import sharp from 'sharp';
import type { ExportOptions, VectorDocument } from '../../src/types/vector.ts';
import { buildSvgFromDocument } from './vectorizer.ts';

interface PathSeg {
  type: 'M' | 'L' | 'C' | 'Z';
  nums: number[];
}

function parseSvgPathCommands(d: string): PathSeg[] {
  const tokens = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
  if (!tokens) return [];

  const segs: PathSeg[] = [];
  let i = 0;
  let cmd = 'M';
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MLCQZmlcqz]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        segs.push({ type: 'Z', nums: [] });
        curX = startX;
        curY = startY;
      }
      continue;
    }

    const nextNum = () => parseFloat(tokens[i++] || '0');
    const isRel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === 'M') {
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      curX = x;
      curY = y;
      startX = x;
      startY = y;
      segs.push({ type: 'M', nums: [x, y] });
      cmd = isRel ? 'l' : 'L';
    } else if (upper === 'L') {
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      curX = x;
      curY = y;
      segs.push({ type: 'L', nums: [x, y] });
    } else if (upper === 'C') {
      const x1 = nextNum() + (isRel ? curX : 0);
      const y1 = nextNum() + (isRel ? curY : 0);
      const x2 = nextNum() + (isRel ? curX : 0);
      const y2 = nextNum() + (isRel ? curY : 0);
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      curX = x;
      curY = y;
      segs.push({ type: 'C', nums: [x1, y1, x2, y2, x, y] });
    } else if (upper === 'Q') {
      const qx = nextNum() + (isRel ? curX : 0);
      const qy = nextNum() + (isRel ? curY : 0);
      const x = nextNum() + (isRel ? curX : 0);
      const y = nextNum() + (isRel ? curY : 0);
      const c1x = curX + (2 / 3) * (qx - curX);
      const c1y = curY + (2 / 3) * (qy - curY);
      const c2x = x + (2 / 3) * (qx - x);
      const c2y = y + (2 / 3) * (qy - y);
      curX = x;
      curY = y;
      segs.push({ type: 'C', nums: [c1x, c1y, c2x, c2y, x, y] });
    } else {
      i++;
    }
  }
  return segs;
}

function hexToRgbNorm(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16) / 255;
    const g = parseInt(clean[1] + clean[1], 16) / 255;
    const b = parseInt(clean[2] + clean[2], 16) / 255;
    return [r, g, b];
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16) / 255;
    const g = parseInt(clean.slice(2, 4), 16) / 255;
    const b = parseInt(clean.slice(4, 6), 16) / 255;
    return [r, g, b];
  }
  return [0, 0, 0];
}

function sampleCubicBezier(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  steps: number
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
    pts.push({ x, y });
  }
  return pts;
}

export async function exportVectorDocument(
  doc: VectorDocument,
  options: ExportOptions
): Promise<{ buffer: Buffer; mimeType: string; filenameExt: string }> {
  if (options.format === 'svg') {
    const svg = buildSvgFromDocument(doc, {
      svgVersion: options.svgVersion || '1.1',
      svgSizeMode: options.svgSizeMode || 'scalable',
      preserveLayers: options.preserveLayers !== false,
      illustratorCompat: !!options.illustratorCompat,
    });
    return {
      buffer: Buffer.from(svg, 'utf8'),
      mimeType: 'image/svg+xml',
      filenameExt: 'svg',
    };
  }

  if (options.format === 'pdf') {
    const fixedSvg = buildSvgFromDocument(doc, {
      svgVersion: '1.1',
      svgSizeMode: 'fixed',
      preserveLayers: true,
      illustratorCompat: true,
    });

    let pageW = doc.width;
    let pageH = doc.height;
    if (options.pdfPageSize === 'a4') {
      pageW = 595.28;
      pageH = 841.89;
    } else if (options.pdfPageSize === 'letter') {
      pageW = 612;
      pageH = 792;
    } else if (options.pdfPageSize === 'custom' && options.pdfWidth && options.pdfHeight) {
      pageW = Math.max(32, Math.min(10000, options.pdfWidth));
      pageH = Math.max(32, Math.min(10000, options.pdfHeight));
    }

    const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
      const pdf = new PDFDocument({
        size: [pageW, pageH],
        margin: 0,
        info: {
          Title: 'MakeVectorizer Vector Artwork',
          Creator: 'MakeVectorizer Studio',
        },
      });
      const chunks: Buffer[] = [];
      pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);

      SVGtoPDF(pdf, fixedSvg, 0, 0, {
        width: pageW,
        height: pageH,
        preserveAspectRatio: 'xMidYMid meet',
      });
      pdf.end();
    });

    return {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filenameExt: 'pdf',
    };
  }

  if (options.format === 'eps') {
    // Genuine PostScript Level 3 EPS vector file
    const w = Math.max(1, Math.round(doc.width));
    const h = Math.max(1, Math.round(doc.height));
    const lines: string[] = [
      '%!PS-Adobe-3.0 EPSF-3.0',
      `%%BoundingBox: 0 0 ${w} ${h}`,
      `%%HiResBoundingBox: 0.0 0.0 ${doc.width.toFixed(2)} ${doc.height.toFixed(2)}`,
      '%%Creator: MakeVectorizer Vector Engine',
      '%%LanguageLevel: 3',
      '%%Pages: 1',
      '%%EndComments',
      '%%BeginProlog',
      '%%EndProlog',
      '%%Page: 1 1',
      'gsave',
    ];

    if (doc.backgroundColor) {
      const [br, bg, bb] = hexToRgbNorm(doc.backgroundColor);
      lines.push(`${br.toFixed(4)} ${bg.toFixed(4)} ${bb.toFixed(4)} setrgbcolor`);
      lines.push(`0 0 ${w} ${h} rectfill`);
    }

    const fmt = (n: number) => n.toFixed(2);
    const psY = (y: number) => doc.height - y;

    for (const shape of doc.shapes) {
      if (!shape.visible) continue;
      const tx = shape.tx || 0;
      const ty = shape.ty || 0;
      const segs = parseSvgPathCommands(shape.pathData);
      if (segs.length === 0) continue;

      lines.push('newpath');
      for (const seg of segs) {
        if (seg.type === 'M') {
          lines.push(`${fmt(seg.nums[0] + tx)} ${fmt(psY(seg.nums[1] + ty))} moveto`);
        } else if (seg.type === 'L') {
          lines.push(`${fmt(seg.nums[0] + tx)} ${fmt(psY(seg.nums[1] + ty))} lineto`);
        } else if (seg.type === 'C') {
          lines.push(
            `${fmt(seg.nums[0] + tx)} ${fmt(psY(seg.nums[1] + ty))} ${fmt(seg.nums[2] + tx)} ${fmt(
              psY(seg.nums[3] + ty)
            )} ${fmt(seg.nums[4] + tx)} ${fmt(psY(seg.nums[5] + ty))} curveto`
          );
        } else if (seg.type === 'Z') {
          lines.push('closepath');
        }
      }

      if (shape.fill && shape.fill !== 'none') {
        const [r, g, b] = hexToRgbNorm(shape.fill);
        // Flatten unsupported alpha cleanly onto white for EPS 3 compatibility
        const op = shape.opacity ?? 1;
        const fr = 1 - op + op * r;
        const fg = 1 - op + op * g;
        const fb = 1 - op + op * b;
        lines.push(`${fr.toFixed(4)} ${fg.toFixed(4)} ${fb.toFixed(4)} setrgbcolor`);
        if (shape.stroke && shape.stroke !== 'none' && shape.strokeWidth > 0) {
          lines.push('gsave eofill grestore');
        } else {
          lines.push('eofill');
        }
      }

      if (shape.stroke && shape.stroke !== 'none' && shape.strokeWidth > 0) {
        const [sr, sg, sb] = hexToRgbNorm(shape.stroke);
        lines.push(`${sr.toFixed(4)} ${sg.toFixed(4)} ${sb.toFixed(4)} setrgbcolor`);
        lines.push(`${shape.strokeWidth.toFixed(2)} setlinewidth`);
        lines.push('1 setlinejoin 1 setlinecap stroke');
      }
    }

    lines.push('grestore', 'showpage', '%%Trailer', '%%EOF');

    return {
      buffer: Buffer.from(lines.join('\n'), 'ascii'),
      mimeType: 'application/postscript',
      filenameExt: 'eps',
    };
  }

  if (options.format === 'dxf') {
    // Genuine AutoCAD ASCII DXF (CAD & Laser Cutting / CNC compatible)
    const mode = options.dxfMode || 'lines-arcs-splines';
    const dxf: string[] = [
      '0',
      'SECTION',
      '2',
      'HEADER',
      '9',
      '$ACADVER',
      '1',
      'AC1015',
      '9',
      '$INSUNITS',
      '70',
      '4',
      '0',
      'ENDSEC',
      '0',
      'SECTION',
      '2',
      'ENTITIES',
    ];

    const dxfY = (y: number) => doc.height - y;
    const fmt = (n: number) => n.toFixed(3);

    for (const shape of doc.shapes) {
      if (!shape.visible) continue;
      const tx = shape.tx || 0;
      const ty = shape.ty || 0;
      const layer = shape.layerName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'VECTOR';
      const segs = parseSvgPathCommands(shape.pathData);

      let curX = 0;
      let curY = 0;
      let subStartX = 0;
      let subStartY = 0;
      let polyPts: Array<{ x: number; y: number }> = [];

      const flushPolyline = (closed: boolean) => {
        if (polyPts.length < 2) {
          polyPts = [];
          return;
        }
        if (mode === 'lines-only') {
          for (let i = 0; i < polyPts.length - 1; i++) {
            dxf.push(
              '0',
              'LINE',
              '8',
              layer,
              '10',
              fmt(polyPts[i].x),
              '20',
              fmt(dxfY(polyPts[i].y)),
              '30',
              '0.0',
              '11',
              fmt(polyPts[i + 1].x),
              '21',
              fmt(dxfY(polyPts[i + 1].y)),
              '31',
              '0.0'
            );
          }
          if (closed) {
            const first = polyPts[0];
            const last = polyPts[polyPts.length - 1];
            dxf.push(
              '0',
              'LINE',
              '8',
              layer,
              '10',
              fmt(last.x),
              '20',
              fmt(dxfY(last.y)),
              '30',
              '0.0',
              '11',
              fmt(first.x),
              '21',
              fmt(dxfY(first.y)),
              '31',
              '0.0'
            );
          }
        } else {
          dxf.push(
            '0',
            'LWPOLYLINE',
            '8',
            layer,
            '90',
            String(polyPts.length),
            '70',
            closed ? '1' : '0'
          );
          for (const pt of polyPts) {
            dxf.push('10', fmt(pt.x), '20', fmt(dxfY(pt.y)));
          }
        }
        polyPts = [];
      };

      for (const seg of segs) {
        if (seg.type === 'M') {
          flushPolyline(false);
          curX = seg.nums[0] + tx;
          curY = seg.nums[1] + ty;
          subStartX = curX;
          subStartY = curY;
          polyPts.push({ x: curX, y: curY });
        } else if (seg.type === 'L') {
          curX = seg.nums[0] + tx;
          curY = seg.nums[1] + ty;
          polyPts.push({ x: curX, y: curY });
        } else if (seg.type === 'C') {
          const x1 = seg.nums[0] + tx;
          const y1 = seg.nums[1] + ty;
          const x2 = seg.nums[2] + tx;
          const y2 = seg.nums[3] + ty;
          const x3 = seg.nums[4] + tx;
          const y3 = seg.nums[5] + ty;

          if (mode === 'lines-arcs-splines') {
            flushPolyline(false);
            // Emit genuine cubic SPLINE entity (degree 3, 4 control points, clamped knot vector)
            dxf.push(
              '0',
              'SPLINE',
              '8',
              layer,
              '70',
              '8',
              '71',
              '3',
              '72',
              '8',
              '73',
              '4',
              '74',
              '0',
              '40',
              '0.0',
              '40',
              '0.0',
              '40',
              '0.0',
              '40',
              '0.0',
              '40',
              '1.0',
              '40',
              '1.0',
              '40',
              '1.0',
              '40',
              '1.0',
              '10',
              fmt(curX),
              '20',
              fmt(dxfY(curY)),
              '30',
              '0.0',
              '10',
              fmt(x1),
              '20',
              fmt(dxfY(y1)),
              '30',
              '0.0',
              '10',
              fmt(x2),
              '20',
              fmt(dxfY(y2)),
              '30',
              '0.0',
              '10',
              fmt(x3),
              '20',
              fmt(dxfY(y3)),
              '30',
              '0.0'
            );
            curX = x3;
            curY = y3;
            polyPts.push({ x: curX, y: curY });
          } else {
            const steps = mode === 'lines-arcs' ? 10 : 6;
            const sampled = sampleCubicBezier(curX, curY, x1, y1, x2, y2, x3, y3, steps);
            polyPts.push(...sampled);
            curX = x3;
            curY = y3;
          }
        } else if (seg.type === 'Z') {
          flushPolyline(true);
          curX = subStartX;
          curY = subStartY;
        }
      }
      flushPolyline(false);
    }

    dxf.push('0', 'ENDSEC', '0', 'EOF');

    return {
      buffer: Buffer.from(dxf.join('\n'), 'ascii'),
      mimeType: 'application/dxf',
      filenameExt: 'dxf',
    };
  }

  // PNG raster export of the edited VectorDocument at 1X-4X or custom dimensions + DPI
  const scale = options.pngScale || 1;
  const outW = options.pngWidth
    ? Math.max(16, Math.min(12000, Math.round(options.pngWidth)))
    : Math.max(16, Math.min(12000, Math.round(doc.width * scale)));
  const outH = options.pngHeight
    ? Math.max(16, Math.min(12000, Math.round(options.pngHeight)))
    : Math.max(16, Math.min(12000, Math.round(doc.height * scale)));
  const dpi = Math.max(72, Math.min(600, Math.round(options.pngDpi || 300)));

  const fixedSvg = buildSvgFromDocument(doc, {
    svgVersion: '1.1',
    svgSizeMode: 'fixed',
    preserveLayers: true,
    illustratorCompat: false,
  });

  let img = sharp(Buffer.from(fixedSvg, 'utf8'), { density: dpi }).resize(outW, outH, {
    fit: 'contain',
    background: options.pngTransparent === false ? options.pngBackgroundColor || '#ffffff' : { r: 0, g: 0, b: 0, alpha: 0 },
  });

  if (options.pngTransparent === false) {
    img = img.flatten({ background: options.pngBackgroundColor || '#ffffff' });
  }

  const pngBuf = await img.withMetadata({ density: dpi }).png({ compressionLevel: 6 }).toBuffer();

  return {
    buffer: pngBuf,
    mimeType: 'image/png',
    filenameExt: 'png',
  };
}

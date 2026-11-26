import type { PaletteSwatch, VectorDocument, VectorShape } from '../types/vector.ts';

export function sanitizeSvgXml(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, 'blocked:')
    .replace(/data\s*:\s*text\/html/gi, 'blocked:');
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16) || 0,
      parseInt(clean[1] + clean[1], 16) || 0,
      parseInt(clean[2] + clean[2], 16) || 0,
    ];
  }
  if (clean.length === 6) {
    return [
      parseInt(clean.slice(0, 2), 16) || 0,
      parseInt(clean.slice(2, 4), 16) || 0,
      parseInt(clean.slice(4, 6), 16) || 0,
    ];
  }
  return [0, 0, 0];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
  );
}

export function rebuildPaletteFromShapes(shapes: VectorShape[]): PaletteSwatch[] {
  const map = new Map<string, { count: number; area: number }>();
  let totalArea = 0;

  for (const s of shapes) {
    if (!s.visible || !s.fill || s.fill === 'none') continue;
    const hex = s.fill.toLowerCase();
    const area = Math.max(1, s.bounds.width * s.bounds.height);
    totalArea += area;
    const cur = map.get(hex) || { count: 0, area: 0 };
    cur.count += 1;
    cur.area += area;
    map.set(hex, cur);
  }

  return Array.from(map.entries())
    .sort((a, b) => b[1].area - a[1].area)
    .map(([hex, info]) => ({
      hex,
      rgb: hexToRgb(hex),
      areaPercent: totalArea > 0 ? Number(((info.area / totalArea) * 100).toFixed(1)) : 0,
      shapeCount: info.count,
    }));
}

export function serializeDocumentToSvg(doc: VectorDocument): string {
  const bg = doc.backgroundColor
    ? `<rect x="0" y="0" width="${doc.width}" height="${doc.height}" fill="${doc.backgroundColor}" />`
    : '';

  const grouped = new Map<string, VectorShape[]>();
  for (const shape of doc.shapes) {
    if (!shape.visible) continue;
    const key = shape.groupId || 'layer_default';
    const arr = grouped.get(key) || [];
    arr.push(shape);
    grouped.set(key, arr);
  }

  const groupsXml: string[] = [];
  for (const [gKey, items] of grouped.entries()) {
    const inner = items
      .map((s) => {
        const transform = s.tx || s.ty ? ` transform="translate(${s.tx || 0} ${s.ty || 0})"` : '';
        const strokeAttr =
          s.stroke && s.stroke !== 'none' && s.strokeWidth > 0
            ? ` stroke="${s.stroke}" stroke-width="${s.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"`
            : '';
        const opAttr = s.opacity < 1 ? ` opacity="${s.opacity}"` : '';
        if (s.type === 'text' && s.textContent) {
          const escaped = s.textContent
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          const fam = (s.fontFamily || 'sans-serif').replace(/["<>]/g, '');
          const fSize = s.fontSize || 48;
          const fWeight = s.fontWeight || 600;
          const lSpace = s.letterSpacing ? ` letter-spacing="${s.letterSpacing}"` : '';
          return `    <text id="${s.id}" x="${s.bounds.x}" y="${s.bounds.y + fSize * 0.85}" font-family="${fam}, sans-serif" font-size="${fSize}" font-weight="${fWeight}"${lSpace} fill="${s.fill}"${strokeAttr}${opAttr}${transform}>${escaped}</text>`;
        }
        return `    <path id="${s.id}" d="${s.pathData}" fill="${s.fill}" fill-rule="evenodd"${strokeAttr}${opAttr}${transform} />`;
      })
      .join('\n');
    groupsXml.push(`  <g id="${gKey}">\n${inner}\n  </g>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="100%" height="100%" viewBox="${doc.viewBox}">\n${bg ? `  ${bg}\n` : ''}${groupsXml.join('\n')}\n</svg>`;
}

export function parseSvgStringToDocument(svgContent: string): VectorDocument {
  const clean = sanitizeSvgXml(svgContent);
  const parser = new DOMParser();
  const xml = parser.parseFromString(clean, 'image/svg+xml');
  const svgEl = xml.querySelector('svg');

  const viewBox = svgEl?.getAttribute('viewBox') || '0 0 800 800';
  const vbParts = viewBox.split(/[\s,]+/).map(Number);
  const width = vbParts[2] || Number(svgEl?.getAttribute('width')) || 800;
  const height = vbParts[3] || Number(svgEl?.getAttribute('height')) || 800;

  const graphicEls = Array.from(xml.querySelectorAll('path, text'));
  const shapes: VectorShape[] = graphicEls.map((el, idx) => {
    const tag = el.tagName.toLowerCase();
    const fill = el.getAttribute('fill') || '#0f172a';
    const stroke = el.getAttribute('stroke') || 'none';
    const strokeWidth = Number(el.getAttribute('stroke-width') || 0);
    const opacity = Number(el.getAttribute('opacity') || 1);
    const parentG = el.closest('g')?.getAttribute('id') || `layer_${fill.replace('#', '')}`;

    if (tag === 'text') {
      const textContent = el.textContent || 'Text';
      const fontSize = Number(el.getAttribute('font-size') || 48);
      const fontWeight = Number(el.getAttribute('font-weight') || 600);
      const letterSpacing = Number(el.getAttribute('letter-spacing') || 0);
      const rawFam = el.getAttribute('font-family') || 'Inter';
      const fontFamily = rawFam.split(',')[0].replace(/['"]/g, '').trim() || 'Inter';
      const x = Number(el.getAttribute('x') || 40);
      const baselineY = Number(el.getAttribute('y') || 80);
      const y = Math.max(0, baselineY - fontSize * 0.85);
      const approxWidth = Math.max(40, textContent.length * fontSize * 0.58);

      return {
        id: el.getAttribute('id') || `text_${idx + 1}`,
        groupId: parentG,
        layerName: `Text: ${textContent.slice(0, 24)}`,
        type: 'text',
        pathData: '',
        textContent,
        fontFamily,
        fontSize,
        fontWeight,
        letterSpacing,
        fill,
        stroke,
        strokeWidth,
        opacity,
        visible: true,
        locked: false,
        bounds: {
          x: Number(x.toFixed(1)),
          y: Number(y.toFixed(1)),
          width: Number(approxWidth.toFixed(1)),
          height: Number((fontSize * 1.2).toFixed(1)),
        },
        nodeCount: textContent.length,
      };
    }

    const d = el.getAttribute('d') || '';
    // Approximate bounding box from path coordinates
    const nums = d.match(/-?\d*\.?\d+/g)?.map(Number) || [0, 0];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < nums.length - 1; i += 2) {
      const x = nums[i];
      const y = nums[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = width;
      maxY = height;
    }

    return {
      id: el.getAttribute('id') || `shape_${idx + 1}`,
      groupId: parentG,
      layerName: `Layer ${fill.toUpperCase()}`,
      type: 'path',
      pathData: d,
      fill,
      stroke,
      strokeWidth,
      opacity,
      visible: true,
      locked: false,
      bounds: {
        x: Number(minX.toFixed(1)),
        y: Number(minY.toFixed(1)),
        width: Number(Math.max(1, maxX - minX).toFixed(1)),
        height: Number(Math.max(1, maxY - minY).toFixed(1)),
      },
      nodeCount: Math.max(3, Math.floor(nums.length / 2)),
    };
  });

  return {
    width,
    height,
    viewBox,
    backgroundColor: null,
    shapes,
    palette: rebuildPaletteFromShapes(shapes),
    metadata: {
      preset: 'logo',
      engine: 'Reopened SVG Vector Document',
      processingMs: 0,
      totalShapes: shapes.length,
      totalNodes: shapes.reduce((acc, s) => acc + s.nodeCount, 0),
    },
  };
}

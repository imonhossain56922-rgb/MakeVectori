declare module 'svg-to-pdfkit' {
  import type PDFKit from 'pdfkit';
  function SVGtoPDF(
    doc: PDFKit.PDFDocument,
    svg: string | SVGElement,
    x?: number,
    y?: number,
    options?: {
      width?: number;
      height?: number;
      preserveAspectRatio?: string;
      assumePt?: boolean;
      useCSS?: boolean;
    }
  ): void;
  export = SVGtoPDF;
}

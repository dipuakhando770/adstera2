declare module 'qrcode/lib/core/qrcode.js' {
  export function create(
    text: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' | 'low' | 'medium' | 'quartile' | 'high' }
  ): unknown;
  const QRCore: {
    create: typeof create;
  };
  export default QRCore;
}

declare module 'qrcode/lib/renderer/svg-tag.js' {
  export function render(
    qrData: unknown,
    options?: {
      width?: number;
      margin?: number;
      color?: { dark?: string; light?: string };
    }
  ): string;
  const SvgRenderer: {
    render: typeof render;
  };
  export default SvgRenderer;
}

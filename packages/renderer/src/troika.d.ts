declare module 'troika-three-text' {
  import { Color, Mesh, Material } from 'three';
  export interface TextRenderInfo {
    blockBounds: [number, number, number, number];
    caretPositions: Float32Array;
    glyphAtlasIndices: Float32Array;
  }
  export class Text extends Mesh {
    text: string; font: string; fontSize: number; color: string | number | Color;
    maxWidth: number; textAlign: 'left' | 'center' | 'right' | 'justify';
    anchorX: string | number; anchorY: string | number; lineHeight: string | number;
    whiteSpace: string; overflowWrap: string; fillOpacity: number;
    sdfGlyphSize: number;
    material: Material; textRenderInfo: TextRenderInfo | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }
  export function getCaretAtPoint(info: TextRenderInfo, x: number, y: number): { charIndex: number; x: number; y: number; height: number } | null;
  export function getSelectionRects(info: TextRenderInfo, start: number, end: number): { left: number; top: number; right: number; bottom: number }[];
  export function configureTextBuilder(options: { defaultFontURL?: string; unicodeFontsURL?: string }): void;
}

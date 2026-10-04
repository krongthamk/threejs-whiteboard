export type ElementType = 'rect' | 'ellipse' | 'sticky' | 'text' | 'stroke' | 'connector' | 'image';
export interface Point { x: number; y: number }
export interface Box extends Point { w: number; h: number }
export interface ElementStyle {
  stroke: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
  fontFamily: string;
  fontSize: number;
  color: string;
}
export type Binding = Point | { elementId: string; nx: number; ny: number; fallback: Point };
export interface TextProps { text: string; align: 'left' | 'center' | 'right'; autoSize: boolean }
export interface ShapeTextProps extends TextProps { autoSize: false; verticalAlign: 'top' | 'middle' | 'bottom' }
export interface StrokeProps { points: number[]; simplified: boolean }
export interface ConnectorProps { start: Binding; end: Binding; kind: 'straight' | 'elbow' | 'curve' }
export interface ImageProps { assetId: string; naturalW: number; naturalH: number }
export interface PropsByType {
  rect: Record<string, never> | ShapeTextProps;
  ellipse: Record<string, never> | ShapeTextProps;
  sticky: TextProps;
  text: TextProps;
  stroke: StrokeProps;
  connector: ConnectorProps;
  image: ImageProps;
}
export type ElementOf<T extends ElementType> = Box & {
  id: string;
  type: T;
  rotation: number;
  index: string;
  style: ElementStyle;
  props: PropsByType[T];
};
export type Element = { [T in ElementType]: ElementOf<T> }[ElementType];
export type ElementPatch<T extends ElementType = ElementType> = Partial<Box & {
  rotation: number;
  index: string;
  style: ElementStyle;
  props: PropsByType[T];
}>;
export type ElementInput<T extends ElementType> = Partial<Box & {
  id: string;
  rotation: number;
  index: string;
  style: Partial<ElementStyle>;
  props: PropsByType[T];
}>;

export const DEFAULT_STYLE: Readonly<ElementStyle> = Object.freeze({
  stroke: '#334155', fill: '#ffffff', strokeWidth: 2, opacity: 1,
  fontFamily: 'Inter', fontSize: 24, color: '#172033',
});

// Message text sizes for the Settings slider. Index 1 matches the original 13px bubble text.
export const FONT_SIZES = [11, 13, 15, 17, 20];
export const DEFAULT_FONT_SIZE_INDEX = 1;

export function messageFontStyle(settings) {
  const index = Number(settings?.fontSize);
  const px = FONT_SIZES[Number.isInteger(index) ? index : DEFAULT_FONT_SIZE_INDEX];
  return { "--msg-font-size": `${px ?? FONT_SIZES[DEFAULT_FONT_SIZE_INDEX]}px` };
}

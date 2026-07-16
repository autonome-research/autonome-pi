export const DEFAULT_DETAIL_VIEWPORT = 24;
export const FANOUT_PAGE_SIZE = 10;

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

export function detailViewportHeight(width, preferred = DEFAULT_DETAIL_VIEWPORT) {
  const safeWidth = Math.max(1, finiteInteger(width, 1));
  const maximum = Math.max(1, finiteInteger(preferred, DEFAULT_DETAIL_VIEWPORT));
  if (safeWidth <= 24) return Math.min(maximum, 12);
  if (safeWidth <= 40) return Math.min(maximum, 16);
  if (safeWidth <= 64) return Math.min(maximum, 20);
  return maximum;
}

export function clampWindowScroll(scroll, contentLength, viewportHeight) {
  const height = Math.max(1, finiteInteger(viewportHeight, 1));
  const length = Math.max(0, finiteInteger(contentLength));
  return Math.max(0, Math.min(finiteInteger(scroll), Math.max(0, length - height)));
}

export function windowLineRange(contentLength, viewportHeight, scroll = 0, selectedLine) {
  const height = Math.max(1, finiteInteger(viewportHeight, 1));
  const length = Math.max(0, finiteInteger(contentLength));
  let start = clampWindowScroll(scroll, length, height);
  if (Number.isFinite(selectedLine)) {
    const selected = Math.max(0, Math.min(finiteInteger(selectedLine), Math.max(0, length - 1)));
    if (selected < start) start = selected;
    else if (selected >= start + height) start = selected - height + 1;
  }
  start = clampWindowScroll(start, length, height);
  return { start, end: Math.min(length, start + height), height };
}

export function pageItems(items, page = 0, pageSize = FANOUT_PAGE_SIZE) {
  const values = Array.isArray(items) ? items : [];
  const size = Math.max(1, finiteInteger(pageSize, FANOUT_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(values.length / size));
  const currentPage = Math.max(0, Math.min(finiteInteger(page), pageCount - 1));
  const start = currentPage * size;
  return {
    items: values.slice(start, start + size),
    page: currentPage,
    pageCount,
    start,
    end: Math.min(values.length, start + size),
    total: values.length,
  };
}
